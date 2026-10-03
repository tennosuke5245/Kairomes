import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type McpAuthInput,
  type McpAuthResult,
  McpAuthResultSchema,
  McpCallSchema,
  McpCatalogSchema,
  McpMountFileSchema,
  McpPanelStateSchema,
  mcpConfigFingerprint,
} from "@kairomes/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fixture } from "../../../tests/fixtures.ts";
import { McpHostManager } from "./mcp-host.ts";
import { createMcpOAuthNetwork } from "./mcp-oauth-network.ts";
import { startWorkbench } from "./preview.ts";
import { readWorkbenchConnection } from "./workbench-connection.ts";

const ENDPOINT = "https://mcp.flow.example.com/mcp";
const ISSUER = "https://auth.flow.example.com/";
const CLIENT_ID = "synthetic-flow-client";
const AUTHORIZATION_CODE = "synthetic-flow-code";
const accessToken = (index: number) => `synthetic-flow-access-${index}`;
const refreshToken = (index: number) => `synthetic-flow-refresh-${index}`;
type Mutation = Exclude<McpAuthInput, { action: "status" }>;

function present<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) throw new Error("合成驗證所需資料遺失。");
  return value;
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function until(predicate: () => boolean | Promise<boolean>) {
  for (let index = 0; index < 1000; index++) {
    if (await predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("合成 HTTP 登入流程未在期限內完成。");
}

/** All public HTTPS replies are synthetic; only Workbench and callback use real loopback HTTP. */
async function setup(tokenGate?: ReturnType<typeof deferred>) {
  const f = await fixture();
  const browsers: URL[] = [];
  const registrations: Array<Record<string, unknown>> = [];
  const exchanges: URLSearchParams[] = [];
  const authenticatedInitializations: string[] = [];
  const toolCallAuthorizations: string[] = [];
  const oauthHeaders: Headers[] = [];
  let toolLists = 0;
  const host = new McpHostManager(f.state, {
    oauth: {
      networkFactory: (endpoint) =>
        createMcpOAuthNetwork(endpoint, {
          resolver: async () => [{ address: "1.1.1.1", family: 4 }],
          requester: async (request) => {
            const body = request.body ? new TextDecoder().decode(request.body) : "";
            const url = request.url;
            if (url.origin === new URL(ISSUER).origin || url.pathname.includes(".well-known"))
              oauthHeaders.push(new Headers(request.headers));
            if (
              url.origin === new URL(ENDPOINT).origin &&
              url.pathname.includes("oauth-protected-resource")
            )
              return Response.json({
                resource: ENDPOINT,
                authorization_servers: [ISSUER],
                scopes_supported: ["read"],
              });
            if (url.origin === new URL(ISSUER).origin && url.pathname.includes(".well-known"))
              return Response.json({
                issuer: ISSUER,
                authorization_endpoint: `${ISSUER}authorize`,
                token_endpoint: `${ISSUER}token`,
                registration_endpoint: `${ISSUER}register`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
              });
            if (url.href === `${ISSUER}register` && request.method === "POST") {
              const metadata = JSON.parse(body) as Record<string, unknown>;
              registrations.push(metadata);
              return Response.json({ ...metadata, client_id: CLIENT_ID });
            }
            if (url.href === `${ISSUER}token` && request.method === "POST") {
              exchanges.push(new URLSearchParams(body));
              const index = exchanges.length;
              if (index === 1 && tokenGate) await tokenGate.promise;
              return Response.json({
                access_token: accessToken(index),
                token_type: "Bearer",
                refresh_token: refreshToken(index),
                expires_in: 3600,
                scope: "read",
              });
            }
            if (url.href !== ENDPOINT) throw new Error("未定義的合成 HTTPS 請求。");
            if (request.method === "GET") return new Response(null, { status: 405 });
            if (request.method === "DELETE") return new Response(null, { status: 204 });
            const rpc = JSON.parse(body) as {
              id?: number;
              method: string;
              params?: { name: string; arguments: { query: string } };
            };
            const authorization = request.headers.get("Authorization") ?? "";
            if (
              !exchanges.some(
                (_exchange, index) => authorization === `Bearer ${accessToken(index + 1)}`,
              )
            )
              return new Response(null, {
                status: 401,
                headers: {
                  "WWW-Authenticate": `Bearer resource_metadata="https://mcp.flow.example.com/.well-known/oauth-protected-resource/mcp"`,
                },
              });
            if (rpc.method === "notifications/initialized")
              return new Response(null, { status: 202 });
            if (rpc.method === "initialize") {
              authenticatedInitializations.push(authorization);
              return Response.json({
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "合成唯讀服務", version: "1" },
                },
              });
            }
            if (rpc.method === "tools/list") {
              toolLists++;
              return Response.json({
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  tools: [
                    {
                      name: "synthetic_lookup",
                      description: "Look up a synthetic, read-only value.",
                      inputSchema: {
                        type: "object",
                        properties: { query: { type: "string" } },
                        required: ["query"],
                        additionalProperties: false,
                      },
                      annotations: {
                        readOnlyHint: true,
                        destructiveHint: false,
                        openWorldHint: false,
                      },
                    },
                  ],
                },
              });
            }
            if (rpc.method === "tools/call" && rpc.params?.name === "synthetic_lookup") {
              toolCallAuthorizations.push(authorization);
              return Response.json({
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  content: [
                    { type: "text", text: `synthetic-result:${rpc.params.arguments.query}` },
                  ],
                },
              });
            }
            throw new Error("未定義的合成 MCP 方法。");
          },
        }),
    },
  });
  const extensionId = "a".repeat(32);
  const extensionOrigin = `chrome-extension://${extensionId}`;
  let app: Awaited<ReturnType<typeof startWorkbench>>;
  try {
    app = await startWorkbench(f.registry, "<html><!--KAIROMES_MODE--></html>", 0, extensionId, {
      mcpHost: host,
      openBrowser: async (url) => {
        browsers.push(new URL(url));
      },
    });
  } catch (error) {
    await host.close();
    await f.dispose();
    throw error;
  }
  const connection = await readWorkbenchConnection(f.state);
  const clients: Client[] = [];
  const post = (route: string, token: string, input: unknown, origin = extensionOrigin) =>
    fetch(`${connection.origin}${route}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5000),
    });
  const pair = async () => {
    const issuedResponse = await post(
      "/api/pairing/create",
      connection.adminToken,
      { extensionId },
      connection.origin,
    );
    expect(issuedResponse.status).toBe(200);
    const issued = (await issuedResponse.json()) as { pairingUrl: string };
    const fragment = new URLSearchParams(new URL(issued.pairingUrl).hash.slice(1));
    const response = await post("/api/panel/pair", "", {
      code: fragment.get("code"),
      instanceId: connection.instanceId,
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { panelToken: string }).panelToken;
  };
  const panel = async (token: string, input: unknown = { action: "list" }) => {
    const response = await post("/api/panel/mcp", token, input);
    expect(response.status).toBe(200);
    return McpPanelStateSchema.parse(await response.json());
  };
  const auth = async (token: string, input: McpAuthInput): Promise<McpAuthResult> => {
    const response = await post("/api/panel/mcp-auth", token, input);
    expect(response.status).toBe(200);
    return McpAuthResultSchema.parse(await response.json());
  };
  const input = (
    server: { id: string; config_fingerprint: string },
    action: Mutation["action"] = "start",
  ): Mutation => ({
    action,
    instance_id: connection.instanceId,
    server_id: server.id,
    config_fingerprint: server.config_fingerprint,
    operation_id: crypto.randomUUID(),
    accept_before: new Date(Date.now() + 30_000).toISOString(),
  });
  const status = (token: string, original: Mutation) =>
    auth(token, {
      action: "status",
      instance_id: original.instance_id,
      server_id: original.server_id,
      config_fingerprint: original.config_fingerprint,
      operation_id: original.operation_id,
      operation: original.action === "forget" ? "forget" : "login",
    });
  const callback = (index = 0) => {
    const browser = browsers[index];
    if (!browser) throw new Error("合成登入尚未開啟瀏覽器。");
    const url = new URL(browser.searchParams.get("redirect_uri") ?? "");
    url.searchParams.set("state", browser.searchParams.get("state") ?? "");
    url.searchParams.set("code", AUTHORIZATION_CODE);
    url.searchParams.set("iss", ISSUER);
    return url;
  };
  const broker = async () => {
    const client = new Client({ name: "synthetic-oauth-public-broker", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${connection.origin}/api/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${connection.mcpToken}` } },
      }),
    );
    return client;
  };
  const catalog = async (client: Client) =>
    McpCatalogSchema.parse(
      (await client.callTool({ name: "mcp_catalog_search", arguments: { query: "" } }))
        .structuredContent,
    );
  const privateValues = () =>
    [
      CLIENT_ID,
      AUTHORIZATION_CODE,
      ...exchanges.flatMap((exchange, index) => [
        accessToken(index + 1),
        refreshToken(index + 1),
        exchange.get("code_verifier") ?? "",
      ]),
      ...browsers.flatMap((browser) => [
        browser.href,
        browser.searchParams.get("state") ?? "",
        browser.searchParams.get("redirect_uri") ?? "",
      ]),
    ].filter(Boolean);
  const assertSafe = (value: unknown, extra: string[] = []) => {
    const text = JSON.stringify(value);
    for (const secret of [...privateValues(), ...extra]) expect(text).not.toContain(secret);
  };
  const assertPersistenceSafe = async () => {
    const source = await readFile(path.join(f.state, "mcp-servers.json"), "utf8");
    const config = McpMountFileSchema.parse(JSON.parse(source));
    assertSafe(config);
    for (const name of await readdir(f.state)) {
      if (!name.startsWith("state.sqlite")) continue;
      const bytes = await readFile(path.join(f.state, name));
      for (const secret of privateValues()) expect(bytes.includes(Buffer.from(secret))).toBe(false);
    }
    return config;
  };
  return {
    f,
    host,
    connection,
    browsers,
    registrations,
    exchanges,
    authenticatedInitializations,
    toolCallAuthorizations,
    oauthHeaders,
    toolLists: () => toolLists,
    post,
    pair,
    panel,
    auth,
    input,
    status,
    callback,
    broker,
    catalog,
    assertSafe,
    assertPersistenceSafe,
    async close() {
      tokenGate?.release();
      await Promise.all(clients.map((client) => client.close()));
      await app.close();
      await f.dispose();
    },
  };
}

