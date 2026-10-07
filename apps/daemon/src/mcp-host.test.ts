import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type McpAuthInput,
  type McpMountConfig,
  mcpConfigFingerprint,
  mcpConfigIdentitySource,
} from "@kairomes/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { fixture } from "../../../tests/fixtures.ts";
import { McpHostManager } from "./mcp-host.ts";
import { createMcpOAuthNetwork } from "./mcp-oauth-network.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let managers: McpHostManager[];
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("合成測試缺少必要值。");
  return value;
}

beforeEach(async () => {
  f = await fixture();
  managers = [];
});

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.close()));
  await f.dispose();
});

async function configured() {
  const manager = new McpHostManager(f.state);
  managers.push(manager);
  const fixturePath = fileURLToPath(new URL("./__fixtures__/read-mcp.ts", import.meta.url));
  const config = await manager.addStdio({
    name: "Read fixture",
    command: process.execPath,
    args: [fixturePath],
  });
  await manager.refresh(config.id);
  return { manager, config, fixturePath };
}

type OAuthFixtureMode =
  | "connection_timeout"
  | "tools_list_timeout"
  | "tools_limit"
  | "schema_medium"
  | "schema_boundary"
  | "schema_limit"
  | "tools_invalid"
  | "tools_list_http_503"
  | "empty";

function syntheticSchemas(bytes: number) {
  const inputSchema = { description: "", type: "object" as const };
  const outputSchema = { description: "", type: "object" as const };
  const remaining =
    bytes -
    Buffer.byteLength(JSON.stringify({ input_schema: inputSchema, output_schema: outputSchema }));
  inputSchema.description = "x".repeat(Math.floor(remaining / 2));
  outputSchema.description = "x".repeat(remaining - inputSchema.description.length);
  return { inputSchema, outputSchema };
}

async function oauthFailureFixture(initialMode: OAuthFixtureMode) {
  let mode = initialMode;
  const state = path.join(f.state, crypto.randomUUID());
  await mkdir(state);
  const endpoint = "https://mcp.diagnostic.example.com/mcp";
  const browsers: URL[] = [];
  const sessionRequests: Array<{ method: string; session: string | null; version: string | null }> =
    [];
  const manager = new McpHostManager(state, {
    oauth: {
      networkFactory: (url) =>
        createMcpOAuthNetwork(url, {
          resolver: async () => [{ address: "1.1.1.1", family: 4 }],
          requester: async (request) => {
            const body = request.body ? new TextDecoder().decode(request.body) : "";
            if (request.url.pathname.includes("oauth-protected-resource"))
              return Response.json({
                resource: endpoint,
                authorization_servers: ["https://auth.diagnostic.example.com"],
              });
            if (request.url.pathname.includes(".well-known"))
              return Response.json({
                issuer: "https://auth.diagnostic.example.com/",
                authorization_endpoint: "https://auth.diagnostic.example.com/authorize",
                token_endpoint: "https://auth.diagnostic.example.com/token",
                registration_endpoint: "https://auth.diagnostic.example.com/register",
                response_types_supported: ["code"],
                code_challenge_methods_supported: ["S256"],
                token_endpoint_auth_methods_supported: ["none"],
              });
            if (request.url.pathname === "/register")
              return Response.json({ ...JSON.parse(body), client_id: "synthetic-client" });
            if (request.url.pathname === "/token")
              return Response.json({
                access_token: "synthetic-access",
                token_type: "Bearer",
                expires_in: 3600,
              });
            if (request.headers.get("Authorization") !== "Bearer synthetic-access")
              return new Response(null, {
                status: 401,
                headers: {
                  "WWW-Authenticate": `Bearer resource_metadata="https://mcp.diagnostic.example.com/.well-known/oauth-protected-resource/mcp"`,
                },
              });
            if (request.method === "GET") return new Response(null, { status: 405 });
            const rpc = JSON.parse(body);
            sessionRequests.push({
              method: rpc.method,
              session: request.headers.get("mcp-session-id"),
              version: request.headers.get("mcp-protocol-version"),
            });
            if (rpc.method === "notifications/initialized")
              return new Response(null, { status: 202 });
            if (
              (mode === "connection_timeout" && rpc.method === "initialize") ||
              (mode === "tools_list_timeout" && rpc.method === "tools/list")
            )
              return Response.json({
                jsonrpc: "2.0",
                id: rpc.id,
                error: {
                  code: ErrorCode.RequestTimeout,
                  message: "synthetic-private-timeout-body",
                },
              });
            if (rpc.method === "initialize")
              return Response.json(
                {
                  jsonrpc: "2.0",
                  id: rpc.id,
                  result: {
                    protocolVersion: "2025-11-25",
                    capabilities: { tools: {} },
                    serverInfo: { name: "合成會話 MCP", version: "1" },
                  },
                },
                { headers: { "mcp-session-id": "synthetic-session" } },
              );
            if (mode === "tools_list_http_503")
              return new Response("synthetic-private-http-body", { status: 503 });
            const tool = (index: number) => ({
              name: `synthetic_tool_${index}`,
              inputSchema: { type: "object" },
            });
            const tools =
              mode === "tools_limit"
                ? Array.from({ length: 129 }, (_, index) => tool(index))
                : mode === "schema_limit" || mode === "schema_medium" || mode === "schema_boundary"
                  ? [
                      {
                        ...tool(0),
                        ...syntheticSchemas(
                          mode === "schema_medium"
                            ? 34 * 1024
                            : 64 * 1024 + (mode === "schema_limit" ? 1 : 0),
                        ),
                      },
                    ]
                  : mode === "tools_invalid"
                    ? [tool(0), tool(0)]
                    : [];
            return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools } });
          },
        }),
    },
  });
  managers.push(manager);
  const instance = crypto.randomUUID();
  manager.configureAuth(
    instance,
    async (url) => {
      browsers.push(new URL(url));
    },
    () => true,
  );
  const config = await manager.addHttp({ name: "合成安全診斷", url: endpoint });
  await manager.refresh(config.id);
  const login = async (target: McpMountConfig) => {
    const browserIndex = browsers.length;
    const input: Extract<McpAuthInput, { action: "start" }> = {
      action: "start",
      instance_id: instance,
      server_id: target.id,
      config_fingerprint: await mcpConfigFingerprint(target),
      operation_id: crypto.randomUUID(),
      accept_before: new Date(Date.now() + 30_000).toISOString(),
    };
    manager.auth("owner", input);
    for (let index = 0; index < 100 && browsers.length === browserIndex; index++)
      await Bun.sleep(1);
    const browser = required(browsers[browserIndex]);
    const callback = new URL(required(browser.searchParams.get("redirect_uri")));
    callback.searchParams.set("state", required(browser.searchParams.get("state")));
    callback.searchParams.set("code", "synthetic-code");
    return callback;
  };
  const callback = await login(config);
  return {
    manager,
    config,
    state,
    login,
    callback,
    sessionRequests,
    setMode: (next: OAuthFixtureMode) => {
      mode = next;
    },
  };
}

