import { mcpAddFingerprint } from "../apps/extension/src/mcp-mutation.ts";
import type {
  CommandApproval,
  McpAuthResult,
  McpPanelState,
  PanelSnapshot,
} from "../packages/protocol/src/index.ts";
import { McpAuthInputSchema } from "../packages/protocol/src/index.ts";
import { createSyntheticImports, syntheticImport } from "./import-fixture.ts";

// Runs the actual sidepanel coordinator with synthetic fetch/stream/Chrome boundaries.
// No network POST, actual credential, process, workspace or pairing is used.
const workspaceId = "00000000-0000-4000-8000-000000000010";
const streamControllers = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>();
const encoder = new TextEncoder();
let online = true;
let authorized = true;
let loseNextResponse = false;
let nextId = 1;
const counts = {
  mutations: 0,
  lists: 0,
  streams: 0,
  authStarts: 0,
  authQueries: 0,
  authCancels: 0,
  authForgets: 0,
};
const snapshot: PanelSnapshot = {
  instanceId: "00000000-0000-4000-8000-000000000050",
  workspaces: [{ id: workspaceId, name: "協調流程測試專案" }],
  sessions: [],
  changes: [],
  imports: [],
  commands: [],
  accessGrants: [],
};
let catalog: McpPanelState = { catalog_revision: "fixture", servers: [] };
// Image imports run through the same memory-only stand-in as the approval preview.
const imports = createSyntheticImports({
  workspaces: [
    {
      id: workspaceId,
      name: "協調流程測試專案",
      folders: ["", "images", "design", "design/placeholders"],
      existing: ["images/logo.png"],
    },
  ],
  changed: () => emit(),
});
const frame = (): PanelSnapshot => ({ ...snapshot, imports: imports.list() });
imports.setSnapshot(frame);
let importSeq = 0;
async function modelImport() {
  importSeq++;
  await imports.seed(
    syntheticImport(
      {
        id: `${String(importSeq).padStart(8, "0")}-0000-4000-8000-0000000000bb`,
        workspace: { id: workspaceId, name: "協調流程測試專案" },
        now: Date.now(),
      },
      {
        path:
          importSeq === 1
            ? "design/placeholders/figure-default.png"
            : `images/figure-${importSeq}.png`,
        created_at: Date.now(),
        expires_at: Date.now() + 10 * 60_000,
      },
    ),
  );
}
const fixtureOptions = new URLSearchParams(location.search);
const oauthServerId = "00000000-0000-4000-8000-000000000042";
const oauthName = fixtureOptions.has("oauth-long")
  ? `${"合成遠端服務".repeat(13)}合成`
  : "合成遠端 MCP";
const oauthDomain = fixtureOptions.has("oauth-long")
  ? `${"synthetic-login-long-name".repeat(2)}.${"public-auth-domain".repeat(3)}.example.test`
  : "login.example.test";
const authReceipts = new Map<string, McpAuthResult>();
const authAdmissions = new Map<string, string>();
let lastLogin: string | undefined;
let loseAuthResponse = fixtureOptions.has("auth-lost");
let browserFails = fixtureOptions.has("auth-browser-failed");
const syntheticTools = (serverId: string, name: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    ref: `synthetic-${serverId}-${i}`,
    server_id: serverId,
    server_name: name,
    name: `synthetic_tool_${i + 1}`,
    enabled: true,
    availability: "ready" as const,
    schema_fingerprint: `synthetic-schema-${i}`,
    read_only_hint: true,
    destructive_hint: false,
    open_world_hint: false,
  }));