async function mount(h: Awaited<ReturnType<typeof setup>>, token: string) {
  const mounted = await h.panel(token, {
    action: "add_http",
    name: "合成 OAuth 唯讀服務",
    url: ENDPOINT,
  });
  const server = mounted.servers[0];
  if (!server) throw new Error("合成 MCP 掛載遺失。");
  expect(server).toMatchObject({
    enabled: true,
    state: "unavailable",
    auth: { auth_phase: "required", tools_status: "unknown" },
    tools: [],
  });
  expect(h.registrations).toHaveLength(0);
  expect(h.browsers).toHaveLength(0);
  expect(h.exchanges).toHaveLength(0);
  return { ...server, config_fingerprint: present(server.config_fingerprint) };
}

test("Workbench 登入成功經真 SDK 回呼取得新清單，固定 broker 唯讀一次且忘記登入可查收據", async () => {
  const h = await setup();
  try {
    const owner = await h.pair();
    const client = await h.broker();
    const fixedTools = (await client.listTools()).tools.map((tool) => tool.name);
    const server = await mount(h, owner);
    expect(server.config_fingerprint).toBe(
      await mcpConfigFingerprint({
        name: server.name,
        transport: { kind: "http", url: ENDPOINT, header_env: {} },
      }),
    );
    const unavailable = await h.catalog(client);
    expect(unavailable.tools).toEqual([]);
    h.assertSafe(unavailable);
    const start = h.input(server);
    expect(await h.auth(owner, start)).toMatchObject({
      receipt_outcome: "pending",
      operation: "login",
    });
    await until(() => h.browsers.length === 1);
    const waiting = await h.status(owner, start);
    expect(waiting).toMatchObject({
      receipt_outcome: "pending",
      auth_phase: "waiting",
      tools_status: "unknown",
    });
    expect((await h.auth(owner, start)).receipt_outcome).toBe("pending");
    expect(h.registrations).toHaveLength(1);
    expect(h.browsers).toHaveLength(1);
    expect(h.registrations[0]).toMatchObject({
      redirect_uris: [present(h.browsers[0]).searchParams.get("redirect_uri")],
      token_endpoint_auth_method: "none",
    });
    const callbackResponse = await fetch(h.callback(), { signal: AbortSignal.timeout(5000) });
    expect(callbackResponse.status).toBe(200);
    expect(await callbackResponse.text()).toContain('<main class="connected"');
    const completed = await h.status(owner, start);
    expect(completed).toMatchObject({
      receipt_outcome: "completed",
      auth_phase: "authenticated",
      tools_status: "current",
    });
    expect(completed.phase_version).toBeGreaterThan(waiting.phase_version);
    expect((await h.auth(owner, start)).receipt_outcome).toBe("completed");
    expect(h.registrations).toHaveLength(1);
    expect(h.browsers).toHaveLength(1);
    const exchange = present(h.exchanges[0]);
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe(AUTHORIZATION_CODE);
    expect(exchange.get("client_id")).toBe(CLIENT_ID);
    expect(exchange.get("client_secret")).toBeNull();
    expect(exchange.get("resource")).toBe(ENDPOINT);
    expect(
      createHash("sha256")
        .update(present(exchange.get("code_verifier")))
        .digest("base64url"),
    ).toBe(present(present(h.browsers[0]).searchParams.get("code_challenge")));
    expect(h.authenticatedInitializations).toEqual([`Bearer ${accessToken(1)}`]);
    expect(h.toolLists()).toBe(1);
    const ready = await h.catalog(client);
    expect(ready.tools).toHaveLength(1);
    expect(ready.tools[0]).toMatchObject({
      availability: "ready",
      read_only_hint: true,
      destructive_hint: false,
    });
    const call = {
      tool_ref: present(ready.tools[0]).ref,
      catalog_revision: ready.catalog_revision,
      arguments: { query: "once" },
      request_id: crypto.randomUUID(),
    };
    const publicResult = await client.callTool({ name: "mcp_read_call", arguments: call });
    expect(publicResult.isError).not.toBe(true);
    const called = McpCallSchema.parse(publicResult.structuredContent);
    expect(called.content).toEqual([{ type: "text", text: "synthetic-result:once" }]);
    expect(h.toolCallAuthorizations).toEqual([`Bearer ${accessToken(1)}`]);
    expect(h.oauthHeaders.length).toBeGreaterThan(0);
    expect(
      McpCallSchema.parse(
        (await client.callTool({ name: "mcp_read_call", arguments: call })).structuredContent,
      ),
    ).toEqual(called);
    expect(h.toolCallAuthorizations).toHaveLength(1);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(fixedTools);
    h.assertSafe(
      [ready, publicResult],
      [
        start.operation_id,
        owner,
        h.connection.adminToken,
        h.connection.uiToken,
        h.connection.mcpToken,
        ENDPOINT,
        `${ISSUER}authorize`,
      ],
    );
    h.assertSafe(completed);
    const persisted = await h.assertPersistenceSafe();
    expect(persisted.servers[0]?.transport).toEqual({
      kind: "http",
      url: ENDPOINT,
      header_env: {},
    });
    expect(
      h.oauthHeaders.every(
        (headers) =>
          !headers.has("Authorization") && !headers.has("Cookie") && !headers.has("mcp-session-id"),
      ),
    ).toBe(true);
    const forget = h.input(server, "forget");
    expect((await h.auth(owner, forget)).operation).toBe("forget");
    await until(async () => (await h.status(owner, forget)).receipt_outcome === "completed");
    const forgotten = await h.status(owner, forget);
    expect(forgotten).toMatchObject({
      operation: "forget",
      receipt_outcome: "completed",
      auth_phase: "required",
      tools_status: "unknown",
    });
    expect((await h.auth(owner, forget)).receipt_outcome).toBe("completed");
    const afterForget = await h.catalog(client);
    expect(afterForget.tools.every((tool) => tool.availability !== "ready")).toBe(true);
    h.assertSafe(afterForget);
    expect(h.browsers).toHaveLength(1);
    expect(h.registrations).toHaveLength(1);
    expect(h.exchanges).toHaveLength(1);
    await h.assertPersistenceSafe();
  } finally {
    await h.close();
  }
}, 15000);