describe("downstream MCP broker", () => {
  test("目錄組合遇到非同步配置切換，舊快照不能附上新配置的登入成功狀態", async () => {
    const fixture = await oauthFailureFixture("tools_list_http_503");
    await fetch(fixture.callback);
    const oldState = await fixture.manager.panelState();
    const oldServer = required(oldState.servers[0]);
    expect(oldServer.auth).toMatchObject({
      tools_status: "error",
      error_code: "tools_list_http_503",
    });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const identity = mcpConfigIdentitySource(fixture.config);
    let entered!: () => void;
    const digestEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const digest = spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, bytes) => {
      if (new TextDecoder().decode(bytes) === identity) {
        entered();
        await held;
      }
      return originalDigest(algorithm, bytes);
    });
    try {
      const reading = fixture.manager.panelState();
      // A previous async-digest implementation pauses here; a coherent snapshot already completes.
      await Promise.race([digestEntered, reading]);
      const replacement = { ...fixture.config, name: "合成替換配置" };
      await fs.writeFile(
        path.join(fixture.state, "mcp-servers.json"),
        JSON.stringify({ version: 1, servers: [replacement] }),
      );
      fixture.setMode("empty");
      await fixture.manager.refresh(replacement.id);
      const callback = await fixture.login(replacement);
      expect((await fetch(callback)).status).toBe(200);
      const current = await fixture.manager.panelState();
      expect(current.servers[0]).toMatchObject({
        name: replacement.name,
        state: "ready",
        config_fingerprint: await mcpConfigFingerprint(replacement),
        auth: { auth_phase: "authenticated", tools_status: "current" },
      });
      release();
      const previous = await reading;
      expect(previous).toEqual(oldState);
      expect(previous.servers[0]?.config_fingerprint).not.toBe(
        current.servers[0]?.config_fingerprint,
      );
      expect(fixture.manager.authSummary(replacement.id)).toEqual(current.servers[0]?.auth);
      const publicCatalog = await fixture.manager.catalog({ query: "", limit: 10, refresh: false });
      expect(publicCatalog.catalog_revision).toBe(current.catalog_revision);
      expect(publicCatalog.servers[0]).toMatchObject({ name: replacement.name, state: "ready" });
      expect(JSON.stringify(publicCatalog)).not.toContain("auth_phase");
      expect(fixture.sessionRequests.filter((request) => request.method === "tools/call")).toEqual(
        [],
      );
    } finally {
      release();
      digest.mockRestore();
    }
  });

  test("34 KiB與64 KiB合計工具定義完整可讀，超限的新清單使舊工具不可呼叫", async () => {
    const fixture = await oauthFailureFixture("schema_medium");
    const response = await fetch(fixture.callback);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<main class="connected"');
    for (const [mode, bytes] of [
      ["schema_medium", 34 * 1024],
      ["schema_boundary", 64 * 1024],
    ] as const) {
      if (mode === "schema_boundary") {
        fixture.setMode(mode);
        await fixture.manager.refresh(fixture.config.id);
      }
      const catalog = await fixture.manager.catalog({ query: "", limit: 10, refresh: false });
      const tool = required(catalog.tools[0]);
      expect(catalog.servers[0]?.state).toBe("ready");
      expect(tool.availability).toBe("ready");
      const description = await fixture.manager.describe(tool.ref);
      expect(
        Buffer.byteLength(
          JSON.stringify({
            input_schema: description.tool.input_schema,
            output_schema: description.tool.output_schema,
          }),
        ),
      ).toBe(bytes);
      expect(description.tool.input_schema).toEqual(syntheticSchemas(bytes).inputSchema);
      expect(description.tool.output_schema).toEqual(syntheticSchemas(bytes).outputSchema);
      expect(description.catalog_revision).toBe(catalog.catalog_revision);
    }
    const prior = await fixture.manager.catalog({ query: "", limit: 10, refresh: false });
    const originalTool = required(prior.tools[0]);
    fixture.setMode("schema_limit");
    await fixture.manager.refresh(fixture.config.id);
    const current = await fixture.manager.catalog({ query: "", limit: 10, refresh: false });
    expect(current.catalog_revision).not.toBe(prior.catalog_revision);
    expect(current.servers[0]).toMatchObject({
      state: "unavailable",
      message: "工具定義超過 64 KiB 上限。",
    });
    expect(current.tools[0]).toMatchObject({ ref: originalTool.ref, availability: "unavailable" });
    expect((await fixture.manager.panelState()).servers[0]?.auth).toMatchObject({
      auth_phase: "authenticated",
      tools_status: "error",
      error_code: "schema_limit",
    });
    await expect(
      fixture.manager.call({
        tool_ref: originalTool.ref,
        catalog_revision: current.catalog_revision,
        arguments: {},
        request_id: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "MCP_TOOL_NOT_ALLOWED" });
    expect(fixture.sessionRequests.filter((request) => request.method === "tools/call")).toEqual(
      [],
    );
  });

  test("登入後初始化、清單、數量與schema失敗回安全分類，回呼不冒稱工具可用", async () => {
    for (const mode of [
      "connection_timeout",
      "tools_list_timeout",
      "tools_limit",
      "schema_limit",
      "tools_invalid",
      "tools_list_http_503",
      "empty",
    ] as const) {
      const fixture = await oauthFailureFixture(mode);
      const response = await fetch(fixture.callback);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain(
        mode === "empty" ? '<main class="connected"' : '<main class="authorized"',
      );
      const server = required(
        (await fixture.manager.panelState()).servers.find((item) => item.id === fixture.config.id),
      );
      expect(server.state).toBe(mode === "empty" ? "ready" : "unavailable");
      expect(server.auth).toMatchObject({
        auth_phase: "authenticated",
        tools_status: mode === "empty" ? "current" : "error",
        ...(mode === "empty" ? {} : { error_code: mode }),
      });
      expect(server.tools).toHaveLength(0);
      for (const sensitive of [
        "synthetic-private",
        "synthetic-access",
        "synthetic-session",
        "synthetic-client",
        "synthetic-code",
      ]) {
        expect(JSON.stringify(server)).not.toContain(sensitive);
        expect(html).not.toContain(sensitive);
      }
      if (mode !== "connection_timeout") {
        const notification = fixture.sessionRequests.find(
          (request) => request.method === "notifications/initialized",
        );
        const listing = fixture.sessionRequests.find((request) => request.method === "tools/list");
        expect(notification).toMatchObject({ session: "synthetic-session", version: "2025-11-25" });
        expect(listing).toMatchObject({ session: "synthetic-session", version: "2025-11-25" });
      }
    }
  });
  test("重新連線初始清理晚完成，停用後重開的新連線不被覆寫", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connect = spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
    const listing = spyOn(Client.prototype, "listTools").mockResolvedValue({ tools: [] });
    const close = spyOn(Client.prototype, "close")
      .mockImplementationOnce(() => held)
      .mockResolvedValue(undefined);
    try {
      const manager = new McpHostManager(f.state);
      managers.push(manager);
      const config = await manager.addHttp({
        name: "合成重開競態",
        url: "https://example.com/mcp",
      });
      await manager.refresh(config.id);
      const old = manager.refresh(config.id);
      for (let index = 0; index < 100 && close.mock.calls.length === 0; index++) await Bun.sleep(1);
      expect(close).toHaveBeenCalledTimes(1);
      await manager.setServerEnabled(config.id, false);
      await manager.setServerEnabled(config.id, true);
      expect(connect).toHaveBeenCalledTimes(2);
      release();
      await old;
      expect(connect).toHaveBeenCalledTimes(2);
      expect((await manager.panelState()).servers[0]?.state).toBe("ready");
    } finally {
      release();
      connect.mockRestore();
      listing.mockRestore();
      close.mockRestore();
    }
  });

  test("舊連線失敗的清理晚完成，不得覆寫已成功的新連線", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connect = spyOn(Client.prototype, "connect")
      .mockRejectedValueOnce(new Error("synthetic-private-error"))
      .mockResolvedValue(undefined);
    const close = spyOn(Client.prototype, "close")
      .mockImplementationOnce(() => held)
      .mockResolvedValue(undefined);
    const listing = spyOn(Client.prototype, "listTools").mockResolvedValue({
      tools: [{ name: "synthetic_new", inputSchema: { type: "object" } }],
    });
    try {
      const manager = new McpHostManager(f.state);
      managers.push(manager);
      const config = await manager.addHttp({
        name: "合成清理競態",
        url: "https://example.com/mcp",
      });
      const old = manager.refresh(config.id);
      for (let index = 0; index < 100 && close.mock.calls.length === 0; index++) await Bun.sleep(1);
      expect(close).toHaveBeenCalledTimes(1);
      await manager.refresh(config.id);
      expect((await manager.panelState()).servers[0]?.state).toBe("ready");
      release();
      await old;
      expect((await manager.panelState()).servers[0]).toMatchObject({
        state: "ready",
        tools: [{ name: "synthetic_new", availability: "ready" }],
      });
    } finally {
      release();
      connect.mockRestore();
      close.mockRestore();
      listing.mockRestore();
    }
  });

  test("舊工具呼叫晚回認證錯誤，只影響原結果，不能停用新連線", async () => {
    const { manager, config } = await configured();
    const catalog = await manager.catalog({ query: "", limit: 20, refresh: false });
    let reject!: (error: Error) => void;
    const held = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const call = spyOn(Client.prototype, "callTool").mockImplementationOnce(() => held);
    try {
      const lookup = required(catalog.tools.find((tool) => tool.name === "lookup"));
      const pending = manager
        .call({
          tool_ref: lookup.ref,
          catalog_revision: catalog.catalog_revision,
          arguments: { query: "synthetic" },
          request_id: crypto.randomUUID(),
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      for (let index = 0; index < 100 && call.mock.calls.length === 0; index++) await Bun.sleep(1);
      expect(call).toHaveBeenCalledTimes(1);
      await manager.refresh(config.id);
      reject(Object.assign(new Error("synthetic-private-error"), { code: "MCP_AUTH_REQUIRED" }));
      expect(await pending).toMatchObject({ code: "MCP_CALL_FAILED" });
      expect((await manager.panelState()).servers[0]?.state).toBe("ready");
    } finally {
      call.mockRestore();
    }
  });

  test("HTTP 登入以真 SDK 探測、回呼及新清單恢復，401 工具呼叫只送一次且背景不開頁", async () => {
    const browsers: URL[] = [];
    const instance = crypto.randomUUID();
    const endpoint = "https://mcp.synthetic.example.com/mcp";
    let registrations = 0;
    let toolCalls = 0;
    const manager = new McpHostManager(f.state, {
      oauth: {
        networkFactory: (url) =>
          createMcpOAuthNetwork(url, {
            resolver: async () => [{ address: "1.1.1.1", family: 4 }],
            requester: async (request) => {
              const body = request.body ? new TextDecoder().decode(request.body) : "";
              if (request.url.pathname.includes("oauth-protected-resource"))
                return Response.json({
                  resource: endpoint,
                  authorization_servers: ["https://auth.synthetic.example.com"],
                });
              if (request.url.pathname.includes(".well-known"))
                return Response.json({
                  issuer: "https://auth.synthetic.example.com/",
                  authorization_endpoint: "https://auth.synthetic.example.com/authorize",
                  token_endpoint: "https://auth.synthetic.example.com/token",
                  registration_endpoint: "https://auth.synthetic.example.com/register",
                  response_types_supported: ["code"],
                  code_challenge_methods_supported: ["S256"],
                  token_endpoint_auth_methods_supported: ["none"],
                });
              if (request.url.pathname === "/register") {
                registrations++;
                return Response.json({ ...JSON.parse(body), client_id: "synthetic-client" });
              }
              if (request.url.pathname === "/token")
                return Response.json({
                  access_token: "synthetic-access",
                  token_type: "Bearer",
                  expires_in: 3600,
                });
              if (request.method === "GET") return new Response(null, { status: 405 });
              const rpc = JSON.parse(body);
              if (rpc.method === "tools/call") {
                toolCalls++;
                return new Response(null, {
                  status: 401,
                  headers: {
                    "WWW-Authenticate": `Bearer resource_metadata="https://mcp.synthetic.example.com/.well-known/oauth-protected-resource/mcp"`,
                  },
                });
              }
              if (request.headers.get("Authorization") !== "Bearer synthetic-access")
                return new Response(null, {
                  status: 401,
                  headers: {
                    "WWW-Authenticate": `Bearer resource_metadata="https://mcp.synthetic.example.com/.well-known/oauth-protected-resource/mcp"`,
                  },
                });
              if (rpc.method === "notifications/initialized")
                return new Response(null, { status: 202 });
              return Response.json({
                jsonrpc: "2.0",
                id: rpc.id,
                result:
                  rpc.method === "initialize"
                    ? {
                        protocolVersion: "2025-11-25",
                        capabilities: { tools: {} },
                        serverInfo: { name: "合成 OAuth MCP", version: "1" },
                      }
                    : { tools: [{ name: "synthetic_action", inputSchema: { type: "object" } }] },
              });
            },
          }),
      },
    });
    managers.push(manager);
    manager.configureAuth(
      instance,
      async (url) => {
        browsers.push(new URL(url));
      },
      () => true,
    );
    const config = await manager.addHttp({ name: "合成 OAuth MCP", url: endpoint });
    await manager.refresh(config.id);
    expect((await manager.panelState()).servers[0]).toMatchObject({
      state: "unavailable",
      auth: { auth_phase: "required", tools_status: "unknown" },
      tools: [],
    });
    expect(browsers).toHaveLength(0);
    expect(registrations).toBe(0);
    const input = {
      action: "start" as const,
      instance_id: instance,
      server_id: config.id,
      config_fingerprint: await mcpConfigFingerprint(config),
      operation_id: crypto.randomUUID(),
      accept_before: new Date(Date.now() + 30_000).toISOString(),
    };
    manager.auth("owner", input);
    for (let index = 0; index < 100 && !browsers.length; index++) await Bun.sleep(1);
    expect(browsers).toHaveLength(1);
    await manager.catalog({ query: "", limit: 20, refresh: true });
    expect(manager.authSummary(config.id)?.auth_phase).toBe("waiting");
    const callback = new URL(required(required(browsers[0]).searchParams.get("redirect_uri")));
    callback.searchParams.set("state", required(required(browsers[0]).searchParams.get("state")));
    callback.searchParams.set("code", "synthetic-code");
    expect((await fetch(callback)).status).toBe(200);
    const catalog = await manager.catalog({ query: "", limit: 20, refresh: false });
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.tools[0]?.availability).toBe("ready");
    expect((await manager.panelState()).servers[0]).toMatchObject({
      state: "ready",
      auth: { auth_phase: "authenticated", tools_status: "current" },
    });
    const unauthorized = {
      tool_ref: required(catalog.tools[0]).ref,
      catalog_revision: catalog.catalog_revision,
      arguments: {},
      request_id: crypto.randomUUID(),
    };
    await expect(manager.call(unauthorized)).rejects.toMatchObject({ code: "MCP_AUTH_REQUIRED" });
    expect(toolCalls).toBe(1);
    // The rejected request reached the server, so its request_id is never sent again.
    await expect(manager.call(unauthorized)).rejects.toMatchObject({ code: "MCP_CALL_UNKNOWN" });
    expect(toolCalls).toBe(1);
    expect(registrations).toBe(1);
    expect(browsers).toHaveLength(1);
    const unavailable = await manager.catalog({ query: "", limit: 20, refresh: false });
    expect(unavailable.tools[0]?.availability).toBe("unavailable");
    expect(manager.authSummary(config.id)).toMatchObject({
      auth_phase: "required",
      tools_status: "stale",
    });
  });

  test("既有 HTTPS 私人位址與內網 DNS 掛載保持 legacy，不註冊 OAuth provider", async () => {
    const connect = spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
    const listing = spyOn(Client.prototype, "listTools").mockResolvedValue({ tools: [] });
    let oauthRequests = 0;
    try {
      for (const url of ["https://127.0.0.1/mcp", "https://internal.synthetic.example.com/mcp"]) {
        const manager = new McpHostManager(f.state, {
          oauth: {
            networkFactory: (endpoint) =>
              createMcpOAuthNetwork(endpoint, {
                resolver: async () => [{ address: "10.0.0.2", family: 4 }],
                requester: async () => {
                  oauthRequests++;
                  throw new Error("不應送出 OAuth 網路請求。");
                },
              }),
          },
        });
        managers.push(manager);
        manager.configureAuth(
          crypto.randomUUID(),
          async () => {
            throw new Error("不應開啟瀏覽器。");
          },
          () => true,
        );
        const config = await manager.addHttp({ name: "合成原有內網", url });
        await manager.refresh(config.id);
        const transport = connect.mock.calls.at(-1)?.[0] as unknown as { _authProvider?: unknown };
        expect(transport._authProvider).toBeUndefined();
        expect(
          (await manager.panelState()).servers.find((server) => server.id === config.id),
        ).toMatchObject({ state: "ready", tools: [] });
        expect(manager.authSummary(config.id)).toBeUndefined();
      }
      expect(oauthRequests).toBe(0);
    } finally {
      connect.mockRestore();
      listing.mockRestore();
    }
  });

  test("stdio initialization allows bridge startup while HTTP and tool listing retain short limits", async () => {
    const connect = spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
    const listing = spyOn(Client.prototype, "listTools").mockResolvedValue({ tools: [] });
    try {
      for (const kind of ["stdio", "http"] as const) {
        const manager = new McpHostManager(f.state);
        managers.push(manager);
        const config =
          kind === "stdio"
            ? await manager.addStdio({ name: "合成橋接啟動", command: "synthetic-program" })
            : await manager.addHttp({ name: "合成 HTTP", url: "https://example.test/mcp" });
        await manager.refresh(config.id);
        expect(connect).toHaveBeenLastCalledWith(expect.anything(), {
          timeout: kind === "stdio" ? 120_000 : 10_000,
        });
        expect(listing).toHaveBeenLastCalledWith({}, { timeout: 10_000 });
        expect(
          (await manager.panelState()).servers.find((server) => server.id === config.id),
        ).toMatchObject({ state: "ready", tools: [] });
      }
      expect(connect).toHaveBeenCalledTimes(2);
      expect(listing).toHaveBeenCalledTimes(2);
    } finally {
      connect.mockRestore();
      listing.mockRestore();
    }
  });

  test("connection diagnostics classify only known stdio codes without exposing private error details", async () => {
    const connectFailure = spyOn(Client.prototype, "connect");
    const generic = "無法連線；請由本機使用者檢查這個 MCP 的設定與執行狀態。";
    const failures = [
      ["stdio", "ENOENT", "找不到啟動程式。"],
      ["stdio", "EACCES", "啟動權限不足。"],
      ["stdio", "EPERM", "啟動權限不足。"],
      ["stdio", "SYNTHETIC_UNKNOWN", generic],
      ["stdio", -32001, generic],
      ["http", "EACCES", generic],
    ] as const;
    try {
      for (const [kind, code, expected] of failures) {
        const manager = new McpHostManager(f.state);
        managers.push(manager);
        const error = Object.assign(new Error("synthetic-private-message"), {
          code,
          path: "synthetic-private-path",
          stderr: "synthetic-private-stderr",
        });
        connectFailure.mockRejectedValueOnce(error);
        const config =
          kind === "stdio"
            ? await manager.addStdio({ name: `合成錯誤 ${code}`, command: "synthetic-program" })
            : await manager.addHttp({ name: `合成錯誤 ${code}`, url: "https://example.test/mcp" });
        await manager.refresh(config.id);
        const server = (await manager.panelState()).servers.find((item) => item.id === config.id);
        expect(server).toMatchObject({ state: "unavailable", message: expected, tools: [] });
        for (const privateValue of [error.message, error.path, error.stderr])
          expect(JSON.stringify(server)).not.toContain(privateValue);
      }
      const manager = new McpHostManager(f.state);
      managers.push(manager);
      const sdkError = new McpError(ErrorCode.RequestTimeout, "synthetic-private-message", {
        path: "synthetic-private-path",
        stderr: "synthetic-private-stderr",
      });
      connectFailure.mockRejectedValueOnce(sdkError);
      const config = await manager.addStdio({
        name: "合成 SDK 逾時",
        command: "synthetic-program",
      });
      await manager.refresh(config.id);
      const server = (await manager.panelState()).servers.find((item) => item.id === config.id);
      expect(server).toMatchObject({
        state: "unavailable",
        message: "連線逾時；請完成必要登入後再重新探索。",
        tools: [],
      });
      for (const privateValue of [
        "synthetic-private-message",
        "synthetic-private-path",
        "synthetic-private-stderr",
      ])
        expect(JSON.stringify(server)).not.toContain(privateValue);
      expect(connectFailure).toHaveBeenCalledTimes(failures.length + 1);
    } finally {
      connectFailure.mockRestore();
    }
  });

  test("failed add writes leave no runtime and a later retry persists only its own configuration", async () => {
    const isolatedState = path.join(f.directory, "isolated-mcp-state");
    await mkdir(isolatedState);
    const manager = new McpHostManager(isolatedState);
    managers.push(manager);
    await manager.panelState();
    const heldState = path.join(f.directory, "held-state");
    await rename(isolatedState, heldState);
    try {
      await expect(
        manager.addStdio({ name: "未保存 stdio", command: "synthetic-program" }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await manager.panelState()).servers).toEqual([]);
      await expect(
        manager.addHttp({ name: "未保存 HTTP", url: "https://example.test/mcp" }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect((await manager.panelState()).servers).toEqual([]);
    } finally {
      await rename(heldState, isolatedState);
    }
    const retry = await manager.addHttp({ name: "保存重試", url: "https://example.test/retry" });
    expect((await manager.panelState()).servers.map((server) => server.id)).toEqual([retry.id]);
    const saved = JSON.parse(await readFile(path.join(isolatedState, "mcp-servers.json"), "utf8"));
    expect(saved.servers.map((server: { id: string }) => server.id)).toEqual([retry.id]);
    const restored = new McpHostManager(isolatedState);
    managers.push(restored);
    expect((await restored.panelState()).servers.map((server) => server.id)).toEqual([retry.id]);
  });

  test("a failed atomic rename cannot leak its add into a queued successful save", async () => {
    const manager = new McpHostManager(f.state);
    managers.push(manager);
    await manager.panelState();
    const originalRename = fs.rename;
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    let enterSecond!: () => void;
    const firstSaving = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const heldRename = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondQueued = new Promise<void>((resolve) => {
      enterSecond = resolve;
    });
    const store = manager as unknown as { persist: (addition?: McpMountConfig) => Promise<void> };
    const originalPersist = store.persist.bind(manager);
    let saves = 0;
    const queue = spyOn(store, "persist").mockImplementation((addition) => {
      const saving = originalPersist(addition);
      if (++saves === 2) enterSecond();
      return saving;
    });
    let failed = false;
    const renameFailure = spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (!failed && target === path.join(f.state, "mcp-servers.json")) {
        failed = true;
        enterFirst();
        await heldRename;
        throw Object.assign(new Error("synthetic rename denied"), { code: "EACCES" });
      }
      return originalRename(source, target);
    });
    try {
      const first = manager.addStdio({ name: "未保存服務", command: "synthetic-program" });
      await firstSaving;
      expect((await manager.panelState()).servers).toEqual([]);
      const second = manager.addHttp({ name: "保存服務", url: "https://example.test/mcp" });
      await secondQueued;
      releaseFirst();
      const results = await Promise.allSettled([first, second]);
      expect(failed).toBe(true);
      expect(results[0]?.status).toBe("rejected");
      expect(results[1]?.status).toBe("fulfilled");
      const current = await manager.panelState();
      expect(current.servers.map((server) => server.name)).toEqual(["保存服務"]);
      const saved = JSON.parse(await readFile(path.join(f.state, "mcp-servers.json"), "utf8"));
      expect(saved.servers.map((server: { name: string }) => server.name)).toEqual(["保存服務"]);
      expect((await readdir(f.state)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      const retry = await manager.addStdio({ name: "重試服務", command: "synthetic-program" });
      expect((await manager.panelState()).servers.map((server) => server.name)).toEqual([
        "保存服務",
        retry.name,
      ]);
    } finally {
      releaseFirst();
      renameFailure.mockRestore();
      queue.mockRestore();
    }
  });

  test("concurrent adds reserve the sixteen-server limit before persistence finishes", async () => {
    const manager = new McpHostManager(f.state);
    managers.push(manager);
    await manager.panelState();
    const results = await Promise.allSettled(
      Array.from({ length: 17 }, (_, index) =>
        manager.addHttp({ name: `合成服務 ${index}`, url: "https://example.test/mcp" }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(16);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "MCP_SERVER_LIMIT" });
    const current = await manager.panelState();
    expect(current.servers).toHaveLength(16);
    expect(new Set(current.servers.map((server) => server.id)).size).toBe(16);
    const restored = new McpHostManager(f.state);
    managers.push(restored);
    expect((await restored.panelState()).servers.map((server) => server.id)).toEqual(
      current.servers.map((server) => server.id),
    );
  });

  test("trusted panel fingerprints parsed launch configuration without exposing its contents", async () => {
    const manager = new McpHostManager(f.state);
    managers.push(manager);
    const config = await manager.addStdio({
      name: "同名服務",
      command: "synthetic-program",
      args: ["synthetic-argument"],
      cwd: path.join(f.directory, "synthetic-directory"),
      env: ["SYNTHETIC_KEY"],
    });
    const first = await manager.panelState();
    const server = first.servers.find((item) => item.id === config.id);
    expect(server?.config_fingerprint).toBe(await mcpConfigFingerprint(config));
    const text = JSON.stringify(first);
    for (const privateValue of [
      "synthetic-program",
      "synthetic-argument",
      "synthetic-directory",
      "SYNTHETIC_KEY",
    ])
      expect(text).not.toContain(privateValue);
    await manager.addStdio({ name: "同名服務", command: "different-program" });
    const second = await manager.panelState();
    expect(new Set(second.servers.map((item) => item.config_fingerprint)).size).toBe(2);
    await manager.setServerEnabled(config.id, false);
    expect(
      (await manager.panelState()).servers.find((item) => item.id === config.id)
        ?.config_fingerprint,
    ).toBe(server?.config_fingerprint);
    const reloaded = new McpHostManager(f.state);
    managers.push(reloaded);
    expect(
      (await reloaded.panelState()).servers.find((item) => item.id === config.id)
        ?.config_fingerprint,
    ).toBe(server?.config_fingerprint);
  });
  test("trusts a newly mounted server by default without exposing launch configuration", async () => {
    const { manager, config, fixturePath } = await configured();
    const catalog = await manager.catalog({ query: "", limit: 30, refresh: false });

    expect(catalog.servers).toEqual([
      expect.objectContaining({
        id: config.id,
        name: "Read fixture",
        enabled: true,
        state: "ready",
        tool_count: 2,
        enabled_tool_count: 2,
      }),
    ]);
    expect(catalog.tools.map((tool) => tool.name).sort()).toEqual(["lookup", "mutate"]);
    expect(catalog.tools.every((tool) => tool.enabled && tool.availability === "ready")).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain(fixturePath);
    expect(JSON.stringify(catalog)).not.toContain(process.execPath);
  });

  test("calls trusted action tools, enforces the read-only route and forwards images", async () => {
    const { manager, config } = await configured();
    const catalog = await manager.catalog({ query: "", limit: 10, refresh: false });
    const lookup = catalog.tools.find((tool) => tool.name === "lookup");
    const mutate = catalog.tools.find((tool) => tool.name === "mutate");
    if (!lookup || !mutate) throw new Error("fixture tools were not discovered");

    const described = await manager.describe(lookup.ref);
    expect(described.tool.input_schema).toMatchObject({
      type: "object",
      required: ["query"],
    });

    const requestId = crypto.randomUUID();
    const result = await manager.call({
      tool_ref: lookup.ref,
      catalog_revision: catalog.catalog_revision,
      arguments: { query: "喵" },
      request_id: requestId,
    });
    expect(result).toMatchObject({
      kind: "mcp_call",
      request_id: requestId,
      is_error: false,
      content: [{ type: "text", text: "fixture:喵" }],
      structured_content: { echoed: "喵" },
      truncated: false,
    });
    expect(
      await manager.call({
        tool_ref: lookup.ref,
        catalog_revision: catalog.catalog_revision,
        arguments: { query: "喵" },
        request_id: requestId,
      }),
    ).toEqual(result);

    const screenshot = await manager.callWithMedia(
      {
        tool_ref: lookup.ref,
        catalog_revision: catalog.catalog_revision,
        arguments: { query: "image" },
        request_id: crypto.randomUUID(),
      },
      true,
    );
    expect(screenshot.data.content).toEqual([
      {
        type: "image",
        media_id: expect.any(String),
        mime_type: "image/png",
        byte_length: 68,
        width: 1,
        height: 1,
      },
    ]);
    expect(screenshot.images).toEqual([
      expect.objectContaining({
        type: "image",
        mimeType: "image/png",
        mediaId: expect.any(String),
      }),
    ]);
    expect(screenshot.data.arguments_preview).toEqual({ query: "image" });
    expect(screenshot.data.duration_ms).toBeGreaterThanOrEqual(0);
    const mediaId =
      screenshot.data.content[0]?.type === "image" ? screenshot.data.content[0].media_id : "";
    expect(manager.media(mediaId)).toMatchObject({ mimeType: "image/png" });
    expect(JSON.stringify(screenshot.data)).not.toContain("iVBORw0KGgo");

    const mutation = await manager.call({
      tool_ref: mutate.ref,
      catalog_revision: catalog.catalog_revision,
      arguments: { value: "run" },
      request_id: crypto.randomUUID(),
    });
    expect(mutation.content).toEqual([{ type: "text", text: "must not be called" }]);
    await expect(
      manager.callWithMedia(
        {
          tool_ref: mutate.ref,
          catalog_revision: catalog.catalog_revision,
          arguments: { value: "compatibility check" },
          request_id: crypto.randomUUID(),
        },
        true,
      ),
    ).rejects.toThrow("未明確宣告為唯讀");

    const hiddenLocalResource = await manager.call({
      tool_ref: lookup.ref,
      catalog_revision: catalog.catalog_revision,
      arguments: { query: "local-link" },
      request_id: crypto.randomUUID(),
    });
    expect(hiddenLocalResource).toMatchObject({
      content: [{ type: "text", text: "下游 MCP 回傳了不安全的資源連結；內容已省略。" }],
      truncated: true,
    });
    expect(JSON.stringify(hiddenLocalResource)).not.toContain("C:/Users/example");

    await manager.setToolEnabled(config.id, "mutate", false);
    const disabled = await manager.catalog({ query: "mutate", limit: 10, refresh: false });
    expect(disabled.tools[0]).toMatchObject({ enabled: false, availability: "disabled" });
    await expect(
      manager.call({
        tool_ref: mutate.ref,
        catalog_revision: disabled.catalog_revision,
        arguments: { value: "blocked" },
        request_id: crypto.randomUUID(),
      }),
    ).rejects.toThrow("本機使用者停用");
  });

  test("each request_id reaches the downstream server at most once", async () => {
    const { manager } = await configured();
    const catalog = await manager.catalog({ query: "", limit: 10, refresh: false });
    const lookup = required(catalog.tools.find((tool) => tool.name === "lookup"));
    const originalCallTool = Client.prototype.callTool;
    const call = spyOn(Client.prototype, "callTool");
    const input = (request_id: string, query = "once") => ({
      tool_ref: lookup.ref,
      catalog_revision: catalog.catalog_revision,
      arguments: { query },
      request_id,
    });
    const settled = (promise: Promise<unknown>) =>
      promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    try {
      // Identical concurrent calls await the first attempt instead of sending again.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      call.mockImplementationOnce(async function (this: Client, ...args) {
        await gate;
        return originalCallTool.apply(this, args);
      });
      const first = crypto.randomUUID();
      const leader = manager.call(input(first));
      for (let index = 0; index < 200 && call.mock.calls.length === 0; index++) await Bun.sleep(1);
      expect(call).toHaveBeenCalledTimes(1);
      const follower = manager.call(input(first));
      await expect(manager.call(input(first, "different"))).rejects.toMatchObject({
        code: "MCP_REQUEST_ID_CONFLICT",
      });
      await expect(manager.callWithMedia(input(first), true)).rejects.toMatchObject({
        code: "MCP_REQUEST_ID_CONFLICT",
      });
      release();
      const [leaderResult, followerResult] = await Promise.all([leader, follower]);
      expect(leaderResult).toMatchObject({
        request_id: first,
        content: [{ text: "fixture:once" }],
      });
      expect(followerResult).toEqual(leaderResult);
      // A retry after a catalog refresh is still the same call and is answered locally.
      expect(await manager.call({ ...input(first), catalog_revision: "later-revision" })).toEqual(
        leaderResult,
      );
      expect(call).toHaveBeenCalledTimes(1);

      // A failure after sending makes every retry of that request_id uncertain, never re-sent.
      let fail: (error: Error) => void = () => {};
      call.mockImplementationOnce(
        () =>
          new Promise<never>((_resolve, reject) => {
            fail = reject;
          }),
      );
      const uncertain = crypto.randomUUID();
      const attempt = settled(manager.call(input(uncertain)));
      for (let index = 0; index < 200 && call.mock.calls.length === 1; index++) await Bun.sleep(1);
      expect(call).toHaveBeenCalledTimes(2);
      const waiting = settled(manager.call(input(uncertain)));
      fail(new Error("synthetic-private-transport-failure"));
      const [attemptOutcome, waitingOutcome] = await Promise.all([attempt, waiting]);
      expect(attemptOutcome).toMatchObject({ error: { code: "MCP_CALL_FAILED" } });
      expect(waitingOutcome).toMatchObject({ error: { code: "MCP_CALL_UNKNOWN" } });
      const retry = await settled(manager.call(input(uncertain)));
      expect(retry).toMatchObject({ error: { code: "MCP_CALL_UNKNOWN" } });
      expect(JSON.stringify([attemptOutcome, waitingOutcome, retry])).not.toContain(
        "synthetic-private",
      );
      await expect(manager.call(input(uncertain, "different"))).rejects.toMatchObject({
        code: "MCP_REQUEST_ID_CONFLICT",
      });
      expect(call).toHaveBeenCalledTimes(2);

      // A call rejected before sending leaves its request_id free for the corrected retry.
      const stale = crypto.randomUUID();
      await expect(
        manager.call({ ...input(stale), catalog_revision: "stale" }),
      ).rejects.toMatchObject({ code: "MCP_CATALOG_STALE" });
      expect(call).toHaveBeenCalledTimes(2);
      expect(await manager.call(input(stale))).toMatchObject({ request_id: stale });
      expect(call).toHaveBeenCalledTimes(3);

      // Once the bounded result cache drops a completed call, retries still are not re-sent.
      const later = Date.now() + 6 * 60_000;
      const clock = spyOn(Date, "now").mockImplementation(() => later);
      try {
        await expect(manager.call(input(first))).rejects.toMatchObject({
          code: "MCP_RESULT_EXPIRED",
        });
      } finally {
        clock.mockRestore();
      }
      expect(call).toHaveBeenCalledTimes(3);
    } finally {
      call.mockRestore();
    }
  });

  test("request_id records stay bounded and evict the least recently used first", async () => {
    const { manager } = await configured();
    const catalog = await manager.catalog({ query: "", limit: 10, refresh: false });
    const lookup = required(catalog.tools.find((tool) => tool.name === "lookup"));
    const call = spyOn(Client.prototype, "callTool").mockImplementation(async () => ({
      content: [{ type: "text", text: "synthetic" }],
      structuredContent: { echoed: "synthetic" },
    }));
    const input = (request_id: string) => ({
      tool_ref: lookup.ref,
      catalog_revision: catalog.catalog_revision,
      arguments: { query: "bounded" },
      request_id,
    });
    try {
      const oldest = crypto.randomUUID();
      const touched = crypto.randomUUID();
      await manager.call(input(oldest));
      await manager.call(input(touched));
      for (let index = 0; index < 4094; index++) await manager.call(input(crypto.randomUUID()));
      expect(call).toHaveBeenCalledTimes(4096);
      // Touching a record makes it most recently used; one more call evicts only the oldest.
      await expect(manager.call(input(touched))).rejects.toMatchObject({
        code: "MCP_RESULT_EXPIRED",
      });
      await manager.call(input(crypto.randomUUID()));
      expect(call).toHaveBeenCalledTimes(4097);
      await expect(manager.call(input(touched))).rejects.toMatchObject({
        code: "MCP_RESULT_EXPIRED",
      });
      expect(call).toHaveBeenCalledTimes(4097);
      // The evicted record is the documented bound: that request_id is no longer remembered.
      await manager.call(input(oldest));
      expect(call).toHaveBeenCalledTimes(4098);
    } finally {
      call.mockRestore();
    }
  }, 30000);

  test("validates arguments and stale revisions, then persists tool and server switches", async () => {
    const { manager, config } = await configured();
    const catalog = await manager.catalog({ query: "lookup", limit: 10, refresh: false });
    const tool = catalog.tools[0];
    if (!tool) throw new Error("lookup was not discovered");

    await expect(
      manager.call({
        tool_ref: tool.ref,
        catalog_revision: "stale",
        arguments: { query: "test" },
        request_id: crypto.randomUUID(),
      }),
    ).rejects.toThrow("MCP 目錄已變更");
    await expect(
      manager.call({
        tool_ref: tool.ref,
        catalog_revision: catalog.catalog_revision,
        arguments: {},
        request_id: crypto.randomUUID(),
      }),
    ).rejects.toThrow("參數不符合");

    await manager.setToolEnabled(config.id, "lookup", false);
    await manager.close();
    managers = managers.filter((item) => item !== manager);
    const restored = new McpHostManager(f.state);
    managers.push(restored);
    const next = await restored.catalog({ query: "lookup", limit: 10, refresh: false });
    expect(next.tools[0]).toMatchObject({
      name: "lookup",
      enabled: false,
      availability: "disabled",
    });

    await restored.setServerEnabled(config.id, false);
    const disabledServer = await restored.panelState();
    expect(disabledServer.servers[0]).toMatchObject({ enabled: false, state: "disconnected" });
    expect(
      (await restored.catalog({ query: "", limit: 10, refresh: false })).servers[0],
    ).toMatchObject({ enabled: false, enabled_tool_count: 0 });
    await restored.setServerEnabled(config.id, true);
    const reconnected = await restored.panelState();
    expect(reconnected.servers[0]).toMatchObject({ enabled: true, state: "ready" });
    expect(reconnected.servers[0]?.tools.find((item) => item.name === "lookup")?.enabled).toBe(
      false,
    );

    const saved = JSON.parse(await readFile(path.join(f.state, "mcp-servers.json"), "utf8"));
    expect(saved.servers[0]).toMatchObject({ enabled: true, disabled_tools: ["lookup"] });
  });

  test("does not follow redirects from an HTTP MCP", async () => {
    let redirectedRequests = 0;
    let targetPort = 0;
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request): Response {
        if (new URL(request.url).pathname === "/redirected") {
          redirectedRequests++;
          return new Response("must not be reached");
        }
        return Response.redirect(`http://127.0.0.1:${targetPort}/redirected`, 307);
      },
    });
    const boundPort = target.port;
    if (!boundPort) {
      target.stop(true);
      throw new Error("Redirect fixture did not bind a TCP port");
    }
    targetPort = boundPort;
    try {
      const manager = new McpHostManager(f.state);
      managers.push(manager);
      const config = await manager.addHttp({
        name: "Redirect fixture",
        url: `http://127.0.0.1:${target.port}/mcp`,
      });
      await manager.refresh(config.id);
      expect((await manager.localState())[0]?.state).toBe("unavailable");
      expect(redirectedRequests).toBe(0);
    } finally {
      target.stop(true);
    }
  });
});
