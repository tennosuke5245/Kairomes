import { afterEach, describe, expect, test } from "bun:test";
import { MCP_AUTH_LIMITS, type McpAuthInput, type McpAuthResult } from "@kairomes/protocol";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { McpOAuthManager, type McpOAuthTarget } from "./mcp-oauth.ts";

const managers: McpOAuthManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("合成測試缺少必要值。");
  return value;
}
async function until(predicate: () => boolean) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("合成流程未在期限內完成。");
}

function setup(
  options: {
    verify?: "current" | "list_failed" | "connection_failed";
    browserFail?: boolean;
    tokenGate?: ReturnType<typeof deferred>;
    unsupported?: boolean;
    blocked?: boolean;
  } = {},
) {
  let time = Date.now();
  let valid = true;
  const instance = crypto.randomUUID();
  const target: McpOAuthTarget = {
    id: crypto.randomUUID(),
    fingerprint: "a".repeat(64),
    url: "https://mcp.synthetic.test/mcp",
    enabled: true,
  };
  const targets = new Map([[target.id, target]]);
  const browsers: URL[] = [];
  let registrations = 0;
  let tokens = 0;
  let verifications = 0;
  const fetcher: NonNullable<Parameters<typeof auth>[1]["fetchFn"]> = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/register") {
      registrations++;
      return Response.json({ ...JSON.parse(String(init?.body)), client_id: "synthetic-client" });
    }
    if (url.pathname === "/token") {
      tokens++;
      if (options.tokenGate) await options.tokenGate.promise;
      return Response.json({
        access_token: "synthetic-access",
        token_type: "Bearer",
        refresh_token: `synthetic-refresh-${tokens}`,
        expires_in: 3600,
      });
    }
    if (url.pathname.includes("oauth-protected-resource")) {
      return Response.json({
        resource: target.url,
        authorization_servers: ["https://auth.synthetic.test"],
        scopes_supported: ["read"],
      });
    }
    return Response.json({
      issuer: "https://auth.synthetic.test/",
      authorization_endpoint: "https://auth.synthetic.test/authorize",
      token_endpoint: "https://auth.synthetic.test/token",
      registration_endpoint: "https://auth.synthetic.test/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: [options.unsupported ? "plain" : "S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  };
  const manager = new McpOAuthManager({
    now: () => time,
    networkFactory: () => ({
      fetch: fetcher,
      oauthFetch: fetcher,
      mcpFetch: fetcher,
      validateAuthorizationTarget: async (url) => {
        if (options.blocked)
          throw Object.assign(new Error("合成網路已被拒絕。"), { code: "MCP_OAUTH_DNS_BLOCKED" });
        return new URL(url);
      },
    }),
  });
  managers.push(manager);
  manager.configure({
    instanceId: instance,
    ownerValid: () => valid,
    target: (id) => targets.get(id),
    openBrowser: async (url) => {
      if (options.browserFail) throw new Error("synthetic-private-browser-error");
      browsers.push(new URL(url));
    },
    disconnect: async () => {},
    verify: async () => {
      verifications++;
      return options.verify ?? "current";
    },
  });
  const input = (
    action: "start" | "cancel" | "forget" = "start",
    selected = target,
  ): Exclude<McpAuthInput, { action: "status" }> => ({
    action,
    instance_id: instance,
    server_id: selected.id,
    config_fingerprint: selected.fingerprint,
    operation_id: crypto.randomUUID(),
    accept_before: new Date(time + 30_000).toISOString(),
  });
  const status = (
    original: Exclude<McpAuthInput, { action: "status" }>,
    owner = "owner",
  ): McpAuthResult =>
    manager.operation(owner, {
      action: "status",
      instance_id: original.instance_id,
      server_id: original.server_id,
      config_fingerprint: original.config_fingerprint,
      operation_id: original.operation_id,
      operation: original.action === "forget" ? "forget" : "login",
    });
  const callback = (browser = browsers[0]) => {
    if (!browser) throw new Error("合成瀏覽器尚未開啟。");
    const url = new URL(browser.searchParams.get("redirect_uri") ?? "");
    url.searchParams.set("state", browser.searchParams.get("state") ?? "");
    url.searchParams.set("code", "synthetic-code");
    return url;
  };
  return {
    manager,
    target,
    targets,
    browsers,
    input,
    status,
    callback,
    fetcher,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    revoke: () => {
      valid = false;
      manager.revokeOwner("owner");
    },
    counts: () => ({ registrations, tokens, verifications }),
  };
}

