import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  KairomesError,
  MCP_AUTH_LIMITS,
  type McpAuthInput,
  type McpAuthResult,
  type McpAuthSummary,
} from "@kairomes/protocol";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpOAuthNetwork } from "./mcp-oauth-network.ts";
import { mcpOAuthCallbackResponse } from "./mcp-oauth-page.ts";

type OAuthNetwork = {
  fetch: FetchLike;
  oauthFetch: FetchLike;
  mcpFetch: FetchLike;
  validateAuthorizationTarget(input: string | URL): Promise<URL>;
};
export type McpOAuthDependencies = {
  networkFactory?: (endpoint: string) => OAuthNetwork;
  authenticate?: typeof auth;
  now?: () => number;
};
export type McpOAuthTarget = { id: string; fingerprint: string; url: string; enabled: boolean };
type Context = {
  instanceId: string;
  openBrowser?: (url: string) => Promise<void>;
  ownerValid: (owner: string) => boolean;
  target: (serverId: string) => McpOAuthTarget | undefined;
  verify: (target: McpOAuthTarget) => Promise<"current" | "list_failed" | "connection_failed">;
  disconnect: (serverId: string) => Promise<void>;
};
type Receipt = {
  owner: string;
  input: Exclude<McpAuthInput, { action: "status" }>;
  operation: "login" | "forget";
  outcome: McpAuthResult["receipt_outcome"];
  finishedAt?: number;
  rich: boolean;
};
type Attempt = {
  receipt: Receipt;
  epoch: number;
  state: string;
  verifier?: string;
  listener: ReturnType<typeof Bun.serve>;
  redirect: string;
  timer: ReturnType<typeof setTimeout>;
  callbackUsed: boolean;
  expiresAt: number;
};
type RecordState = {
  target: McpOAuthTarget;
  epoch: number;
  summary?: McpAuthSummary;
  network: OAuthNetwork;
  discovery?: OAuthDiscoveryState;
  issuer?: string;
  resource?: string;
  client?: OAuthClientInformationMixed;
  registrationRedirect?: string;
  tokens?: OAuthTokens;
  expiresAt?: number;
  attempt?: Attempt;
  refresh?: Promise<void>;
  toolsKnown?: boolean;
  refreshResponse?: { epoch: number; key: string; promise: Promise<Response>; committed: boolean };
};

function failure(code: string): KairomesError {
  return new KairomesError(code, "MCP 登入未完成。");
}
function sameUrl(left: string | URL, right: string | URL) {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}
function safeCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "MCP_AUTH_UNSUPPORTED") return "auth_unsupported";
  if (code === "MCP_AUTH_BROWSER") return "browser_open_failed";
  if (code === "MCP_AUTH_REQUIRED" || code === "MCP_AUTH_SCOPE_REQUIRED") return "auth_required";
  if (
    ["MCP_OAUTH_URL_BLOCKED", "MCP_OAUTH_DNS_BLOCKED", "MCP_OAUTH_REDIRECT_BLOCKED"].includes(
      String(code),
    )
  )
    return "network_blocked";
  return "auth_failed";
}

/** Session-only credentials. Public methods return only identity-bound, safe summaries. */
export class McpOAuthManager {
  private context?: Context;
  private closed = false;
  private records = new Map<string, RecordState>();
  private receipts = new Map<string, Receipt>();
  private jobs = new Map<Receipt, number>();
  private readonly authenticate: typeof auth;
  private readonly now: () => number;
  private readonly networkFactory: (endpoint: string) => OAuthNetwork;

  constructor(deps: McpOAuthDependencies = {}) {
    this.authenticate = deps.authenticate ?? auth;
    this.now = deps.now ?? Date.now;
    this.networkFactory = deps.networkFactory ?? createMcpOAuthNetwork;
  }

  configure(context: Context) {
    if (this.context && this.context.instanceId !== context.instanceId) this.close();
    this.context = context;
  }

