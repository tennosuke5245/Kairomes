import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ArtifactImportApproval,
  ImageImportResultSchema,
  type PanelImportResponse,
  type PanelSnapshot,
  VERSION,
  WorkspaceListSchema,
} from "@kairomes/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fixture } from "../../../tests/fixtures.ts";
import { onePixelPng, pngHeader } from "./__fixtures__/images.ts";
import type { ArtifactDownload } from "./artifact-imports.ts";
import { downloadOpenAIFile, type FileTransport } from "./openai-file-download.ts";
import { startWorkbench } from "./preview.ts";
import { createMcpServer, loadMcpResultWidget, loadWidget } from "./server.ts";
import { readWorkbenchConnection } from "./workbench-connection.ts";

const minimalHtml = "<html><head><!--KAIROMES_MODE--></head><body>Workbench</body></html>";
const extensionId = "a".repeat(32);
const extensionOrigin = `chrome-extension://${extensionId}`;
const main = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));

/** The exact published input schema: a top-level file object with four declared strings. */
const expectedInputSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    workspace_id: { type: "string", format: "uuid", pattern: expect.any(String) },
    request_id: {
      type: "string",
      format: "uuid",
      pattern: expect.any(String),
      description: expect.stringContaining("UUID"),
    },
    path: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
      description: expect.stringContaining("parent folder must already exist"),
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: expect.any(String),
    },
    file: {
      description: expect.stringContaining("omit it"),
      type: "object",
      properties: {
        download_url: { type: "string" },
        file_id: { type: "string" },
        mime_type: { type: "string" },
        file_name: { type: "string" },
      },
      required: ["download_url", "file_id"],
      additionalProperties: false,
    },
  },
  required: ["workspace_id", "request_id", "path", "summary"],
  additionalProperties: false,
};
const expectedMeta = {
  "openai/fileParams": ["file"],
  "openai/toolInvocation/invoking": "正在準備匯入圖片…",
  "openai/toolInvocation/invoked": "圖片匯入請求已建立",
};

type Descriptor = { inputSchema: unknown; _meta?: unknown; annotations?: unknown };
async function descriptor(client: Client) {
  const tools = (await client.listTools()).tools;
  const found = tools.find((tool) => tool.name === "image_import_request") as Descriptor;
  return { inputSchema: found.inputSchema, _meta: found._meta, annotations: found.annotations };
}

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.dispose();
});

test("image_import_request publishes the same file-parameter descriptor on every MCP path", async () => {
  const html = await loadWidget();
  const mcpResultHtml = await loadMcpResultWidget();
  if (!html || !mcpResultHtml) throw new Error("Run bun run build before tests");
  const seen: unknown[] = [];
  for (const server of [
    createMcpServer(f.registry, html, undefined, undefined, mcpResultHtml),
    createMcpServer(f.registry),
  ]) {
    const client = new Client({ name: "descriptor-memory", version: VERSION });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const found = await descriptor(client);
      expect(found.inputSchema).toEqual(expectedInputSchema);
      expect(found._meta).toEqual(expectedMeta);
      seen.push(found);
      expect(client.getInstructions()).toContain("image_import_request");
      expect(client.getInstructions()).not.toContain("currently unavailable");
    } finally {
      await client.close();
      await server.close();
    }
  }

  // The stdio service and the Tunnel attach relay list the identical descriptor.
  const app = await startWorkbench(f.registry, minimalHtml, 0);
  try {
    for (const args of [
      ["serve", "--data-dir", f.state],
      ["serve", "--attach", "--stdio", "--data-dir", f.state],
    ]) {
      const client = new Client({ name: "descriptor-stdio", version: VERSION });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [main, ...args],
        stderr: "pipe",
      });
      transport.stderr?.on("data", () => undefined);
      try {
        await client.connect(transport, { timeout: 7000 });
        seen.push(await descriptor(client));
      } finally {
        await client.close();
        await transport.close();
      }
    }
  } finally {
    await app.close();
  }
  expect(seen).toHaveLength(4);
  for (const item of seen) expect(item).toEqual(seen[0] as Descriptor);
}, 30000);