test("HTTP 取消原登入後新登入成功，舊交換晚回覆不能覆寫新權杖與收據", async () => {
  const gate = deferred();
  const h = await setup(gate);
  let oldCallback: Promise<Response> | undefined;
  try {
    const owner = await h.pair();
    const server = await mount(h, owner);
    const original = h.input(server);
    await h.auth(owner, original);
    await until(() => h.browsers.length === 1);
    oldCallback = fetch(h.callback(), { signal: AbortSignal.timeout(5000) });
    await until(() => h.exchanges.length === 1);
    expect((await h.status(owner, original)).auth_phase).toBe("verifying");
    expect(await h.auth(owner, { ...original, action: "cancel" })).toMatchObject({
      receipt_outcome: "cancelled",
      auth_phase: "required",
    });
    expect((await h.auth(owner, original)).receipt_outcome).toBe("cancelled");
    expect(h.browsers).toHaveLength(1);
    const replacement = h.input(server);
    await h.auth(owner, replacement);
    await until(() => h.browsers.length === 2);
    expect((await fetch(h.callback(1), { signal: AbortSignal.timeout(5000) })).status).toBe(200);
    expect(await h.status(owner, replacement)).toMatchObject({
      receipt_outcome: "completed",
      auth_phase: "authenticated",
      tools_status: "current",
    });
    gate.release();
    expect((await oldCallback).status).toBe(400);
    expect((await h.status(owner, original)).receipt_outcome).toBe("cancelled");
    expect(await h.status(owner, replacement)).toMatchObject({
      receipt_outcome: "completed",
      auth_phase: "authenticated",
      tools_status: "current",
    });
    expect(h.authenticatedInitializations).toEqual([`Bearer ${accessToken(2)}`]);
    const client = await h.broker();
    const ready = await h.catalog(client);
    expect(ready.tools[0]?.availability).toBe("ready");
    const result = await client.callTool({
      name: "mcp_read_call",
      arguments: {
        tool_ref: present(ready.tools[0]).ref,
        catalog_revision: ready.catalog_revision,
        arguments: { query: "replacement" },
        request_id: crypto.randomUUID(),
      },
    });
    expect(result.isError).not.toBe(true);
    expect(h.toolCallAuthorizations).toEqual([`Bearer ${accessToken(2)}`]);
    h.assertSafe([ready, result]);
    await h.assertPersistenceSafe();
  } finally {
    gate.release();
    await oldCallback?.catch(() => undefined);
    await h.close();
  }
}, 15000);