  private record(target: McpOAuthTarget): RecordState {
    let record = this.records.get(target.id);
    if (record && record.target.fingerprint !== target.fingerprint) {
      this.invalidate(target.id, true);
      record = undefined;
    }
    if (!record) {
      record = {
        target: structuredClone(target),
        epoch: 0,
        network: this.networkFactory(target.url),
      };
      this.records.set(target.id, record);
    }
    record.target = structuredClone(target);
    return record;
  }

  summary(serverId: string, expectedFingerprint?: string): McpAuthSummary | undefined {
    const record = this.records.get(serverId);
    if (expectedFingerprint !== undefined && record?.target.fingerprint !== expectedFingerprint)
      return undefined;
    const value = record?.summary;
    return value ? structuredClone(value) : undefined;
  }

  generation(serverId: string): number | undefined {
    return this.records.get(serverId)?.epoch;
  }
  pending(serverId: string): boolean {
    return this.records.get(serverId)?.attempt !== undefined;
  }

  private update(record: RecordState, values: Omit<McpAuthSummary, "phase_version">) {
    record.summary = { ...values, phase_version: (record.summary?.phase_version ?? 0) + 1 };
  }

  private assert(record: RecordState, epoch: number, attempt?: Attempt) {
    const current = this.context?.target(record.target.id);
    if (
      this.closed ||
      record.epoch !== epoch ||
      this.records.get(record.target.id) !== record ||
      !current?.enabled ||
      current.fingerprint !== record.target.fingerprint ||
      (attempt &&
        (record.attempt !== attempt ||
          attempt.receipt.outcome !== "pending" ||
          !this.context?.ownerValid(attempt.receipt.owner)))
    )
      throw failure("MCP_AUTH_STALE");
  }

  private finish(record: RecordState, receipt: Receipt, outcome: Receipt["outcome"]) {
    if (receipt.outcome !== "pending") return;
    receipt.outcome = outcome;
    receipt.finishedAt = this.now();
    if (record.attempt?.receipt === receipt) {
      if (outcome !== "completed") {
        record.tokens = undefined;
        record.expiresAt = undefined;
        record.refreshResponse = undefined;
      }
      clearTimeout(record.attempt.timer);
      record.attempt.listener.stop(false);
      record.attempt.verifier = undefined;
      record.attempt = undefined;
    }
  }

  invalidate(serverId: string, clear = false) {
    const record = this.records.get(serverId);
    if (!record) return;
    record.epoch++;
    if (record.attempt) this.finish(record, record.attempt.receipt, "cancelled");
    record.refresh = undefined;
    record.refreshResponse = undefined;
    record.tokens = undefined;
    record.expiresAt = undefined;
    if (clear) {
      record.client = undefined;
      record.registrationRedirect = undefined;
      record.discovery = undefined;
      record.issuer = undefined;
      record.resource = undefined;
    }
    if (record.summary)
      this.update(record, {
        auth_phase: "required",
        tools_status: record.toolsKnown ? "stale" : "unknown",
      });
  }

  revokeOwner(owner: string) {
    for (const record of this.records.values()) {
      if (record.attempt?.receipt.owner === owner) this.invalidate(record.target.id);
    }
  }

  close() {
    this.closed = true;
    for (const id of this.records.keys()) this.invalidate(id, true);
    this.records.clear();
  }

  private prune() {
    for (const record of this.records.values()) {
      if (record.attempt && this.now() >= record.attempt.expiresAt) {
        record.epoch++;
        this.update(record, {
          auth_phase: "error",
          tools_status: record.toolsKnown ? "stale" : "unknown",
          error_code: "auth_expired",
        });
        this.finish(record, record.attempt.receipt, "failed");
      }
    }
    for (const receipt of this.receipts.values()) {
      if (
        receipt.finishedAt !== undefined &&
        this.now() - receipt.finishedAt >= MCP_AUTH_LIMITS.receiptMs
      )
        receipt.rich = false;
    }
  }