describe("MCP 當次登入管理", () => {
  test("背景探測可確認登入需求，但不註冊或開啟瀏覽器", async () => {
    const f = setup();
    const transport = f.manager.transport(f.target);
    expect(transport).toBeDefined();
    await expect(
      auth(required(transport).authProvider, {
        serverUrl: f.target.url,
        fetchFn: required(transport).fetch,
      }),
    ).rejects.toMatchObject({ code: "MCP_AUTH_REQUIRED" });
    expect(f.manager.summary(f.target.id)).toMatchObject({
      auth_phase: "required",
      tools_status: "unknown",
      login_domain: "auth.synthetic.test",
    });
    expect(f.counts()).toEqual({ registrations: 0, tokens: 0, verifications: 0 });
    expect(f.browsers).toHaveLength(0);
    await expect(f.manager.beforeCall(f.target.id)).rejects.toMatchObject({
      code: "MCP_AUTH_REQUIRED",
    });
  });

  test("開始收據精確去重，取消先到可阻止晚開始，身份與期限不可改寫", async () => {
    const f = setup();
    const first = f.input();
    expect(f.manager.operation("owner", { ...first, action: "cancel" }).receipt_outcome).toBe(
      "cancelled",
    );
    expect(f.manager.operation("owner", first).receipt_outcome).toBe("cancelled");
    expect(f.browsers).toHaveLength(0);
    expect(() =>
      f.manager.operation("owner", {
        ...first,
        accept_before: new Date(Date.parse(first.accept_before) - 1).toISOString(),
      }),
    ).toThrow();
    expect(f.status(first, "different-owner").receipt_outcome).toBe("missing");
    const second = f.input();
    f.manager.operation("owner", second);
    await until(() => f.browsers.length === 1);
    expect(f.manager.operation("owner", second).receipt_outcome).toBe("pending");
    expect(f.counts().registrations).toBe(1);
    expect(f.browsers).toHaveLength(1);
    expect(() => f.manager.operation("owner", f.input())).toThrow();
  });

  test("實際回呼 listener 拒絕錯方法、Host、路徑、重複參數、state 與 issuer且保留原嘗試", async () => {
    const f = setup();
    const original = f.input();
    f.manager.operation("owner", original);
    await until(() => f.browsers.length === 1);
    const callback = f.callback();
    expect((await fetch(callback, { method: "POST" })).status).toBe(400);
    expect((await fetch(callback, { headers: { Host: "invalid.synthetic.test" } })).status).toBe(
      400,
    );
    const path = new URL(callback);
    path.pathname = "/wrong";
    expect((await fetch(path)).status).toBe(400);
    const duplicate = new URL(callback);
    duplicate.searchParams.append("code", "synthetic-other");
    expect((await fetch(duplicate)).status).toBe(400);
    const unicode = new URL(callback);
    unicode.searchParams.set(
      "state",
      "喵".repeat(required(required(f.browsers[0]).searchParams.get("state")).length),
    );
    expect((await fetch(unicode)).status).toBe(400);
    const issuer = new URL(callback);
    issuer.searchParams.set("iss", "https://wrong.synthetic.test/");
    expect((await fetch(issuer)).status).toBe(400);
    expect(f.status(original).receipt_outcome).toBe("pending");
    callback.searchParams.set("iss", "https://auth.synthetic.test");
    const response = await fetch(callback);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<main class="connected"');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(f.status(original)).toMatchObject({
      receipt_outcome: "completed",
      auth_phase: "authenticated",
      tools_status: "current",
    });
    expect(f.counts()).toEqual({ registrations: 1, tokens: 1, verifications: 1 });
    const safe = JSON.stringify(f.status(original));
    for (const secret of [
      "synthetic-access",
      "synthetic-refresh",
      "synthetic-code",
      "synthetic-client",
      "callback/",
    ])
      expect(safe).not.toContain(secret);
  });

  test("權杖交換後的清單與初始化失敗不冒稱工具已可用", async () => {
    for (const outcome of ["list_failed", "connection_failed"] as const) {
      const f = setup({ verify: outcome });
      const original = f.input();
      f.manager.operation("owner", original);
      await until(() => f.browsers.length === 1);
      await fetch(f.callback());
      expect(f.status(original)).toMatchObject({
        receipt_outcome: "completed",
        auth_phase: "authenticated",
        tools_status: "error",
        error_code: outcome === "list_failed" ? "tools_list_failed" : "connection_failed",
      });
    }
  });

  test("瀏覽器失敗與不支援 PKCE 回短錯誤，不輸出原始錯誤", async () => {
    for (const options of [{ browserFail: true }, { unsupported: true }]) {
      const f = setup(options);
      const original = f.input();
      f.manager.operation("owner", original);
      await until(() => f.status(original).receipt_outcome === "failed");
      expect(f.status(original).error_code).toBe(
        "browserFail" in options ? "browser_open_failed" : "auth_unsupported",
      );
      expect(JSON.stringify(f.status(original))).not.toContain("synthetic-private");
      expect(f.browsers).toHaveLength(0);
    }
  });

  test("背景已驗證 OAuth 但能力不支援時保留分類，缺少 resource 證據不冒稱登入", async () => {
    const f = setup({ unsupported: true });
    const transport = required(f.manager.transport(f.target));
    await expect(
      auth(transport.authProvider, { serverUrl: f.target.url, fetchFn: transport.fetch }),
    ).rejects.toMatchObject({ code: "MCP_AUTH_UNSUPPORTED" });
    f.manager.connectionResult(f.target.id, "connection_failed");
    expect(f.manager.summary(f.target.id)).toMatchObject({
      auth_phase: "error",
      tools_status: "unknown",
      error_code: "auth_unsupported",
    });
    expect(f.counts().registrations).toBe(0);
    const unknown = setup();
    const provider = required(unknown.manager.transport(unknown.target)).authProvider;
    expect(() =>
      provider.saveDiscoveryState?.({ authorizationServerUrl: "https://auth.synthetic.test/" }),
    ).toThrow();
    expect(unknown.manager.summary(unknown.target.id)).toBeUndefined();
  });

  test("取消或 owner 失效後，晚權杖回覆不能保存或完成登入", async () => {
    for (const revoke of [false, true]) {
      const gate = deferred();
      const f = setup({ tokenGate: gate });
      const original = f.input();
      f.manager.operation("owner", original);
      await until(() => f.browsers.length === 1);
      const response = fetch(f.callback());
      await until(() => f.counts().tokens === 1);
      if (revoke) f.revoke();
      else f.manager.operation("owner", { ...original, action: "cancel" });
      gate.release();
      expect((await response).status).toBe(400);
      expect(f.counts().verifications).toBe(0);
      expect(f.manager.summary(f.target.id)?.auth_phase).toBe("required");
      if (!revoke) expect(f.status(original).receipt_outcome).toBe("cancelled");
      const transport = required(f.manager.transport(f.target));
      expect(await transport.authProvider.tokens()).toBeUndefined();
    }
  });

  test("五分鐘登入逾時是 failed，收據到期仍保留已見 ID 防止重新登入", async () => {
    const f = setup();
    const original = f.input();
    f.manager.operation("owner", original);
    await until(() => f.browsers.length === 1);
    f.advance(MCP_AUTH_LIMITS.loginMs + 1);
    expect(f.status(original)).toMatchObject({
      receipt_outcome: "failed",
      error_code: "auth_expired",
    });
    f.advance(MCP_AUTH_LIMITS.receiptMs + 1);
    expect(f.status(original).receipt_outcome).toBe("expired");
    expect(f.manager.operation("owner", original).receipt_outcome).toBe("expired");
    expect(() =>
      f.manager.operation("owner", { ...original, accept_before: f.input().accept_before }),
    ).toThrow();
    expect(f.browsers).toHaveLength(1);
  });

  test("等待登入占四件容量，取消仍在途的權杖工作也不能提早釋放容量", async () => {
    const gate = deferred();
    const f = setup({ tokenGate: gate });
    const originals: Exclude<McpAuthInput, { action: "status" }>[] = [];
    for (let index = 0; index < 5; index++) {
      const target = { ...f.target, id: crypto.randomUUID() };
      f.targets.set(target.id, target);
      const original = f.input("start", target);
      originals.push(original);
      if (index < 4) {
        f.manager.operation("owner", original);
        await until(() => f.browsers.length === index + 1);
      } else expect(() => f.manager.operation("owner", original)).toThrow();
    }
    const responses = f.browsers.map((browser) => fetch(f.callback(browser)));
    await until(() => f.counts().tokens === 4);
    for (const original of originals.slice(0, 4))
      f.manager.operation("owner", { ...original, action: "cancel" });
    expect(() => f.manager.operation("owner", required(originals[4]))).toThrow();
    gate.release();
    await Promise.all(responses);
    await until(() => {
      try {
        return f.manager.operation("owner", required(originals[4])).receipt_outcome === "pending";
      } catch {
        return false;
      }
    });
  });

  test("refresh 單次共享，清除登入先 fence 晚 refresh，成功登入不因 owner 解除而清除", async () => {
    const gate = deferred();
    gate.release();
    const f = setup({ tokenGate: gate });
    const original = f.input();
    f.manager.operation("owner", original);
    await until(() => f.browsers.length === 1);
    await fetch(f.callback());
    f.advance(3600_000);
    await Promise.all([f.manager.beforeCall(f.target.id), f.manager.beforeCall(f.target.id)]);
    expect(f.counts().tokens).toBe(2);
    f.revoke();
    expect(await required(f.manager.transport(f.target)).authProvider.tokens()).toMatchObject({
      access_token: "synthetic-access",
    });
  });

  test("清除登入或要求重新登入先 fence 已在途 refresh，不可復活工具狀態", async () => {
    const options: { tokenGate?: ReturnType<typeof deferred> } = {};
    const f = setup(options);
    const original = f.input();
    f.manager.operation("owner", original);
    await until(() => f.browsers.length === 1);
    await fetch(f.callback());
    f.advance(3600_000);
    options.tokenGate = deferred();
    const pending = f.manager.beforeCall(f.target.id);
    const rejected = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await until(() => f.counts().tokens === 2);
    const provider = required(f.manager.transport(f.target)).authProvider;
    const forget = f.input("forget");
    f.manager.operation("owner", forget);
    await until(() => f.status(forget).receipt_outcome === "completed");
    options.tokenGate.release();
    expect(await rejected).toMatchObject({ code: "MCP_AUTH_REQUIRED" });
    expect(() =>
      provider.saveTokens({ access_token: "synthetic-late", token_type: "Bearer" }),
    ).toThrow();
    expect(f.manager.summary(f.target.id)).toMatchObject({
      auth_phase: "required",
      tools_status: "unknown",
    });
    const next = required(f.manager.transport(f.target)).authProvider;
    f.manager.requireLogin(f.target.id);
    expect(() =>
      next.saveTokens({ access_token: "synthetic-late", token_type: "Bearer" }),
    ).toThrow();
  });

  test("新 callback 端口會重新註冊，舊配置收據不能附上新配置工具成功狀態", async () => {
    const f = setup();
    const original = f.input();
    f.manager.operation("owner", original);
    await until(() => f.browsers.length === 1);
    await fetch(f.callback());
    expect(f.manager.summary(f.target.id, f.target.fingerprint)).toMatchObject({
      auth_phase: "authenticated",
      tools_status: "current",
    });
    expect(f.manager.summary(f.target.id, "b".repeat(64))).toBeUndefined();
    const next = f.input();
    f.manager.operation("owner", next);
    await until(() => f.browsers.length === 2);
    expect(f.counts().registrations).toBe(2);
    f.manager.operation("owner", { ...next, action: "cancel" });
    f.target.fingerprint = "b".repeat(64);
    f.manager.transport(f.target);
    expect(f.status(original)).toMatchObject({
      receipt_outcome: "completed",
      auth_phase: "required",
      tools_status: "stale",
      error_code: "configuration_changed",
    });
  });

  test("rich 與 retired ID 容量有界，既有取消與查詢仍可用，不驅逐已見身份", () => {
    const f = setup();
    const original = f.input("cancel");
    f.manager.operation("owner", original);
    for (let index = 1; index < MCP_AUTH_LIMITS.receipts; index++)
      f.manager.operation("owner", f.input("cancel"));
    expect(() => f.manager.operation("owner", f.input("cancel"))).toThrow();
    expect(f.manager.operation("owner", original).receipt_outcome).toBe("cancelled");
    f.advance(MCP_AUTH_LIMITS.receiptMs + 1);
    for (let index = MCP_AUTH_LIMITS.receipts; index < MCP_AUTH_LIMITS.retiredIds; index++) {
      if (index % MCP_AUTH_LIMITS.receipts === 0) f.advance(MCP_AUTH_LIMITS.receiptMs + 1);
      f.manager.operation("owner", f.input("cancel"));
    }
    f.advance(MCP_AUTH_LIMITS.receiptMs + 1);
    expect(() => f.manager.operation("owner", f.input("cancel"))).toThrow();
    expect(f.status(original).receipt_outcome).toBe("expired");
    expect(f.manager.operation("owner", original).receipt_outcome).toBe("expired");
  });

  test("公開端點已確認 OAuth 後 DNS 變成私網，不能退回 legacy 或復用憑證", async () => {
    const options = { blocked: false };
    const f = setup(options);
    const transport = await f.manager.prepareTransport(f.target);
    await auth(required(transport).authProvider, {
      serverUrl: f.target.url,
      fetchFn: required(transport).fetch,
    }).catch(() => undefined);
    expect(f.manager.summary(f.target.id)?.auth_phase).toBe("required");
    options.blocked = true;
    await expect(f.manager.prepareTransport(f.target)).rejects.toMatchObject({
      code: "MCP_OAUTH_DNS_BLOCKED",
    });
    expect(f.counts().registrations).toBe(0);
    expect(f.browsers).toHaveLength(0);
  });

  test("平行 SDK refresh 已讀舊 RT 而延後 POST，仍共享一次交換，退休 RT 不再送出", async () => {
    const f = setup();
    const original = f.input();
    f.manager.operation("owner", original);
    await until(() => f.browsers.length === 1);
    await fetch(f.callback());
    const transport = required(f.manager.transport(f.target));
    const gate = deferred();
    let tokenPosts = 0;
    let oldInput: string | URL | undefined;
    let oldInit: RequestInit | undefined;
    const delayed: typeof transport.fetch = async (input, init) => {
      if (new URL(input).pathname === "/token") {
        tokenPosts++;
        if (tokenPosts === 2) {
          oldInput = input;
          oldInit = init;
          await gate.promise;
        }
      }
      return transport.fetch(input, init);
    };
    const first = auth(transport.authProvider, { serverUrl: f.target.url, fetchFn: delayed });
    const second = auth(transport.authProvider, { serverUrl: f.target.url, fetchFn: delayed });
    await until(() => tokenPosts === 2);
    expect(await first).toBe("AUTHORIZED");
    gate.release();
    expect(await second).toBe("AUTHORIZED");
    expect(f.counts().tokens).toBe(2);
    expect(await transport.authProvider.tokens()).toMatchObject({
      refresh_token: "synthetic-refresh-2",
    });
    expect(
      await auth(transport.authProvider, { serverUrl: f.target.url, fetchFn: transport.fetch }),
    ).toBe("AUTHORIZED");
    expect(f.counts().tokens).toBe(3);
    await expect(transport.fetch(required(oldInput), oldInit)).rejects.toMatchObject({
      code: "MCP_AUTH_REQUIRED",
    });
    expect(f.counts().tokens).toBe(3);
    expect(f.browsers).toHaveLength(1);
  });

  test("Host 關閉與配置變更同步拒絕所有舊 provider 寫入", async () => {
    for (const closing of [true, false]) {
      const f = setup();
      const original = f.input();
      f.manager.operation("owner", original);
      await until(() => f.browsers.length === 1);
      const provider = required(f.manager.transport(f.target)).authProvider;
      if (closing) f.manager.close();
      else {
        f.target.fingerprint = "b".repeat(64);
        f.manager.transport(f.target);
      }
      expect(() =>
        provider.saveTokens({ access_token: "synthetic-late", token_type: "Bearer" }),
      ).toThrow();
      expect(() => provider.saveClientInformation?.({ client_id: "synthetic-late" })).toThrow();
      expect(() => provider.saveCodeVerifier("synthetic-late")).toThrow();
      expect(() => provider.discoveryState?.()).toThrow();
    }
  });
});