async function startPairedWorkbench(artifactDownload?: ArtifactDownload) {
  const app = await startWorkbench(f.registry, minimalHtml, 0, extensionId, { artifactDownload });
  const connection = await readWorkbenchConnection(f.state);
  const post = (route: string, token: string, body: unknown, origin = connection.origin) =>
    fetch(`${connection.origin}${route}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  /** Pairs one more side panel (for example a second browser profile) and returns its token. */
  const pair = async () => {
    const pairing = await (
      await post("/api/pairing/create", connection.adminToken, { extensionId })
    ).json();
    const code = new URLSearchParams(new URL(pairing.pairingUrl).hash.slice(1)).get("code");
    const panel = await (
      await post(
        "/api/panel/pair",
        "",
        { code, instanceId: connection.instanceId },
        extensionOrigin,
      )
    ).json();
    return panel.panelToken as string;
  };
  const panelToken = await pair();
  const client = new Client({ name: "image-import-http", version: VERSION });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${connection.origin}/api/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${connection.mcpToken}` } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError)
      return { error: JSON.parse((result.content as [{ text: string }])[0].text) };
    return { data: ImageImportResultSchema.parse(result.structuredContent) };
  };
  const panelPost = (route: string, body: unknown, token = panelToken, origin = extensionOrigin) =>
    post(route, token, body, origin);
  const snapshot = async () =>
    (await (await panelPost("/api/panel/approvals", { action: "list" })).json()) as PanelSnapshot;
  const item = async (id: string) =>
    (await snapshot()).imports?.find((value) => value.id === id) as ArtifactImportApproval;
  const upload = (
    id: string,
    body: BodyInit,
    options: {
      token?: string;
      origin?: string | null;
      type?: string;
      uploadId?: string | null;
    } = {},
  ) => {
    const headers: Record<string, string> = {
      "Content-Type": options.type ?? "image/png",
      Authorization: `Bearer ${options.token ?? panelToken}`,
    };
    if (options.origin !== null) headers.Origin = options.origin ?? extensionOrigin;
    if (options.uploadId !== null)
      headers["X-Kairomes-Upload-Id"] = options.uploadId ?? crypto.randomUUID();
    return fetch(`${connection.origin}/api/panel/imports/${id}/file`, {
      method: "POST",
      headers,
      body,
    });
  };
  const content = (
    id: string,
    token = panelToken,
    origin: string | null = extensionOrigin,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${connection.origin}/api/panel/imports/${id}/content`, {
      headers: {
        ...(origin === null ? {} : { Origin: origin }),
        Authorization: `Bearer ${token}`,
        ...extra,
      },
    });
  return {
    connection,
    panelToken,
    pair,
    client,
    call,
    post,
    panelPost,
    snapshot,
    item,
    upload,
    content,
    async close() {
      await client.close();
      await app.close();
    },
  };
}

test("an import without a file waits for the user's image; only the paired panel can supply, preview and approve it", async () => {
  await mkdir(path.join(f.root, "design/placeholders"), { recursive: true });
  const w = await startPairedWorkbench();
  try {
    const target = "design/placeholders/figure-default.png";
    const requested = await w.call("image_import_request", {
      workspace_id: f.workspace.id,
      request_id: crypto.randomUUID(),
      path: target,
      summary: "預設人物圖",
    });
    const started = requested.data?.image_import;
    if (!started) throw new Error(JSON.stringify(requested));
    expect(started.state).toBe("awaiting_file");
    expect(requested.data?.guidance).toContain("Kairomes side panel");
    for (const secret of [w.panelToken, w.connection.adminToken, "fingerprint", "upload_id"])
      expect(JSON.stringify(requested)).not.toContain(secret);

    const slot = await w.item(started.id);
    expect(slot).toMatchObject({
      state: "awaiting_file",
      delivery: "user_supplied",
      origin: "tool",
      workspace_name: "測試專案",
      path: target,
      summary: "預設人物圖",
      sha256_short: null,
      upload_id: null,
    });
    expect((await w.snapshot()).importHydration).toEqual({ hydrated: 0, omitted: 1, rejected: 0 });

    // Nothing but the paired panel, with its exact origin and token, may upload.
    const statuses = [
      (await w.upload(started.id, onePixelPng, { token: "" })).status,
      (await w.upload(started.id, onePixelPng, { token: "f".repeat(64) })).status,
      (await w.upload(started.id, onePixelPng, { token: w.connection.uiToken })).status,
      (await w.upload(started.id, onePixelPng, { token: w.connection.mcpToken })).status,
      (await w.upload(started.id, onePixelPng, { token: w.connection.adminToken })).status,
      (await w.upload(started.id, onePixelPng, { origin: w.connection.origin })).status,
      (await w.upload(started.id, onePixelPng, { origin: null })).status,
      (
        await w.upload(started.id, onePixelPng, {
          origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        })
      ).status,
      (await w.upload(started.id, onePixelPng, { type: "text/html" })).status,
      (await w.upload(started.id, onePixelPng, { type: "application/json" })).status,
      (await w.upload(started.id, onePixelPng, { uploadId: null })).status,
      (await w.upload(started.id, onePixelPng, { uploadId: "not-a-uuid" })).status,
      (await w.upload(crypto.randomUUID(), onePixelPng)).status,
    ];
    expect(statuses).toEqual([401, 401, 401, 401, 401, 403, 403, 403, 415, 415, 400, 400, 404]);
    expect(await w.item(started.id)).toMatchObject({ state: "awaiting_file", upload_id: null });
    expect((await w.content(started.id)).status).toBe(404);

    const uploadId = crypto.randomUUID();
    const accepted = await w.upload(started.id, onePixelPng, { uploadId });
    expect(accepted.status).toBe(200);
    const pending = ((await accepted.json()) as PanelImportResponse).import;
    expect(pending).toMatchObject({
      state: "pending",
      upload_id: uploadId,
      mime_type: "image/png",
      width: 1,
      height: 1,
      byte_size: onePixelPng.byteLength,
      sha256_short: pending.version?.slice(0, 12),
    });
    // An uncertain retry returns the same result; a different upload cannot replace it.
    const retried = await w.upload(started.id, pngHeader(2, 2), { uploadId });
    expect(((await retried.json()) as PanelImportResponse).import.version).toBe(pending.version);
    const replaced = await w.upload(started.id, pngHeader(2, 2));
    expect(replaced.status).toBe(409);
    expect(await replaced.json()).toMatchObject({ code: "IMPORT_NOT_AWAITING_FILE" });

    // The trusted preview returns the verified bytes only to the paired panel.
    const preview = await w.content(started.id);
    expect(preview.status).toBe(200);
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(onePixelPng);
    expect(preview.headers.get("content-type")).toBe("image/png");
    expect(preview.headers.get("cache-control")).toBe("no-store");
    expect(preview.headers.get("x-content-type-options")).toBe("nosniff");
    expect(preview.headers.get("content-disposition")).toStartWith(
      'inline; filename="figure-default.png"',
    );
    expect(preview.headers.get("access-control-allow-origin")).toBe(extensionOrigin);
    expect((await w.content(started.id, w.connection.uiToken)).status).toBe(401);
    expect((await w.content(started.id, w.connection.mcpToken)).status).toBe(401);
    expect((await w.content(started.id, w.panelToken, w.connection.origin)).status).toBe(403);
    // Chromium sends no Origin on a GET from the extension page (Sec-Fetch-Site: none); the
    // panel token still decides. A same-origin page (the workbench) is refused, and so is any
    // other token or a foreign Origin.
    expect(
      (await w.content(started.id, w.panelToken, null, { "Sec-Fetch-Site": "none" })).status,
    ).toBe(200);
    expect((await w.content(started.id, w.panelToken, null)).status).toBe(200);
    for (const site of ["same-origin", "same-site", "cross-site"])
      expect(
        (await w.content(started.id, w.panelToken, null, { "Sec-Fetch-Site": site })).status,
        site,
      ).toBe(403);
    expect((await w.content(started.id, w.connection.uiToken, null)).status).toBe(401);
    expect(
      (
        await w.content(
          started.id,
          w.panelToken,
          "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
      ).status,
    ).toBe(403);
    expect((await w.content(crypto.randomUUID())).status).toBe(404);
    const postContent = await fetch(
      `${w.connection.origin}/api/panel/imports/${started.id}/content`,
      {
        method: "POST",
        headers: { Origin: extensionOrigin, Authorization: `Bearer ${w.panelToken}` },
      },
    );
    expect(postContent.status).toBe(405);
    // Only the GET read may come without an Origin.
    const originlessPost = await fetch(
      `${w.connection.origin}/api/panel/imports/${started.id}/content`,
      { method: "POST", headers: { Authorization: `Bearer ${w.panelToken}` } },
    );
    expect(originlessPost.status).toBe(403);
    // The workbench iframe route cannot read pending bytes.
    expect(
      (
        await w.post("/api/artifacts/content", w.connection.uiToken, {
          workspace_id: f.workspace.id,
          path: target,
          version: pending.version,
        })
      ).status,
    ).toBe(400);

    const polled = await w.call("image_import_poll", { import_id: started.id });
    expect(polled.data?.image_import).toMatchObject({ state: "pending", version: pending.version });
    expect(JSON.stringify(polled)).not.toContain(pending.fingerprint);

    // A decision needs the panel token and the fingerprint of the verified content.
    const decide = (fingerprint: string, token = w.panelToken) =>
      w.panelPost(
        "/api/panel/approvals",
        { action: "approve", import_id: started.id, fingerprint },
        token,
      );
    for (const token of [w.connection.uiToken, w.connection.mcpToken, w.connection.adminToken])
      expect((await decide(pending.fingerprint, token)).status).toBe(401);
    const stale = await decide(slot.fingerprint);
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ code: "APPROVAL_MISMATCH" });
    expect(await Bun.file(path.join(f.root, target)).exists()).toBe(false);
    expect((await decide(pending.fingerprint)).status).toBe(200);
    expect(await readFile(path.join(f.root, target))).toEqual(onePixelPng);

    const applied = await w.call("image_import_poll", { import_id: started.id });
    expect(applied.data?.image_import).toMatchObject({
      state: "applied",
      write_outcome: "written_verified",
      artifact: { path: target, version: pending.version },
    });
    // Approved bytes are released; the preview is gone and a lost-response retry writes nothing.
    expect((await w.content(started.id)).status).toBe(404);
    expect((await decide(pending.fingerprint)).status).toBe(400);
    expect(await w.item(started.id)).toMatchObject({
      state: "applied",
      write_outcome: "written_verified",
    });
  } finally {
    await w.close();
  }
}, 20000);

test("the side panel starts its own import and every import route keeps the trusted boundary", async () => {
  const w = await startPairedWorkbench();
  try {
    const requestId = crypto.randomUUID();
    const body = { workspace_id: f.workspace.id, request_id: requestId, path: "panel.png" };
    for (const [token, origin, status] of [
      [w.connection.mcpToken, extensionOrigin, 401],
      [w.connection.uiToken, extensionOrigin, 401],
      [w.connection.adminToken, extensionOrigin, 401],
      [w.panelToken, w.connection.origin, 403],
    ] as const)
      expect((await w.panelPost("/api/panel/imports", body, token, origin)).status).toBe(status);
    const created = await w.panelPost("/api/panel/imports", body);
    expect(created.status).toBe(200);
    const slot = ((await created.json()) as PanelImportResponse).import;
    expect(slot).toMatchObject({
      state: "awaiting_file",
      delivery: "user_supplied",
      origin: "panel",
      path: "panel.png",
    });
    const again = await w.panelPost("/api/panel/imports", body);
    expect(((await again.json()) as PanelImportResponse).import.id).toBe(slot.id);
    const reused = await w.panelPost("/api/panel/imports", { ...body, path: "other.png" });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: "REQUEST_ID_REUSED" });
    const missing = await w.panelPost("/api/panel/imports", {
      ...body,
      request_id: crypto.randomUUID(),
      path: "missing/panel.png",
    });
    expect(await missing.json()).toMatchObject({ code: "PARENT_NOT_FOUND" });
    // The same request_id from MCP is a different identity namespace.
    const fromModel = await w.call("image_import_request", {
      workspace_id: f.workspace.id,
      request_id: requestId,
      path: "model.png",
      summary: "模型的請求",
    });
    expect(fromModel.data?.image_import.state).toBe("awaiting_file");

    // Preflight allows only each route's own method and headers.
    const preflight = (route: string, method: string, headers: string) =>
      fetch(`${w.connection.origin}${route}`, {
        method: "OPTIONS",
        headers: {
          Origin: extensionOrigin,
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": headers,
        },
      });
    const fileRoute = `/api/panel/imports/${slot.id}/file`;
    const contentRoute = `/api/panel/imports/${slot.id}/content`;
    const allowed = await preflight(
      fileRoute,
      "POST",
      "authorization,content-type,x-kairomes-upload-id",
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-headers")).toContain("X-Kairomes-Upload-Id");
    expect((await preflight(contentRoute, "GET", "authorization")).status).toBe(204);
    expect((await preflight(contentRoute, "POST", "authorization")).status).toBe(403);
    expect((await preflight(fileRoute, "POST", "authorization,x-other")).status).toBe(403);
    expect((await preflight("/api/panel/imports", "POST", "x-kairomes-upload-id")).status).toBe(
      403,
    );

    expect((await w.upload(slot.id, onePixelPng)).status).toBe(200);
    const pending = await w.item(slot.id);
    // The panel reads the bytes it shows before approving them.
    expect((await w.content(slot.id)).status).toBe(200);
    expect(
      (
        await w.panelPost("/api/panel/approvals", {
          action: "approve",
          import_id: slot.id,
          fingerprint: pending.fingerprint,
        })
      ).status,
    ).toBe(200);
    expect(await readFile(path.join(f.root, "panel.png"))).toEqual(onePixelPng);

    // Every route but the upload keeps the small JSON body cap, chunked bodies included.
    const large = await w.panelPost("/api/panel/approvals", {
      action: "list",
      pad: "x".repeat(400_000),
    });
    expect(large.status).toBe(413);
    const chunked = await fetch(`${w.connection.origin}/api/panel/approvals`, {
      method: "POST",
      headers: {
        Origin: extensionOrigin,
        "Content-Type": "application/json",
        Authorization: `Bearer ${w.panelToken}`,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"action":"list"}'));
          controller.close();
        },
      }),
    });
    expect(chunked.status).toBe(411);
  } finally {
    await w.close();
  }
}, 20000);

test("a host file still waits for individual approval under full autonomy", async () => {
  const transport: FileTransport = async () =>
    new Response(onePixelPng, { status: 200, headers: { "Content-Type": "image/png" } });
  const lookups: string[] = [];
  const w = await startPairedWorkbench((reference, { signal }) =>
    downloadOpenAIFile(reference, {
      signal,
      transport,
      lookup: async (hostname) => {
        lookups.push(hostname);
        return [{ address: "93.184.216.34", family: 4 }];
      },
    }),
  );
  try {
    const grant = await w.panelPost("/api/panel/access", {
      action: "enable",
      workspace_id: f.workspace.id,
      level: "full",
      minutes: null,
    });
    expect(grant.status).toBe(200);
    const listed = await w.client.callTool({ name: "workspace_list", arguments: {} });
    expect(WorkspaceListSchema.parse(listed.structuredContent).workspaces[0]?.approval?.mode).toBe(
      "full",
    );

    const file = {
      download_url: "https://files.oaiusercontent.com/file-fixture/raw?sig=fixture",
      file_id: "file-fixture",
      mime_type: "image/png",
      file_name: "figure-default.png",
    };
    const requestId = crypto.randomUUID();
    const requested = await w.call("image_import_request", {
      workspace_id: f.workspace.id,
      request_id: requestId,
      path: "figure.png",
      summary: "ChatGPT 產生的圖",
      file,
    });
    const id = requested.data?.image_import.id as string;
    expect(requested.data?.image_import.state).toBe("preparing");
    let pending = await w.item(id);
    const deadline = Date.now() + 3000;
    while (pending.state === "preparing" && Date.now() < deadline) {
      await Bun.sleep(10);
      pending = await w.item(id);
    }
    expect(pending).toMatchObject({
      state: "pending",
      delivery: "host_file",
      source_file_name: "figure-default.png",
      width: 1,
      height: 1,
    });
    expect(JSON.stringify(await w.snapshot())).not.toContain("sig=fixture");
    expect(lookups).toEqual(["files.oaiusercontent.com"]);
    // Full autonomy never approves an import.
    await Bun.sleep(300);
    expect((await w.item(id)).state).toBe("pending");
    expect(await Bun.file(path.join(f.root, "figure.png")).exists()).toBe(false);

    // A duplicate host call with a refreshed URL returns the same import.
    const duplicate = await w.call("image_import_request", {
      workspace_id: f.workspace.id,
      request_id: requestId,
      path: "figure.png",
      summary: "ChatGPT 產生的圖",
      file: { ...file, download_url: "https://files.oaiusercontent.com/file-fixture/raw?sig=new" },
    });
    expect(duplicate.data?.image_import.id).toBe(id);
    expect(lookups).toHaveLength(1);

    const rejected = await w.call("image_import_request", {
      workspace_id: f.workspace.id,
      request_id: crypto.randomUUID(),
      path: "other.png",
      summary: "任意網址",
      file: { download_url: "https://attacker.example/image.png", file_id: "file-x" },
    });
    expect(rejected.error).toMatchObject({ code: "IMPORT_SOURCE_REJECTED" });
    const stringFile = await w.client
      .callTool({
        name: "image_import_request",
        arguments: {
          workspace_id: f.workspace.id,
          request_id: crypto.randomUUID(),
          path: "string.png",
          summary: "字串",
          file: "/mnt/data/figure.png",
        },
      })
      .catch((error: unknown) => ({ isError: true, error }));
    expect(stringFile.isError).toBe(true);
    expect((await w.snapshot()).importHydration).toEqual({ hydrated: 2, omitted: 0, rejected: 1 });
    expect((await w.snapshot()).imports).toHaveLength(1);

    expect((await w.content(id)).status).toBe(200);
    expect(
      (
        await w.panelPost("/api/panel/approvals", {
          action: "approve",
          import_id: id,
          fingerprint: pending.fingerprint,
        })
      ).status,
    ).toBe(200);
    expect(await readFile(path.join(f.root, "figure.png"))).toEqual(onePixelPng);
  } finally {
    await w.close();
  }
}, 20000);

test("an approval over HTTP needs this pairing's own preview of the exact pending bytes", async () => {
  const w = await startPairedWorkbench();
  try {
    const requested = await w.call("image_import_request", {
      workspace_id: f.workspace.id,
      request_id: crypto.randomUUID(),
      path: "reviewed.png",
      summary: "需要預覽的圖",
    });
    const id = requested.data?.image_import.id as string;
    expect((await w.upload(id, onePixelPng)).status).toBe(200);
    const pending = await w.item(id);
    const approve = (token = w.panelToken) =>
      w.panelPost(
        "/api/panel/approvals",
        { action: "approve", import_id: id, fingerprint: pending.fingerprint },
        token,
      );
    const refused = async (token?: string) => {
      const response = await approve(token);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "IMPORT_PREVIEW_REQUIRED" });
    };

    // The snapshot's fingerprint and metadata alone never approve the image.
    await refused();
    // Rejected reads (wrong token or origin) do not count as a preview.
    for (const token of [w.connection.uiToken, w.connection.mcpToken, w.connection.adminToken])
      expect((await w.content(id, token)).status).toBe(401);
    expect((await w.content(id, w.panelToken, w.connection.origin)).status).toBe(403);
    await refused();
    // Another paired panel's preview does not let this panel approve, nor the reverse.
    const other = await w.pair();
    expect((await w.content(id, other)).status).toBe(200);
    await refused();
    expect(await Bun.file(path.join(f.root, "reviewed.png")).exists()).toBe(false);
    expect(await w.item(id)).toMatchObject({ state: "pending", fingerprint: pending.fingerprint });

    const preview = await w.content(id);
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(onePixelPng);
    expect((await approve()).status).toBe(200);
    expect(await readFile(path.join(f.root, "reviewed.png"))).toEqual(onePixelPng);
    expect((await w.call("image_import_poll", { import_id: id })).data?.image_import).toMatchObject(
      {
        state: "applied",
        write_outcome: "written_verified",
      },
    );
  } finally {
    await w.close();
  }
}, 20000);