  private key(owner: string, operationId: string) {
    return `${owner}\0${operationId}`;
  }

  private job(receipt: Receipt, delta: number) {
    const count = (this.jobs.get(receipt) ?? 0) + delta;
    if (count > 0) this.jobs.set(receipt, count);
    else this.jobs.delete(receipt);
  }

  private result(input: McpAuthInput, receipt?: Receipt): McpAuthResult {
    const record = this.records.get(input.server_id);
    const matching = record?.target.fingerprint === input.config_fingerprint;
    const summary = (matching ? this.summary(input.server_id) : undefined) ?? {
      auth_phase: "required" as const,
      tools_status: record ? ("stale" as const) : ("unknown" as const),
      phase_version: 0,
      ...(record && !matching ? { error_code: "configuration_changed" } : {}),
    };
    return {
      ...summary,
      instance_id: input.instance_id,
      server_id: input.server_id,
      config_fingerprint: input.config_fingerprint,
      operation_id: input.operation_id,
      operation:
        input.action === "status"
          ? input.operation
          : input.action === "forget"
            ? "forget"
            : "login",
      receipt_outcome: !receipt ? "missing" : receipt.rich ? receipt.outcome : "expired",
    };
  }

  operation(owner: string, input: McpAuthInput): McpAuthResult {
    if (this.closed || !this.context || input.instance_id !== this.context.instanceId)
      throw failure("MCP_AUTH_STALE");
    if (!this.context.ownerValid(owner)) throw failure("MCP_AUTH_OWNER_INVALID");
    this.prune();
    const key = this.key(owner, input.operation_id);
    const prior = this.receipts.get(key);
    if (input.action === "status") {
      const matches =
        prior &&
        prior.operation === input.operation &&
        prior.input.instance_id === input.instance_id &&
        prior.input.server_id === input.server_id &&
        prior.input.config_fingerprint === input.config_fingerprint;
      return this.result(input, matches ? prior : undefined);
    }
    const operation = input.action === "forget" ? "forget" : "login";
    if (prior) {
      const original = prior.input;
      if (
        prior.operation !== operation ||
        original.instance_id !== input.instance_id ||
        original.server_id !== input.server_id ||
        original.config_fingerprint !== input.config_fingerprint ||
        original.accept_before !== input.accept_before
      )
        throw failure("MCP_AUTH_ID_CONFLICT");
      if (input.action === "cancel" && prior.outcome === "pending") {
        const record = this.records.get(input.server_id);
        if (record?.attempt?.receipt === prior) {
          record.epoch++;
          this.finish(record, prior, "cancelled");
          this.update(record, {
            auth_phase: "required",
            tools_status: record.toolsKnown ? "stale" : "unknown",
          });
        }
      }
      return this.result(input, prior);
    }
    const deadline = Date.parse(input.accept_before);
    if (deadline < this.now() || deadline > this.now() + MCP_AUTH_LIMITS.admissionMs)
      throw failure("MCP_AUTH_ADMISSION_EXPIRED");
    if (this.receipts.size >= MCP_AUTH_LIMITS.retiredIds) throw failure("MCP_AUTH_CAPACITY");
    const target = this.context.target(input.server_id);
    if (!target || target.fingerprint !== input.config_fingerprint || !target.enabled)
      throw failure("MCP_AUTH_STALE");
    const rich = [...this.receipts.values()].filter((item) => item.rich).length;
    const active = new Set([
      ...this.jobs.keys(),
      ...[...this.receipts.values()].filter((item) => item.outcome === "pending"),
    ]);
    if (
      rich >= MCP_AUTH_LIMITS.receipts ||
      (input.action === "start" && active.size >= MCP_AUTH_LIMITS.pending)
    )
      throw failure("MCP_AUTH_CAPACITY");
    const record = this.record(target);
    if (input.action === "start" && record.attempt) throw failure("MCP_AUTH_BUSY");
    const receipt: Receipt = {
      owner,
      input: structuredClone(input),
      operation,
      outcome: "pending",
      rich: true,
    };
    this.receipts.set(key, receipt);
    if (input.action === "cancel") {
      receipt.outcome = "cancelled";
      receipt.finishedAt = this.now();
    } else if (input.action === "forget") {
      this.invalidate(target.id, true);
      this.update(record, { auth_phase: "required", tools_status: "unknown" });
      this.job(receipt, 1);
      void this.context
        .disconnect(target.id)
        .then(
          () => {
            this.finish(record, receipt, "completed");
          },
          () => {
            this.finish(record, receipt, "failed");
          },
        )
        .finally(() => {
          this.job(receipt, -1);
        });
    } else {
      this.job(receipt, 1);
      void this.start(record, receipt).finally(() => {
        this.job(receipt, -1);
      });
    }
    return this.result(input, receipt);
  }