test("另一個配對 owner 不能取得或取消原收據，解除原配對阻止晚登入而新 owner 仍可開始", async () => {
  const gate = deferred();
  const h = await setup(gate);
  let callback: Promise<Response> | undefined;
  try {
    const owner = await h.pair();
    const otherOwner = await h.pair();
    const server = await mount(h, owner);
    const original = h.input(server);
    await h.auth(owner, original);
    await until(() => h.browsers.length === 1);
    callback = fetch(h.callback(), { signal: AbortSignal.timeout(5000) });
    await until(() => h.exchanges.length === 1);
    expect((await h.status(otherOwner, original)).receipt_outcome).toBe("missing");
    expect((await h.auth(otherOwner, { ...original, action: "cancel" })).receipt_outcome).toBe(
      "cancelled",
    );
    expect(await h.status(owner, original)).toMatchObject({
      receipt_outcome: "pending",
      auth_phase: "verifying",
    });
    expect((await h.post("/api/panel/disconnect", owner, {})).status).toBe(200);
    expect(
      (
        await h.post("/api/panel/mcp-auth", owner, {
          action: "status",
          instance_id: original.instance_id,
          server_id: original.server_id,
          config_fingerprint: original.config_fingerprint,
          operation_id: original.operation_id,
          operation: "login",
        })
      ).status,
    ).toBe(401);
    gate.release();
    expect((await callback).status).toBe(400);
    expect(h.authenticatedInitializations).toEqual([]);
    expect(h.toolLists()).toBe(0);
    expect((await h.panel(otherOwner)).servers[0]).toMatchObject({
      state: "unavailable",
      auth: { auth_phase: "required" },
      tools: [],
    });
    const replacement = h.input(server);
    await h.auth(otherOwner, replacement);
    await until(() => h.browsers.length === 2);
    expect((await fetch(h.callback(1), { signal: AbortSignal.timeout(5000) })).status).toBe(200);
    expect(await h.status(otherOwner, replacement)).toMatchObject({
      receipt_outcome: "completed",
      auth_phase: "authenticated",
      tools_status: "current",
    });
    expect(h.authenticatedInitializations).toEqual([`Bearer ${accessToken(2)}`]);
    await h.assertPersistenceSafe();
  } finally {
    gate.release();
    await callback?.catch(() => undefined);
    await h.close();
  }
}, 15000);