if (fixtureOptions.has("oauth")) {
  catalog = {
    catalog_revision: "synthetic-oauth-initial",
    servers: [
      {
        id: "00000000-0000-4000-8000-000000000041",
        name: "Chrome DevTools",
        transport: "stdio",
        config_fingerprint: "1".repeat(64),
        enabled: true,
        state: "ready",
        tools: syntheticTools("00000000-0000-4000-8000-000000000041", "Chrome DevTools", 30),
      },
      {
        id: oauthServerId,
        name: oauthName,
        transport: "http",
        config_fingerprint: "2".repeat(64),
        enabled: true,
        state: "unavailable",
        tools: [],
        auth: {
          auth_phase: fixtureOptions.has("oauth-tools-error") ? "authenticated" : "required",
          tools_status: fixtureOptions.has("oauth-tools-error") ? "error" : "unknown",
          phase_version: 0,
          error_code: fixtureOptions.has("oauth-tools-error") ? "schema_limit" : "auth_required",
          login_domain: oauthDomain,
        },
      },
    ],
  };
}
const oauthServer = () => catalog.servers.find((server) => server.id === oauthServerId);
function oauthPhase(
  auth_phase: McpAuthResult["auth_phase"],
  tools_status: McpAuthResult["tools_status"],
  error_code?: string,
) {
  const server = oauthServer();
  if (!server?.auth) return;
  server.auth = {
    auth_phase,
    tools_status,
    phase_version: server.auth.phase_version + 1,
    login_domain: oauthDomain,
    ...(error_code ? { error_code } : {}),
  };
  server.state =
    auth_phase === "authenticated" && tools_status === "current" ? "ready" : "unavailable";
  catalog.catalog_revision = `synthetic-auth-${server.auth.phase_version}`;
}
if (fixtureOptions.has("oauth")) {
  const controls = document.querySelector("#synthetic-panel-controls details");
  for (const [action, text] of [
    ["oauth-complete", "登入完成"],
    ["oauth-expire", "登入逾時"],
    ["oauth-tools-error", "工具清單失敗"],
    ["oauth-lost", "遺失登入回覆"],
    ["oauth-relogin", "需要重新登入"],
  ] as const) {
    const button = document.createElement("button");
    button.dataset.fixtureAction = action;
    button.textContent = text;
    controls?.append(button);
  }
}
let holdNextAdd = fixtureOptions.has("pending");
let stagedCatalog: McpPanelState | undefined;
function command(): CommandApproval {
  const id = `${String(nextId++).padStart(8, "0")}-0000-4000-8000-000000000001`;
  return {
    id,
    request_id: id,
    workspace_id: workspaceId,
    workspace_name: "協調流程測試專案",
    cwd: "",
    absolute_cwd: "C:\\Synthetic-Kairomes\\project",
    executable: "C:\\Synthetic-Kairomes\\tool.exe",
    argv: ["synthetic-tool", "check"],
    timeout_ms: 120000,
    state: "pending",
    created_at: Date.now(),
    started_at: null,
    ended_at: null,
    expires_at: Date.now() + 300000,
    exit_code: null,
    signal: null,
    message: null,
    fingerprint: "1".repeat(64),
  };
}
if (!fixtureOptions.has("idle")) snapshot.commands?.push(command());
// ?import: ChatGPT asked to save an image but did not hand it over (awaiting_file).
if (fixtureOptions.has("import")) await modelImport();
const probe = document.querySelector<HTMLOutputElement>("#fixture-probe");
function observe() {
  if (probe)
    probe.textContent = `變更 ${counts.mutations} · 唯讀查詢 ${counts.lists} · 串流 ${counts.streams}${fixtureOptions.has("oauth") ? ` · 登入 ${counts.authStarts} · 登入查詢 ${counts.authQueries} · 取消 ${counts.authCancels} · 清除 ${counts.authForgets}` : ""}`;
}
function emit() {
  const payload = encoder.encode(`event: snapshot\ndata: ${JSON.stringify(frame())}\n\n`);
  for (const controller of streamControllers.keys()) controller.enqueue(payload);
  observe();
}
function dropStreams() {
  for (const [controller, cleanup] of streamControllers) {
    cleanup();
    controller.error(new Error("Synthetic stream loss"));
  }
}
const fixtureFetch = async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  const target = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (target.origin !== location.origin || !target.pathname.startsWith("/api/panel/"))
    throw new Error("Synthetic fixture blocks real fetch");
  if (!online) throw new TypeError("Synthetic offline");
  if (!authorized) return Response.json({ message: "合成測試：配對已失效。" }, { status: 401 });
  // Binary image routes first: their bodies are not JSON.
  const imported = await imports.handle(new Request(target, init));
  if (imported) return imported;
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  const route = target.pathname.split("/").at(-1);
  if (route === "mcp-auth") {
    const parsed = McpAuthInputSchema.safeParse(body);
    const server = oauthServer();
    if (!parsed.success || !server?.auth) return Response.json({}, { status: 400 });
    const request = parsed.data;
    if (
      request.instance_id !== snapshot.instanceId ||
      request.server_id !== server.id ||
      request.config_fingerprint !== server.config_fingerprint
    )
      return Response.json({}, { status: 409 });
    let receipt = authReceipts.get(request.operation_id);
    if (request.action === "status") {
      counts.authQueries++;
      observe();
      if (receipt && receipt.operation !== request.operation)
        return Response.json({}, { status: 409 });
      return Response.json({
        instance_id: request.instance_id,
        server_id: request.server_id,
        config_fingerprint: request.config_fingerprint,
        operation_id: request.operation_id,
        operation: request.operation,
        receipt_outcome: fixtureOptions.has("auth-missing")
          ? "missing"
          : (receipt?.receipt_outcome ?? "missing"),
        ...server.auth,
      });
    }
    if (request.action === "cancel") {
      counts.authCancels++;
      if (
        receipt?.operation !== "login" ||
        authAdmissions.get(request.operation_id) !== JSON.stringify({ ...request, action: "start" })
      )
        return Response.json({}, { status: 409 });
      if (fixtureOptions.has("auth-cancel-pending"))
        throw new TypeError("Synthetic lost cancel before completion");
      if (receipt.receipt_outcome === "pending") {
        oauthPhase("required", "unknown", "auth_cancelled");
        receipt = { ...receipt, ...server.auth, receipt_outcome: "cancelled" };
        authReceipts.set(request.operation_id, receipt);
      }
    } else if (receipt && authAdmissions.get(request.operation_id) !== JSON.stringify(request)) {
      return Response.json({}, { status: 409 });
    } else if (!receipt) {
      if (Date.parse(request.accept_before) < Date.now() || authReceipts.size >= 64)
        return Response.json({}, { status: 409 });
      if (request.action === "start") {
        counts.authStarts++;
        lastLogin = request.operation_id;
        oauthPhase(
          browserFails ? "error" : "waiting",
          "unknown",
          browserFails ? "browser_open_failed" : undefined,
        );
        receipt = {
          ...server.auth,
          instance_id: request.instance_id,
          server_id: request.server_id,
          config_fingerprint: request.config_fingerprint,
          operation: "login",
          operation_id: request.operation_id,
          receipt_outcome: browserFails ? "failed" : "pending",
        };
        browserFails = false;
      } else {
        counts.authForgets++;
        for (const [id, old] of authReceipts)
          if (old.receipt_outcome === "pending")
            authReceipts.set(id, { ...old, receipt_outcome: "cancelled" });
        oauthPhase("required", "unknown", "auth_required");
        server.tools = [];
        receipt = {
          ...server.auth,
          instance_id: request.instance_id,
          server_id: request.server_id,
          config_fingerprint: request.config_fingerprint,
          operation: "forget",
          operation_id: request.operation_id,
          receipt_outcome: "completed",
        };
      }
      authReceipts.set(request.operation_id, receipt);
      authAdmissions.set(request.operation_id, JSON.stringify(request));
    }
    observe();
    if (loseAuthResponse) {
      loseAuthResponse = false;
      throw new TypeError("Synthetic lost auth response");
    }
    return Response.json(receipt);
  }
  if (route === "stream") {
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    counts.streams++;
    observe();
    let active: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cleanup = () => {
      if (active) streamControllers.delete(active);
      init?.signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      const controller = active;
      cleanup();
      controller?.close();
    };
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          active = controller;
          streamControllers.set(controller, cleanup);
          controller.enqueue(
            encoder.encode(`event: snapshot\ndata: ${JSON.stringify(frame())}\n\n`),
          );
          init?.signal?.addEventListener("abort", abort, { once: true });
        },
        cancel() {
          cleanup();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  if (body.action === "list") {
    counts.lists++;
    observe();
    return Response.json(route === "mcp" ? catalog : frame());
  }
  counts.mutations++;
  if (route === "approvals" && typeof body.import_id === "string") {
    const decided = await imports.decide(body);
    observe();
    if (loseNextResponse) {
      loseNextResponse = false;
      throw new TypeError("Synthetic response lost after mutation");
    }
    return decided ?? Response.json({}, { status: 400 });
  }
  if (route === "approvals") {
    const selected = snapshot.commands?.find((item) => item.id === body.command_id);
    if (selected) {
      selected.state = body.action === "approve" ? "running" : "denied";
      selected.started_at = Date.now();
      if (body.action === "deny" && typeof body.reason === "string")
        selected.denial_reason = body.reason;
    }
  } else if (route === "mcp" && ["add_stdio", "add_http"].includes(String(body.action))) {
    const nextCatalog: McpPanelState = {
      catalog_revision: crypto.randomUUID(),
      servers: [
        ...catalog.servers,
        {
          id: crypto.randomUUID(),
          name: String(body.name),
          transport: body.action === "add_stdio" ? "stdio" : "http",
          config_fingerprint: await mcpAddFingerprint({ ...body, action: String(body.action) }),
          enabled: true,
          state: fixtureOptions.has("mcp-unavailable") ? "unavailable" : "ready",
          ...(fixtureOptions.has("mcp-unavailable") ? { message: "合成 MCP 無法連線。" } : {}),
          tools: [],
        },
      ],
    };
    if (holdNextAdd) {
      stagedCatalog = nextCatalog;
      holdNextAdd = false;
      loseNextResponse = true;
    } else catalog = nextCatalog;
  } else if (route === "mcp" && body.action === "refresh") {
    const server = oauthServer();
    if (server?.auth?.auth_phase === "authenticated") {
      oauthPhase("authenticated", "current");
      server.tools = syntheticTools(server.id, server.name, 2);
    }
  }
  observe();
  if (loseNextResponse) {
    loseNextResponse = false;
    throw new TypeError("Synthetic response lost after mutation");
  }
  emit();
  return Response.json(route === "mcp" ? catalog : frame());
};
globalThis.fetch = Object.assign(fixtureFetch, {
  preconnect() {
    throw new Error("Synthetic fixture blocks real preconnect");
  },
});
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-fixture-action]")) {
  button.onclick = () => {
    switch (button.dataset.fixtureAction) {
      case "pending":
        snapshot.commands?.push(command());
        emit();
        break;
      case "import":
        void modelImport().then(emit);
        break;
      case "lose-upload":
        imports.loseNextUpload();
        break;
      case "offline":
        online = false;
        dropStreams();
        break;
      case "online":
        online = true;
        break;
      case "invalid":
        authorized = false;
        dropStreams();
        break;
      case "lost":
        loseNextResponse = true;
        break;
      case "finish":
        if (stagedCatalog) {
          catalog = stagedCatalog;
          stagedCatalog = undefined;
          emit();
        }
        break;
      case "oauth-lost":
        loseAuthResponse = true;
        break;
      case "oauth-complete": {
        const old = lastLogin ? authReceipts.get(lastLogin) : undefined;
        if (lastLogin && old?.receipt_outcome === "pending") {
          oauthPhase("authenticated", "current");
          const server = oauthServer();
          if (server?.auth) {
            server.tools = syntheticTools(server.id, server.name, 2);
            authReceipts.set(lastLogin, { ...old, ...server.auth, receipt_outcome: "completed" });
          }
        }
        observe();
        break;
      }
      case "oauth-expire": {
        const old = lastLogin ? authReceipts.get(lastLogin) : undefined;
        if (lastLogin && old?.receipt_outcome === "pending") {
          oauthPhase("error", "unknown", "auth_expired");
          authReceipts.set(lastLogin, {
            ...old,
            ...oauthServer()?.auth,
            receipt_outcome: "failed",
          });
        }
        observe();
        break;
      }
      case "oauth-tools-error": {
        const server = oauthServer();
        if (server?.auth?.auth_phase === "authenticated")
          oauthPhase("authenticated", server.tools.length ? "stale" : "error", "tools_list_failed");
        observe();
        break;
      }
      case "oauth-relogin":
        oauthPhase("required", "stale", "auth_required");
        observe();
        break;
    }
  };
}
observe();
await import("../apps/extension/src/sidepanel.ts");