  private async start(record: RecordState, receipt: Receipt) {
    try {
      if (!this.context?.openBrowser) throw failure("MCP_AUTH_BROWSER");
      record.epoch++;
      const epoch = record.epoch;
      record.tokens = undefined;
      record.expiresAt = undefined;
      record.refreshResponse = undefined;
      const path = `/callback/${randomBytes(24).toString("hex")}`;
      let attempt: Attempt;
      const listener = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => this.callback(record, attempt, request),
        error: () => this.callbackResponse("failed"),
      });
      const redirect = `http://127.0.0.1:${listener.port}${path}`;
      // Registrations from another ephemeral callback port cannot be assumed reusable.
      if (record.registrationRedirect !== redirect) record.client = undefined;
      attempt = {
        receipt,
        epoch,
        state: randomBytes(32).toString("base64url"),
        listener,
        redirect,
        callbackUsed: false,
        expiresAt: this.now() + MCP_AUTH_LIMITS.loginMs,
        timer: setTimeout(() => {
          if (record.attempt !== attempt) return;
          record.epoch++;
          this.update(record, {
            auth_phase: "error",
            tools_status: record.toolsKnown ? "stale" : "unknown",
            error_code: "auth_expired",
          });
          this.finish(record, receipt, "failed");
        }, MCP_AUTH_LIMITS.loginMs),
      };
      record.attempt = attempt;
      this.update(record, {
        auth_phase: "starting",
        tools_status: record.toolsKnown ? "stale" : "unknown",
      });
      await this.context.disconnect(record.target.id);
      this.assert(record, epoch, attempt);
      const provider = this.provider(record, epoch, attempt);
      const result = await this.authenticate(provider, {
        serverUrl: record.target.url,
        fetchFn: this.boundFetch(record, epoch, record.network.oauthFetch, attempt),
      });
      this.assert(record, epoch, attempt);
      if (result === "AUTHORIZED") await this.verify(record, attempt);
    } catch (error) {
      if (receipt.outcome !== "pending") return;
      record.epoch++;
      this.update(record, {
        auth_phase: "error",
        tools_status: record.toolsKnown ? "stale" : "unknown",
        error_code: safeCode(error),
      });
      this.finish(record, receipt, "failed");
    }
  }

  private callbackResponse(outcome: "connected" | "authorized" | "failed", status = 200) {
    return mcpOAuthCallbackResponse(outcome, status);
  }

  private async callback(
    record: RecordState,
    attempt: Attempt,
    request: Request,
  ): Promise<Response> {
    let working = false;
    try {
      this.assert(record, attempt.epoch, attempt);
      const url = new URL(request.url);
      const redirect = new URL(attempt.redirect);
      if (
        request.method !== "GET" ||
        request.headers.get("host") !== redirect.host ||
        url.host !== redirect.host ||
        url.pathname !== redirect.pathname ||
        url.search.length > 4096 ||
        attempt.callbackUsed
      )
        return this.callbackResponse("failed", 400);
      const values = url.searchParams;
      for (const name of values.keys()) {
        if (
          !["state", "code", "iss", "error", "error_description", "error_uri"].includes(name) ||
          values.getAll(name).length !== 1
        )
          return this.callbackResponse("failed", 400);
      }
      const state = Buffer.from(values.get("state") ?? "");
      const expectedState = Buffer.from(attempt.state);
      if (state.length !== expectedState.length || !timingSafeEqual(state, expectedState))
        return this.callbackResponse("failed", 400);
      if (values.has("iss") && (!record.issuer || !sameUrl(values.get("iss") ?? "", record.issuer)))
        return this.callbackResponse("failed", 400);
      if (!record.issuer || !record.resource || !record.discovery || !attempt.verifier)
        return this.callbackResponse("failed", 400);
      attempt.callbackUsed = true;
      if (values.has("error") || !values.get("code") || (values.get("code")?.length ?? 0) > 2048) {
        record.epoch++;
        this.update(record, {
          auth_phase: "error",
          tools_status: record.toolsKnown ? "stale" : "unknown",
          error_code: "auth_failed",
        });
        this.finish(record, attempt.receipt, "failed");
        return this.callbackResponse("failed");
      }
      this.update(record, {
        auth_phase: "verifying",
        tools_status: "loading",
        login_domain: new URL(record.issuer).hostname,
      });
      working = true;
      this.job(attempt.receipt, 1);
      const result = await this.authenticate(this.provider(record, attempt.epoch, attempt), {
        serverUrl: record.target.url,
        authorizationCode: values.get("code") ?? undefined,
        fetchFn: this.boundFetch(record, attempt.epoch, record.network.oauthFetch, attempt),
      });
      this.assert(record, attempt.epoch, attempt);
      if (result !== "AUTHORIZED") throw failure("MCP_AUTH_REQUIRED");
      const outcome = await this.verify(record, attempt);
      return this.callbackResponse(outcome === "current" ? "connected" : "authorized");
    } catch (error) {
      if (attempt.receipt.outcome === "pending") {
        record.epoch++;
        this.update(record, {
          auth_phase: "error",
          tools_status: record.toolsKnown ? "stale" : "unknown",
          error_code: safeCode(error),
        });
        this.finish(record, attempt.receipt, "failed");
      }
      return this.callbackResponse("failed", 400);
    } finally {
      if (working) this.job(attempt.receipt, -1);
    }
  }

  private async verify(record: RecordState, attempt: Attempt) {
    this.assert(record, attempt.epoch, attempt);
    if (!record.tokens) throw failure("MCP_AUTH_REQUIRED");
    this.update(record, {
      auth_phase: "authenticated",
      tools_status: "loading",
      login_domain: record.issuer ? new URL(record.issuer).hostname : undefined,
    });
    const outcome = await this.context?.verify(record.target);
    this.assert(record, attempt.epoch, attempt);
    this.connectionResult(record.target.id, outcome ?? "connection_failed");
    this.finish(record, attempt.receipt, "completed");
    return outcome ?? "connection_failed";
  }

  private boundFetch(
    record: RecordState,
    epoch: number,
    fetcher: FetchLike,
    attempt?: Attempt,
  ): FetchLike {
    return async (input, init) => {
      this.assert(record, epoch, attempt);
      if (init?.signal?.aborted) throw failure("MCP_AUTH_STALE");
      const body =
        typeof init?.body === "string" || init?.body instanceof URLSearchParams
          ? String(init.body)
          : undefined;
      const params = body ? new URLSearchParams(body) : undefined;
      const tokenEndpoint = record.discovery?.authorizationServerMetadata?.token_endpoint;
      const refreshing =
        init?.method?.toUpperCase() === "POST" &&
        tokenEndpoint &&
        sameUrl(input, tokenEndpoint) &&
        params?.get("grant_type") === "refresh_token";
      let receiving: Promise<Response>;
      if (refreshing) {
        const key = createHash("sha256")
          .update(`${new URL(input).href}\0${body}`)
          .digest("hex");
        const prior = record.refreshResponse;
        if (
          prior?.epoch === epoch &&
          prior.key === key &&
          (!prior.committed ||
            record.expiresAt === undefined ||
            record.expiresAt > this.now() + 30_000)
        ) {
          receiving = prior.promise;
        } else {
          // A delayed SDK request may already have read a retired rotating refresh token.
          if (
            params?.get("refresh_token") !== record.tokens?.refresh_token ||
            (prior && !prior.committed)
          )
            throw failure("MCP_AUTH_REQUIRED");
          receiving = fetcher(input, init);
          record.refreshResponse = { epoch, key, promise: receiving, committed: false };
        }
      } else receiving = fetcher(input, init);
      const response = await receiving;
      try {
        this.assert(record, epoch, attempt);
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
      if (init?.signal?.aborted) throw failure("MCP_AUTH_STALE");
      return refreshing ? response.clone() : response;
    };
  }

  private provider(record: RecordState, epoch: number, attempt?: Attempt): OAuthClientProvider {
    const check = () => this.assert(record, epoch, attempt);
    return {
      get redirectUrl() {
        check();
        return attempt?.redirect ?? record.registrationRedirect;
      },
      get clientMetadata() {
        check();
        return {
          client_name: "Kairomes",
          redirect_uris: [attempt?.redirect ?? record.registrationRedirect ?? ""],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        };
      },
      state: () => {
        check();
        if (!attempt) throw failure("MCP_AUTH_REQUIRED");
        return attempt.state;
      },
      clientInformation: () => {
        check();
        if (!record.client && !attempt) throw failure("MCP_AUTH_REQUIRED");
        return record.client ? structuredClone(record.client) : undefined;
      },
      saveClientInformation: (value) => {
        check();
        if (!attempt || !record.issuer) throw failure("MCP_AUTH_REQUIRED");
        if ("token_endpoint_auth_method" in value && value.token_endpoint_auth_method !== "none")
          throw failure("MCP_AUTH_UNSUPPORTED");
        record.client = structuredClone(value);
        record.registrationRedirect = attempt.redirect;
      },
      tokens: () => {
        check();
        return record.tokens ? structuredClone(record.tokens) : undefined;
      },
      saveTokens: (value) => {
        check();
        if (!record.issuer || !record.resource) throw failure("MCP_AUTH_REQUIRED");
        record.tokens = structuredClone({
          ...value,
          ...(!value.refresh_token && record.tokens?.refresh_token
            ? { refresh_token: record.tokens.refresh_token }
            : {}),
        });
        record.expiresAt =
          value.expires_in === undefined ? undefined : this.now() + value.expires_in * 1000;
        if (record.refreshResponse?.epoch === epoch) record.refreshResponse.committed = true;
      },
      saveCodeVerifier: (value) => {
        check();
        if (!attempt) throw failure("MCP_AUTH_REQUIRED");
        attempt.verifier = value;
      },
      codeVerifier: () => {
        check();
        if (!attempt?.verifier) throw failure("MCP_AUTH_REQUIRED");
        return attempt.verifier;
      },
      addClientAuthentication: (headers, params, _url, metadata) => {
        check();
        if (!metadata?.token_endpoint_auth_methods_supported?.includes("none") || !record.client)
          throw failure("MCP_AUTH_UNSUPPORTED");
        headers.delete("Authorization");
        params.delete("client_secret");
        params.set("client_id", record.client.client_id);
      },
      validateResourceURL: async (server, resource) => {
        check();
        if (
          !resource ||
          !sameUrl(server, record.target.url) ||
          !sameUrl(resource, record.target.url)
        )
          throw failure("MCP_AUTH_UNSUPPORTED");
        return new URL(resource);
      },
      saveDiscoveryState: (value) => {
        check();
        const resource = value.resourceMetadata;
        const metadata = value.authorizationServerMetadata;
        if (
          !resource ||
          !sameUrl(resource.resource, record.target.url) ||
          !metadata ||
          !resource.authorization_servers?.some((issuer) => sameUrl(issuer, metadata.issuer)) ||
          !sameUrl(value.authorizationServerUrl, metadata.issuer)
        )
          throw failure("MCP_AUTH_UNVERIFIED");
        if (
          (record.issuer && !sameUrl(record.issuer, metadata.issuer)) ||
          (record.resource && !sameUrl(record.resource, resource.resource))
        )
          throw failure("MCP_AUTH_STALE");
        record.issuer = new URL(metadata.issuer).href;
        record.resource = new URL(resource.resource).href;
        if (
          !metadata.code_challenge_methods_supported?.includes("S256") ||
          !metadata.token_endpoint_auth_methods_supported?.includes("none") ||
          !metadata.authorization_endpoint ||
          !metadata.token_endpoint ||
          (!record.client && !metadata.registration_endpoint)
        ) {
          this.update(record, {
            auth_phase: "error",
            tools_status: record.toolsKnown ? "stale" : "unknown",
            error_code: "auth_unsupported",
            login_domain: new URL(metadata.issuer).hostname,
          });
          throw failure("MCP_AUTH_UNSUPPORTED");
        }
        record.discovery = structuredClone(value);
        if (!attempt)
          this.update(record, {
            auth_phase: record.tokens ? "authenticated" : "required",
            tools_status: record.summary ? "stale" : "unknown",
            login_domain: new URL(metadata.issuer).hostname,
          });
      },
      discoveryState: () => {
        check();
        return record.discovery ? structuredClone(record.discovery) : undefined;
      },
      invalidateCredentials: (scope) => {
        check();
        if (scope === "all" || scope === "tokens") {
          record.tokens = undefined;
          record.expiresAt = undefined;
          record.refreshResponse = undefined;
        }
        if (scope === "all" || scope === "client") {
          record.client = undefined;
          record.registrationRedirect = undefined;
        }
        if ((scope === "all" || scope === "verifier") && attempt) attempt.verifier = undefined;
        if (scope === "all" || scope === "discovery") record.discovery = undefined;
      },
      redirectToAuthorization: async (url) => {
        check();
        const endpoint = record.discovery?.authorizationServerMetadata?.authorization_endpoint;
        if (!attempt || !endpoint || !this.context?.openBrowser) throw failure("MCP_AUTH_REQUIRED");
        const expected = new URL(endpoint);
        if (
          url.origin !== expected.origin ||
          url.pathname !== expected.pathname ||
          ["state", "redirect_uri", "code_challenge_method", "code_challenge", "resource"].some(
            (name) => url.searchParams.getAll(name).length !== 1,
          ) ||
          url.searchParams.get("state") !== attempt.state ||
          url.searchParams.get("redirect_uri") !== attempt.redirect ||
          url.searchParams.get("code_challenge_method") !== "S256" ||
          !url.searchParams.get("code_challenge") ||
          !record.resource ||
          url.searchParams.get("resource") !== record.resource
        )
          throw failure("MCP_AUTH_UNSUPPORTED");
        const validated = await record.network.validateAuthorizationTarget(url);
        check();
        try {
          await this.context.openBrowser(validated.href);
        } catch {
          throw failure("MCP_AUTH_BROWSER");
        }
        check();
        this.update(record, {
          auth_phase: "waiting",
          tools_status: record.toolsKnown ? "stale" : "unknown",
          login_domain: expected.hostname,
        });
      },
    };
  }

  /** Background probes can discover metadata or refresh existing registration, never register/open. */
  transport(
    target: McpOAuthTarget,
  ): { authProvider: OAuthClientProvider; fetch: FetchLike } | undefined {
    if (!this.context || this.closed) return undefined;
    const record = this.record(target);
    const epoch = record.epoch;
    return {
      authProvider: this.provider(record, epoch),
      fetch: this.boundFetch(record, epoch, record.network.fetch),
    };
  }

  async prepareTransport(
    target: McpOAuthTarget,
  ): Promise<ReturnType<McpOAuthManager["transport"]>> {
    if (!this.context || this.closed) return undefined;
    const prior = this.records.get(target.id);
    const evidence = Boolean(prior?.discovery || prior?.issuer || prior?.tokens || prior?.attempt);
    let record: RecordState | undefined;
    try {
      record = this.record(target);
      const epoch = record.epoch;
      await record.network.validateAuthorizationTarget(target.url);
      this.assert(record, epoch);
      return this.transport(target);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (!evidence && (code === "MCP_OAUTH_URL_BLOCKED" || code === "MCP_OAUTH_DNS_BLOCKED")) {
        if (
          record &&
          this.records.get(target.id) === record &&
          !record.discovery &&
          !record.issuer &&
          !record.tokens &&
          !record.attempt
        )
          this.records.delete(target.id);
        return undefined;
      }
      throw error;
    }
  }

  async beforeCall(serverId: string, toolCall = true) {
    const record = this.records.get(serverId);
    if (toolCall && record?.summary && (!record.tokens || record.attempt))
      throw failure("MCP_AUTH_REQUIRED");
    if (!record?.tokens || record.expiresAt === undefined || record.expiresAt > this.now() + 30_000)
      return;
    if (record.refresh) return record.refresh;
    const epoch = record.epoch;
    const task = (async () => {
      try {
        const result = await this.authenticate(this.provider(record, epoch), {
          serverUrl: record.target.url,
          fetchFn: this.boundFetch(record, epoch, record.network.oauthFetch),
        });
        this.assert(record, epoch);
        if (result !== "AUTHORIZED" || !record.tokens) throw failure("MCP_AUTH_REQUIRED");
      } catch (error) {
        if (record.epoch === epoch) this.requireLogin(serverId);
        throw failure(
          safeCode(error) === "auth_unsupported" ? "MCP_AUTH_UNSUPPORTED" : "MCP_AUTH_REQUIRED",
        );
      }
    })();
    record.refresh = task;
    try {
      await task;
    } finally {
      if (record.refresh === task) record.refresh = undefined;
    }
  }

  requireLogin(serverId: string) {
    const record = this.records.get(serverId);
    if (!record) return;
    record.epoch++;
    if (record.attempt) this.finish(record, record.attempt.receipt, "failed");
    record.tokens = undefined;
    record.expiresAt = undefined;
    record.refreshResponse = undefined;
    this.update(record, {
      auth_phase: "required",
      tools_status: record.toolsKnown ? "stale" : "unknown",
      error_code: "auth_required",
      login_domain: record.issuer ? new URL(record.issuer).hostname : undefined,
    });
    void this.context?.disconnect(serverId).catch(() => undefined);
  }

  connectionResult(
    serverId: string,
    outcome: "current" | "list_failed" | "connection_failed",
    errorCode?: string,
  ) {
    const record = this.records.get(serverId);
    if (!record?.summary) return;
    if (record.summary.error_code === "auth_unsupported" && outcome !== "current") return;
    if (outcome === "current") record.toolsKnown = true;
    const authPhase = record.tokens ? "authenticated" : record.summary.auth_phase;
    this.update(record, {
      auth_phase: authPhase,
      tools_status: outcome === "current" ? "current" : "error",
      ...(outcome === "current"
        ? {}
        : {
            error_code:
              errorCode ??
              (record.summary.tools_status === "error" ? record.summary.error_code : undefined) ??
              (outcome === "list_failed" ? "tools_list_failed" : "connection_failed"),
          }),
      login_domain: record.issuer ? new URL(record.issuer).hostname : undefined,
    });
  }
}