for (const change of ["disable", "configuration"] as const) {
  test(`登入交換中${change === "disable" ? "停用掛載" : "修改精確掛載身份"}，晚回覆不得還原工具或完成舊收據`, async () => {
    const gate = deferred();
    const h = await setup(gate);
    let callback: Promise<Response> | undefined;
    try {
      const owner = await h.pair();
      const server = await mount(h, owner);
      const original = h.input(server);
      await h.auth(owner, original);
      await until(() => h.browsers.length === 1);
      callback = fetch(h.callback(), { signal: AbortSignal.timeout(5000) });
      await until(() => h.exchanges.length === 1);
      if (change === "disable") {
        expect(
          (
            await h.panel(owner, {
              action: "set_server_enabled",
              server_id: server.id,
              enabled: false,
            })
          ).servers[0],
        ).toMatchObject({ enabled: false, state: "disconnected" });
      } else {
        const file = path.join(h.f.state, "mcp-servers.json");
        const persisted = McpMountFileSchema.parse(JSON.parse(await readFile(file, "utf8")));
        present(persisted.servers[0]).name = "合成變更後身份";
        await writeFile(file, JSON.stringify(persisted));
        const changed = present((await h.panel(owner)).servers[0]);
        expect(changed.config_fingerprint).not.toBe(server.config_fingerprint);
        expect(changed.name).toBe("合成變更後身份");
      }
      gate.release();
      expect((await callback).status).toBe(400);
      expect((await h.status(owner, original)).receipt_outcome).toBe("cancelled");
      expect(h.authenticatedInitializations).toEqual([]);
      expect(h.toolLists()).toBe(0);
      expect(
        (
          await h.post("/api/panel/mcp-auth", owner, {
            ...original,
            operation_id: crypto.randomUUID(),
          })
        ).status,
      ).toBe(400);
      expect(h.registrations).toHaveLength(1);
      expect(h.browsers).toHaveLength(1);
      const catalog = await h.catalog(await h.broker());
      expect(catalog.tools).toEqual([]);
      h.assertSafe(catalog);
      await h.assertPersistenceSafe();
    } finally {
      gate.release();
      await callback?.catch(() => undefined);
      await h.close();
    }
  }, 15000);
}
