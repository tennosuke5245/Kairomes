import { createHash } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  KairomesError,
  LIMITS,
  type McpAuthInput,
  type McpAuthResult,
  type McpAuthSummary,
  type McpCall,
  type McpCatalog,
  type McpCatalogTool,
  type McpMountConfig,
  McpMountConfigSchema,
  McpMountFileSchema,
  type McpPanelState,
  type McpServerSummary,
  type McpToolDescription,
  mcpConfigIdentitySource,
  VERSION,
} from "@kairomes/protocol";
import { inspectImageBuffer } from "@kairomes/workspace-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type CallToolResult,
  ErrorCode,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { type McpOAuthDependencies, McpOAuthManager, type McpOAuthTarget } from "./mcp-oauth.ts";

const CONFIG_FILE = "mcp-servers.json";
const CONNECT_TIMEOUT = 10_000;
const STDIO_INITIALIZE_TIMEOUT = 120_000;
const CALL_TIMEOUT = 30_000;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_ARGUMENT_PREVIEW_BYTES = 4 * 1024;
const MAX_ARGUMENT_PREVIEW_STRING = 400;
const MAX_TEXT_BYTES = 24 * 1024;
const MAX_STRUCTURED_BYTES = 16 * 1024;
const MAX_CONTENT_ITEMS = 20;
const MAX_IMAGE_ITEMS = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_MEDIA_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_CALLS = 40;
const CACHED_CALL_MS = 5 * 60_000;
/** request_id records outlive cached results so a late retry is still never re-sent. */
const MAX_CALL_RECORDS = 4096;
const CALL_RECORD_MS = 24 * 60 * 60_000;
const MAX_TOOL_TITLE = 120;
const MAX_TOOL_DESCRIPTION = 500;
const MAX_RESOURCE_NAME = 200;
const MAX_RESOURCE_URI = 2048;
const BLOCKED_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "mcp-session-id",
  "origin",
]);

type RuntimeState = "disconnected" | "connecting" | "ready" | "unavailable";

type DiscoveredTool = {
  tool: Tool;
  fingerprint: string;
  ref: string;
};

type Runtime = {
  config: McpMountConfig;
  state: RuntimeState;
  message?: string;
  client?: Client;
  transport?: Transport;
  tools: Map<string, DiscoveredTool>;
  connecting?: Promise<void>;
  connectionEpoch?: number;
  lastFailure?: "list_failed" | "connection_failed";
};

export type McpForwardedImage = {
  type: "image";
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  mediaId: string;
};

export type McpCallExecution = {
  data: McpCall;
  images: McpForwardedImage[];
};

type CachedCall = {
  value: McpCallExecution;
  mediaBytes: number;
  expires: number;
};

type CallOutcome =
  | { kind: "done"; value: McpCallExecution }
  | { kind: "unknown" }
  | { kind: "rejected"; error: unknown };

/**
 * At-most-once bookkeeping for one request_id. It keeps a fingerprint of the route, tool_ref and
 * arguments, never the argument values; results live only in the bounded result cache.
 */
type CallRecord = {
  fingerprint: string;
  state: "in_flight" | "done" | "unknown";
  /** Present only while in flight, so identical concurrent calls await the first attempt. */
  settled?: Promise<CallOutcome>;
  expires: number;
};

export type AddStdioMount = {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: string[];
};

export type AddHttpMount = {
  name: string;
  url: string;
  headerEnv?: Record<string, string>;
};

export type LocalMcpMount = McpMountConfig & {
  state: RuntimeState;
  message?: string;
  tools: Array<
    McpCatalogTool & {
      input_schema: Record<string, unknown>;
      output_schema?: Record<string, unknown>;
    }
  >;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value: unknown, length = 32): string {
  return createHash("sha256").update(stable(value)).digest("hex").slice(0, length);
}

function schemaFingerprint(tool: Tool): string {
  return digest({
    name: tool.name,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
  });
}

function toolReference(serverId: string, name: string, fingerprint: string): string {
  return `mcp_${digest({ serverId, name, fingerprint }, 40)}`;
}

function safeMessage(error?: unknown, transport?: McpMountConfig["transport"]["kind"]): string {
  if (error instanceof KairomesError) {
    if (error.code === "MCP_TOOL_LIMIT") return "工具數量超過 128 項上限。";
    if (error.code === "MCP_SCHEMA_LIMIT") return "工具定義超過 64 KiB 上限。";
    if (error.code === "MCP_TOOL_NAME_INVALID") return "服務回傳無效或重複的工具名稱。";
  }
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout)
    return "連線逾時；請完成必要登入後再重新探索。";
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (transport === "stdio") {
    if (code === "ENOENT") return "找不到啟動程式或工作目錄。";
    if (code === "EACCES" || code === "EPERM") return "啟動權限不足。";
  }
  return "無法連線；請由本機使用者檢查這個 MCP 的設定與執行狀態。";
}

function connectionErrorCode(error: unknown, initialized: boolean): string {
  const phase = initialized ? "tools_list" : "connection";
  if (error instanceof KairomesError) {
    if (error.code === "MCP_TOOL_LIMIT") return "tools_limit";
    if (error.code === "MCP_SCHEMA_LIMIT") return "schema_limit";
    if (error.code === "MCP_TOOL_NAME_INVALID") return "tools_invalid";
  }
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) return `${phase}_timeout`;
    if ([ErrorCode.InvalidParams, ErrorCode.MethodNotFound].includes(error.code))
      return `${phase}_rejected`;
  }
  if (error instanceof StreamableHTTPError) {
    if (
      typeof error.code === "number" &&
      [400, 401, 403, 404, 405, 429, 500, 502, 503, 504].includes(error.code)
    )
      return `${phase}_http_${error.code}`;
    if (error.code === -1) return `${phase}_response_invalid`;
  }
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (
    ["MCP_OAUTH_URL_BLOCKED", "MCP_OAUTH_DNS_BLOCKED", "MCP_OAUTH_REDIRECT_BLOCKED"].includes(
      String(code),
    )
  )
    return `${phase}_network_blocked`;
  if (code === "MCP_OAUTH_NETWORK_TIMEOUT") return `${phase}_timeout`;
  if (code === "MCP_OAUTH_NETWORK_FAILED") return `${phase}_network_failed`;
  if (code === "MCP_OAUTH_RESPONSE_LIMIT") return `${phase}_response_limit`;
  if (code === "MCP_OAUTH_RESPONSE_INVALID") return `${phase}_response_invalid`;
  return initialized ? "tools_list_failed" : "connection_failed";
}

function validateHttpUrl(input: string): URL {
  const url = new URL(input);
  if (url.username || url.password || url.hash)
    throw new KairomesError("MCP_URL_INVALID", "MCP URL 不可包含帳密或片段。");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new KairomesError(
      "MCP_URL_INVALID",
      "遠端 MCP 必須使用 HTTPS；只有 loopback 可使用 HTTP。",
    );
  return url;
}

function environment(names: string[]): Record<string, string> {
  const result = getDefaultEnvironment();
  for (const name of names) {
    const value = process.env[name];
    if (value === undefined)
      throw new KairomesError("MCP_ENV_MISSING", `缺少 MCP 所需的環境變數：${name}`);
    result[name] = value;
  }
  return result;
}

function headersFromEnvironment(mapping: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [name, envName] of Object.entries(mapping)) {
    if (BLOCKED_HEADERS.has(name.toLowerCase()))
      throw new KairomesError("MCP_HEADER_BLOCKED", `不可覆寫受保護的 HTTP header：${name}`);
    const value = process.env[envName];
    if (value === undefined)
      throw new KairomesError("MCP_ENV_MISSING", `缺少 MCP 所需的環境變數：${envName}`);
    headers.set(name, value);
  }
  return headers;
}

function boundedText(input: string, budget: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(input) <= budget) return { text: input, truncated: false };
  let low = 0;
  let high = input.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(input.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return { text: `${input.slice(0, low)}\n…輸出已截斷`, truncated: true };
}

function boundedLabel(input: string, limit: number): string {
  const clean = [...input]
    .map((character) => (isControlCharacter(character) ? " " : character))
    .join("")
    .trim();
  const characters = [...clean];
  return characters.length <= limit ? clean : `${characters.slice(0, limit - 1).join("")}…`;
}

const sensitiveArgumentKey =
  /(?:authorization|cookie|credential|password|secret|session|token|api[\s_-]*key)/i;

function previewArgument(value: unknown, key: string, depth = 0): unknown {
  if (sensitiveArgumentKey.test(key)) return "[已隱藏]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return boundedLabel(value, MAX_ARGUMENT_PREVIEW_STRING);
  if (depth >= 3) return "[內容已折疊]";
  if (Array.isArray(value)) {
    const preview = value.slice(0, 12).map((item) => previewArgument(item, key, depth + 1));
    if (value.length > preview.length) preview.push(`…另有 ${value.length - preview.length} 項`);
    return preview;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 24);
    const preview = Object.fromEntries(
      entries.map(([childKey, item]) => [
        boundedLabel(childKey, 80),
        previewArgument(item, childKey, depth + 1),
      ]),
    );
    const total = Object.keys(value as Record<string, unknown>).length;
    if (total > entries.length) preview["…"] = `另有 ${total - entries.length} 個欄位`;
    return preview;
  }
  return String(value);
}

function argumentPreview(input: Record<string, unknown>): Record<string, unknown> {
  const preview = previewArgument(input, "", 0) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(preview)) <= MAX_ARGUMENT_PREVIEW_BYTES) return preview;
  return Object.fromEntries(
    Object.keys(input)
      .slice(0, 32)
      .map((key) => [
        boundedLabel(key, 80),
        sensitiveArgumentKey.test(key) ? "[已隱藏]" : "[內容過長；已省略]",
      ]),
  );
}

function hasControlCharacter(input: string): boolean {
  return [...input].some(isControlCharacter);
}

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127;
}

function isLocalResourceUri(input: string): boolean {
  const value = input.trim();
  return (
    /^file:/i.test(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\/.test(value) ||
    value.startsWith("/")
  );
}

function forwardableImage(data: string, mimeType: string | undefined) {
  if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp")
    return undefined;
  if (
    data.length === 0 ||
    data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    return undefined;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== data)
    return undefined;
  try {
    const image = inspectImageBuffer(bytes);
    if (image.mime_type !== mimeType) return undefined;
    return {
      bytes: bytes.length,
      metadata: {
        type: "image" as const,
        mime_type: image.mime_type,
        byte_length: bytes.length,
        width: image.width,
        height: image.height,
      },
      image: {
        type: "image" as const,
        data,
        mimeType: image.mime_type,
      },
    };
  } catch {
    return undefined;
  }
}

const fetchWithoutRedirects: FetchLike = (input, init) =>
  fetch(input, { ...init, redirect: "manual" });

function normalizeTool(runtime: Runtime, discovered: DiscoveredTool): McpCatalogTool {
  const enabled = !runtime.config.disabled_tools.includes(discovered.tool.name);
  const annotations = discovered.tool.annotations;
  return {
    ref: discovered.ref,
    server_id: runtime.config.id,
    server_name: runtime.config.name,
    name: discovered.tool.name,
    ...(discovered.tool.title
      ? { title: boundedLabel(discovered.tool.title, MAX_TOOL_TITLE) }
      : {}),
    ...(discovered.tool.description
      ? { description: boundedLabel(discovered.tool.description, MAX_TOOL_DESCRIPTION) }
      : {}),
    enabled,
    availability:
      !runtime.config.enabled || !enabled
        ? "disabled"
        : runtime.state !== "ready"
          ? "unavailable"
          : "ready",
    read_only_hint: annotations?.readOnlyHint ?? null,
    destructive_hint: annotations?.destructiveHint ?? null,
    open_world_hint: annotations?.openWorldHint ?? null,
    schema_fingerprint: discovered.fingerprint,
  };
}

export class McpHostManager {
  private readonly configPath: string;
  private readonly validator = new AjvJsonSchemaValidator();
  private readonly calls = new Map<string, CachedCall>();
  /** Insertion order is least recently used first. */
  private readonly records = new Map<string, CallRecord>();
  private cachedMediaBytes = 0;
  private runtimes = new Map<string, Runtime>();
  private loaded?: Promise<void>;
  private saving = Promise.resolve();
  private pendingAdds = 0;
  private configHash = "";
  private closed = false;
  private readonly oauth: McpOAuthManager;

  constructor(dataDirectory: string, options: { oauth?: McpOAuthDependencies } = {}) {
    this.configPath = path.join(dataDirectory, CONFIG_FILE);
    this.oauth = new McpOAuthManager(options.oauth);
  }

  private oauthTarget(serverId: string): McpOAuthTarget | undefined {
    const config = this.runtimes.get(serverId)?.config;
    if (
      config?.transport.kind !== "http" ||
      new URL(config.transport.url).protocol !== "https:" ||
      Object.keys(config.transport.header_env).some((key) => key.toLowerCase() === "authorization")
    )
      return undefined;
    return {
      id: config.id,
      fingerprint: createHash("sha256").update(mcpConfigIdentitySource(config)).digest("hex"),
      url: config.transport.url,
      enabled: config.enabled,
    };
  }

  configureAuth(
    instanceId: string,
    openBrowser: ((url: string) => Promise<void>) | undefined,
    ownerValid: (owner: string) => boolean,
  ) {
    this.oauth.configure({
      instanceId,
      openBrowser,
      ownerValid,
      target: (id) => this.oauthTarget(id),
      disconnect: async (id) => {
        const runtime = this.runtimes.get(id);
        if (runtime) {
          runtime.state = "unavailable";
          await this.disconnect(runtime);
        }
      },
      verify: async (target) => {
        const runtime = this.runtimes.get(target.id);
        if (!runtime || this.oauthTarget(target.id)?.fingerprint !== target.fingerprint)
          return "connection_failed";
        await this.connect(runtime, true);
        return runtime.state === "ready" ? "current" : (runtime.lastFailure ?? "connection_failed");
      },
    });
  }

  auth(owner: string, input: McpAuthInput): McpAuthResult {
    return this.oauth.operation(owner, input);
  }
  revokeAuthOwner(owner: string) {
    this.oauth.revokeOwner(owner);
  }
  authSummary(serverId: string): McpAuthSummary | undefined {
    const target = this.oauthTarget(serverId);
    return target ? this.oauth.summary(serverId, target.fingerprint) : undefined;
  }

  private async load() {
    if (!this.loaded) this.loaded = this.readConfig();
    await this.loaded;
  }

  private async readConfig() {
    let parsed: unknown = { version: 1, servers: [] };
    let source = "";
    try {
      source = await readFile(this.configPath, "utf8");
      parsed = JSON.parse(source);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw new KairomesError("MCP_CONFIG_INVALID", "無法讀取 MCP 掛載設定。");
    }
    const file = McpMountFileSchema.safeParse(parsed);
    if (!file.success)
      throw new KairomesError("MCP_CONFIG_INVALID", "MCP 掛載設定格式不正確，請由本機使用者修正。");
    this.configHash = digest(source || { version: 1, servers: [] }, 64);
    this.runtimes = new Map(
      file.data.servers.map((config) => [
        config.id,
        {
          config,
          state: "disconnected",
          tools: new Map<string, DiscoveredTool>(),
        } satisfies Runtime,
      ]),
    );
  }

  private async reloadIfChanged() {
    let source = "";
    try {
      source = await readFile(this.configPath, "utf8");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        throw new KairomesError("MCP_CONFIG_INVALID", "無法讀取 MCP 掛載設定。");
    }
    const nextHash = digest(source || { version: 1, servers: [] }, 64);
    if (nextHash === this.configHash) return;
    let parsed: unknown = { version: 1, servers: [] };
    try {
      if (source) parsed = JSON.parse(source);
    } catch {
      throw new KairomesError("MCP_CONFIG_INVALID", "MCP 掛載設定不是有效的 JSON。");
    }
    const file = McpMountFileSchema.safeParse(parsed);
    if (!file.success)
      throw new KairomesError("MCP_CONFIG_INVALID", "MCP 掛載設定格式不正確，請由本機使用者修正。");
    const next = new Map<string, Runtime>();
    const close: Promise<void>[] = [];
    for (const config of file.data.servers) {
      const prior = this.runtimes.get(config.id);
      if (
        prior &&
        (mcpConfigIdentitySource(prior.config) !== mcpConfigIdentitySource(config) ||
          !config.enabled)
      ) {
        this.oauth.invalidate(config.id, true);
        close.push(this.disconnect(prior));
        prior.state = "disconnected";
      }
      if (prior && stable(prior.config.transport) === stable(config.transport)) {
        prior.config = config;
        next.set(config.id, prior);
      } else {
        if (prior) close.push(this.disconnect(prior));
        next.set(config.id, { config, state: "disconnected", tools: new Map() });
      }
    }
    for (const [id, prior] of this.runtimes) {
      if (!next.has(id)) close.push(this.disconnect(prior));
      if (!next.has(id)) this.oauth.invalidate(id, true);
    }
    await Promise.all(close);
    this.runtimes = next;
    this.configHash = nextHash;
  }

  private async persist(addition?: McpMountConfig) {
    const task = this.saving.then(async () => {
      const value = McpMountFileSchema.parse({
        version: 1,
        servers: [
          ...[...this.runtimes.values()].map((runtime) => runtime.config),
          ...(addition ? [addition] : []),
        ],
      });
      const temporary = `${this.configPath}.${crypto.randomUUID()}.tmp`;
      const source = `${JSON.stringify(value, null, 2)}\n`;
      try {
        await writeFile(temporary, source, { mode: 0o600 });
        await rename(temporary, this.configPath);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      if (addition)
        this.runtimes.set(addition.id, {
          config: addition,
          state: "disconnected",
          tools: new Map(),
        });
      this.configHash = digest(source, 64);
      await chmod(this.configPath, 0o600).catch(() => undefined);
    });
    this.saving = task.catch(() => undefined);
    await task;
  }

  private async addMount(config: McpMountConfig): Promise<McpMountConfig> {
    if (this.runtimes.size + this.pendingAdds >= 16)
      throw new KairomesError("MCP_SERVER_LIMIT", "MCP 掛載數量已達上限。");
    this.pendingAdds++;
    try {
      await this.persist(config);
    } finally {
      this.pendingAdds--;
    }
    return structuredClone(config);
  }

  private transport(
    config: McpMountConfig,
    oauth?: ReturnType<McpOAuthManager["transport"]>,
  ): Transport {
    if (config.transport.kind === "stdio") {
      const transport = new StdioClientTransport({
        command: config.transport.command,
        args: config.transport.args,
        ...(config.transport.cwd ? { cwd: path.resolve(config.transport.cwd) } : {}),
        env: environment(config.transport.env),
        stderr: "pipe",
        maxBufferSize: 2 * 1024 * 1024,
      });
      // Always consume stderr so a noisy child cannot block. It remains local and is not sent to the model.
      transport.stderr?.on("data", () => undefined);
      return transport;
    }
    const url = validateHttpUrl(config.transport.url);
    return new StreamableHTTPClientTransport(url, {
      requestInit: { headers: headersFromEnvironment(config.transport.header_env) },
      ...(oauth ? { authProvider: oauth.authProvider } : {}),
      fetch: oauth?.fetch ?? fetchWithoutRedirects,
      // The SDK's default "same-origin" policy follows redirects itself; "follow" hands them
      // back to our fetch, which never follows any redirect.
      redirectPolicy: "follow",
      reconnectionOptions: {
        maxReconnectionDelay: 5000,
        initialReconnectionDelay: 500,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 2,
      },
    });
  }

  private acceptTools(runtime: Runtime, tools: Tool[]) {
    if (tools.length > 128)
      throw new KairomesError("MCP_TOOL_LIMIT", "此 MCP 公開的工具數量超過 Kairomes 上限。");
    const next = new Map<string, DiscoveredTool>();
    for (const tool of tools) {
      if (
        !tool.name ||
        tool.name.length > 256 ||
        hasControlCharacter(tool.name) ||
        next.has(tool.name)
      )
        throw new KairomesError("MCP_TOOL_NAME_INVALID", "此 MCP 公開了無效或重複的工具名稱。");
      if (
        Buffer.byteLength(
          stable({ input_schema: tool.inputSchema, output_schema: tool.outputSchema }),
        ) > MAX_SCHEMA_BYTES
      )
        throw new KairomesError("MCP_SCHEMA_LIMIT", "此 MCP 的工具 schema 超過 Kairomes 上限。");
      const fingerprint = schemaFingerprint(tool);
      next.set(tool.name, {
        tool,
        fingerprint,
        ref: toolReference(runtime.config.id, tool.name, fingerprint),
      });
    }
    runtime.tools = next;
    runtime.state = "ready";
    runtime.message = undefined;
  }

  private async disconnect(runtime: Runtime) {
    runtime.connectionEpoch = (runtime.connectionEpoch ?? 0) + 1;
    const client = runtime.client;
    runtime.client = undefined;
    runtime.transport = undefined;
    runtime.connecting = undefined;
    if (client) await client.close().catch(() => undefined);
  }

  private async connect(runtime: Runtime, force = false) {
    if (this.closed) throw new KairomesError("MCP_HOST_CLOSED", "MCP 掛載服務已關閉。");
    if (!force && runtime.state === "ready" && runtime.client) return;
    if (runtime.connecting) return runtime.connecting;
    let task: Promise<void> | undefined;
    task = (async () => {
      const cleanup = this.disconnect(runtime);
      const epoch = runtime.connectionEpoch;
      let authEpoch = this.oauth.generation(runtime.config.id);
      const configIdentity = mcpConfigIdentitySource(runtime.config);
      const current = () =>
        !this.closed &&
        runtime.connectionEpoch === epoch &&
        this.runtimes.get(runtime.config.id) === runtime &&
        runtime.config.enabled &&
        mcpConfigIdentitySource(runtime.config) === configIdentity &&
        this.oauth.generation(runtime.config.id) === authEpoch;
      await cleanup;
      if (!current()) return;
      runtime.state = "connecting";
      runtime.lastFailure = undefined;
      let initialized = false;
      try {
        await this.oauth.beforeCall(runtime.config.id, false);
        if (!current()) return;
        const target = this.oauthTarget(runtime.config.id);
        const oauth = target ? await this.oauth.prepareTransport(target) : undefined;
        authEpoch = this.oauth.generation(runtime.config.id);
        if (!current()) return;
        const transport = this.transport(runtime.config, oauth);
        const client = new Client(
          { name: `kairomes:${runtime.config.id}`, version: VERSION },
          {
            listChanged: {
              tools: {
                autoRefresh: true,
                debounceMs: 300,
                onChanged: (error, tools) => {
                  if (!current() || runtime.client !== client) return;
                  if (error || !tools) {
                    runtime.state = "unavailable";
                    runtime.message = safeMessage();
                    this.oauth.connectionResult(
                      runtime.config.id,
                      "list_failed",
                      connectionErrorCode(error, true),
                    );
                    return;
                  }
                  try {
                    this.acceptTools(runtime, tools);
                    this.oauth.connectionResult(runtime.config.id, "current");
                  } catch (error) {
                    runtime.state = "unavailable";
                    runtime.message = safeMessage();
                    this.oauth.connectionResult(
                      runtime.config.id,
                      "list_failed",
                      connectionErrorCode(error, true),
                    );
                  }
                },
              },
            },
          },
        );
        runtime.client = client;
        runtime.transport = transport;
        client.onclose = () => {
          if (!current() || runtime.client !== client) return;
          runtime.client = undefined;
          runtime.transport = undefined;
          runtime.state = "unavailable";
          runtime.message = safeMessage();
          this.oauth.connectionResult(runtime.config.id, "connection_failed");
        };
        await client.connect(transport, {
          timeout:
            runtime.config.transport.kind === "stdio" ? STDIO_INITIALIZE_TIMEOUT : CONNECT_TIMEOUT,
        });
        if (!current() || runtime.client !== client) return;
        initialized = true;
        const listing = await client.listTools({}, { timeout: CONNECT_TIMEOUT });
        if (!current() || runtime.client !== client) return;
        this.acceptTools(runtime, listing.tools);
        this.oauth.connectionResult(runtime.config.id, "current");
      } catch (error) {
        if (!current()) return;
        const cleanup = this.disconnect(runtime);
        const cleanupEpoch = runtime.connectionEpoch;
        await cleanup;
        if (
          this.closed ||
          runtime.connectionEpoch !== cleanupEpoch ||
          this.runtimes.get(runtime.config.id) !== runtime ||
          !runtime.config.enabled ||
          this.oauth.generation(runtime.config.id) !== authEpoch
        )
          return;
        runtime.state = "unavailable";
        runtime.lastFailure = initialized ? "list_failed" : "connection_failed";
        runtime.message = safeMessage(error, runtime.config.transport.kind);
        const summary = this.oauth.summary(runtime.config.id);
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code === "MCP_AUTH_REQUIRED" || code === "MCP_AUTH_SCOPE_REQUIRED")
          this.oauth.requireLogin(runtime.config.id);
        else if (summary?.auth_phase !== "required")
          this.oauth.connectionResult(
            runtime.config.id,
            runtime.lastFailure,
            connectionErrorCode(error, initialized),
          );
      } finally {
        if (runtime.connecting === task) runtime.connecting = undefined;
      }
    })();
    runtime.connecting = task;
    await task;
  }

  private async discover(refresh = false, serverId?: string) {
    await this.load();
    await this.reloadIfChanged();
    const selected = [...this.runtimes.values()].filter(
      (runtime) => !serverId || runtime.config.id === serverId,
    );
    if (serverId && !selected.length)
      throw new KairomesError("MCP_SERVER_NOT_FOUND", "找不到指定的 MCP 掛載。");
    await Promise.all(
      selected.map((runtime) => {
        if (!runtime.config.enabled) {
          runtime.state = "disconnected";
          runtime.message = undefined;
          return this.disconnect(runtime);
        }
        if (this.oauth.pending(runtime.config.id)) return Promise.resolve();
        if (refresh || runtime.state === "disconnected") return this.connect(runtime, refresh);
        return Promise.resolve();
      }),
    );
  }

  private revision() {
    return digest(
      [...this.runtimes.values()].map((runtime) => ({
        id: runtime.config.id,
        config: mcpConfigIdentitySource(runtime.config),
        state: runtime.state,
        enabled: runtime.config.enabled,
        disabled: runtime.config.disabled_tools,
        tools: [...runtime.tools.values()].map(({ tool, fingerprint }) => ({
          name: tool.name,
          fingerprint,
        })),
      })),
      40,
    );
  }

  private findTool(ref: string): { runtime: Runtime; discovered: DiscoveredTool } {
    for (const runtime of this.runtimes.values()) {
      for (const discovered of runtime.tools.values()) {
        if (discovered.ref === ref) return { runtime, discovered };
      }
    }
    throw new KairomesError(
      "MCP_TOOL_STALE",
      "找不到這個下游工具，可能已重新掛載或 schema 已變更；請重新搜尋 MCP 目錄。",
    );
  }

  async catalog(input: {
    query: string;
    server_id?: string;
    limit: number;
    refresh: boolean;
  }): Promise<McpCatalog> {
    await this.discover(input.refresh, input.server_id);
    const query = input.query.trim().toLocaleLowerCase();
    const servers = [...this.runtimes.values()]
      .filter((runtime) => !input.server_id || runtime.config.id === input.server_id)
      .map(
        (runtime): McpServerSummary => ({
          id: runtime.config.id,
          name: runtime.config.name,
          transport: runtime.config.transport.kind,
          enabled: runtime.config.enabled,
          state: runtime.state,
          tool_count: runtime.tools.size,
          enabled_tool_count: runtime.config.enabled
            ? [...runtime.tools.values()].filter((tool) => normalizeTool(runtime, tool).enabled)
                .length
            : 0,
          ...(runtime.message ? { message: runtime.message } : {}),
        }),
      );
    const all = [...this.runtimes.values()]
      .filter((runtime) => !input.server_id || runtime.config.id === input.server_id)
      .flatMap((runtime) => [...runtime.tools.values()].map((tool) => normalizeTool(runtime, tool)))
      .filter((tool) => {
        if (!query) return true;
        return [tool.name, tool.title, tool.description, tool.server_name]
          .filter(Boolean)
          .some((value) => value?.toLocaleLowerCase().includes(query));
      })
      .sort(
        (left, right) =>
          Number(right.enabled) - Number(left.enabled) ||
          `${left.server_name}\0${left.name}`.localeCompare(`${right.server_name}\0${right.name}`),
      );
    return {
      kind: "mcp_catalog",
      catalog_revision: this.revision(),
      servers,
      tools: all.slice(0, input.limit),
      truncated: all.length > input.limit,
    };
  }

  async describe(ref: string): Promise<McpToolDescription> {
    await this.discover();
    const { runtime, discovered } = this.findTool(ref);
    return {
      kind: "mcp_tool",
      catalog_revision: this.revision(),
      tool: {
        ...normalizeTool(runtime, discovered),
        input_schema: discovered.tool.inputSchema,
        ...(discovered.tool.outputSchema ? { output_schema: discovered.tool.outputSchema } : {}),
      },
    };
  }

  private trimCalls() {
    for (const [id, call] of this.calls) {
      if (Date.now() >= call.expires) this.deleteCachedCall(id);
    }
    while (this.calls.size > MAX_CACHED_CALLS || this.cachedMediaBytes > MAX_CACHED_MEDIA_BYTES) {
      const oldest = this.calls.keys().next().value;
      if (!oldest) break;
      this.deleteCachedCall(oldest);
    }
  }

  private trimRecords() {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (record.state !== "in_flight" && now >= record.expires) this.forgetCall(id);
    }
    for (const [id, record] of this.records) {
      if (this.records.size <= MAX_CALL_RECORDS) break;
      // An attempt still in flight is never forgotten, or its retry could be sent again.
      if (record.state !== "in_flight") this.forgetCall(id);
    }
  }

  private forgetCall(id: string) {
    this.records.delete(id);
    this.deleteCachedCall(id);
  }

  private async replayCall(requestId: string, record: CallRecord): Promise<McpCallExecution> {
    const outcome = record.settled ? await record.settled : undefined;
    if (outcome?.kind === "rejected") throw outcome.error;
    if (outcome?.kind === "done") return structuredClone(outcome.value);
    if (outcome?.kind === "unknown" || record.state === "unknown")
      throw new KairomesError(
        "MCP_CALL_UNKNOWN",
        "這個 request_id 的下游 MCP 呼叫先前可能已送出，但結果不明；Kairomes 不會重送。請先確認下游狀態，再決定是否以新的 request_id 呼叫。",
      );
    const cached = this.calls.get(requestId);
    if (cached) return structuredClone(cached.value);
    throw new KairomesError(
      "MCP_RESULT_EXPIRED",
      "這個 request_id 的下游 MCP 呼叫已完成，但結果已超過暫存期限；Kairomes 不會重送，請勿當成失敗而重做。",
    );
  }

  private deleteCachedCall(id: string) {
    const prior = this.calls.get(id);
    if (!prior) return;
    this.cachedMediaBytes = Math.max(0, this.cachedMediaBytes - prior.mediaBytes);
    this.calls.delete(id);
  }

  private sanitizeResult(
    requestId: string,
    revision: string,
    summary: McpCatalogTool,
    result: CallToolResult,
    argumentsPreview: Record<string, unknown>,
    durationMs: number,
  ): McpCallExecution {
    const content: McpCall["content"] = [];
    const images: McpForwardedImage[] = [];
    let textBudget = MAX_TEXT_BYTES;
    let mediaBytes = 0;
    let truncated = result.content.length > MAX_CONTENT_ITEMS;
    for (const item of result.content.slice(0, MAX_CONTENT_ITEMS)) {
      if (item.type === "text") {
        if (textBudget === 0) {
          truncated = true;
          continue;
        }
        const bounded = boundedText(item.text, textBudget);
        content.push({ type: "text", text: bounded.text });
        const used = Buffer.byteLength(bounded.text);
        textBudget = Math.max(0, textBudget - used);
        truncated ||= bounded.truncated;
      } else if (item.type === "resource_link") {
        const resourceUri = item.uri.trim();
        if (
          isLocalResourceUri(resourceUri) ||
          !resourceUri ||
          resourceUri.length > MAX_RESOURCE_URI ||
          hasControlCharacter(resourceUri)
        ) {
          content.push({ type: "text", text: "下游 MCP 回傳了不安全的資源連結；內容已省略。" });
          truncated = true;
        } else {
          content.push({
            type: "resource_link",
            name: boundedLabel(item.name, MAX_RESOURCE_NAME),
            uri: resourceUri,
            ...(item.description
              ? { description: boundedLabel(item.description, MAX_TOOL_DESCRIPTION) }
              : {}),
            ...(item.mimeType ? { mime_type: boundedLabel(item.mimeType, MAX_TOOL_TITLE) } : {}),
          });
        }
      } else if (item.type === "image") {
        const image = forwardableImage(item.data, item.mimeType);
        if (
          image &&
          images.length < MAX_IMAGE_ITEMS &&
          mediaBytes + image.bytes <= MAX_MEDIA_BYTES
        ) {
          const mediaId = crypto.randomUUID();
          content.push({ ...image.metadata, media_id: mediaId });
          images.push({ ...image.image, mediaId });
          mediaBytes += image.bytes;
        } else {
          content.push({
            type: "media_omitted",
            media_type: "image",
            mime_type: item.mimeType,
            byte_length: Buffer.byteLength(item.data, "base64"),
          });
          truncated = true;
        }
      } else if (item.type === "audio") {
        content.push({
          type: "media_omitted",
          media_type: "audio",
          mime_type: item.mimeType,
          byte_length: Buffer.byteLength(item.data, "base64"),
        });
        truncated = true;
      } else if ("blob" in item.resource) {
        const image = forwardableImage(item.resource.blob, item.resource.mimeType);
        if (
          image &&
          images.length < MAX_IMAGE_ITEMS &&
          mediaBytes + image.bytes <= MAX_MEDIA_BYTES
        ) {
          const mediaId = crypto.randomUUID();
          content.push({ ...image.metadata, media_id: mediaId });
          images.push({ ...image.image, mediaId });
          mediaBytes += image.bytes;
        } else {
          content.push({
            type: "media_omitted",
            media_type: "blob",
            ...(item.resource.mimeType ? { mime_type: item.resource.mimeType } : {}),
            byte_length: Buffer.byteLength(item.resource.blob, "base64"),
          });
          truncated = true;
        }
      } else {
        const bounded = boundedText(item.resource.text, textBudget);
        content.push({ type: "text", text: bounded.text });
        textBudget = Math.max(0, textBudget - Buffer.byteLength(bounded.text));
        truncated ||= bounded.truncated;
      }
    }
    const structured = result.structuredContent;
    const structuredBytes = structured ? Buffer.byteLength(stable(structured)) : 0;
    if (structuredBytes > MAX_STRUCTURED_BYTES) truncated = true;
    const value: McpCall = {
      kind: "mcp_call",
      request_id: requestId,
      catalog_revision: revision,
      tool: {
        ref: summary.ref,
        server_id: summary.server_id,
        server_name: summary.server_name,
        name: summary.name,
        ...(summary.title ? { title: summary.title } : {}),
      },
      is_error: result.isError === true,
      arguments_preview: argumentsPreview,
      duration_ms: durationMs,
      content,
      ...(structured && structuredBytes <= MAX_STRUCTURED_BYTES
        ? { structured_content: structured }
        : {}),
      truncated,
    };
    if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.responseBytes) {
      value.structured_content = undefined;
      value.content = [{ type: "text", text: "下游工具回傳內容超過 Kairomes 上限，已省略。" }];
      value.truncated = true;
    }
    return { data: value, images };
  }

  async call(input: {
    tool_ref: string;
    catalog_revision: string;
    arguments: Record<string, unknown>;
    request_id: string;
  }): Promise<McpCall> {
    return (await this.callWithMedia(input)).data;
  }

  async callWithMedia(
    input: {
      tool_ref: string;
      catalog_revision: string;
      arguments: Record<string, unknown>;
      request_id: string;
    },
    readOnlyOnly = false,
  ): Promise<McpCallExecution> {
    this.trimCalls();
    this.trimRecords();
    // catalog_revision is left out: a retry after a catalog refresh is still the same call.
    const fingerprint = digest({
      route: readOnlyOnly ? "read" : "action",
      tool_ref: input.tool_ref,
      arguments: input.arguments,
    });
    const prior = this.records.get(input.request_id);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new KairomesError(
          "MCP_REQUEST_ID_CONFLICT",
          "相同 request_id 已用於不同的下游 MCP 呼叫。",
        );
      this.records.delete(input.request_id);
      this.records.set(input.request_id, prior);
      return this.replayCall(input.request_id, prior);
    }
    // Claim the request_id before any await, so a concurrent identical call finds this attempt.
    let settle: (outcome: CallOutcome) => void = () => {};
    const record: CallRecord = {
      fingerprint,
      state: "in_flight",
      settled: new Promise<CallOutcome>((resolve) => {
        settle = resolve;
      }),
      expires: Date.now() + CALL_RECORD_MS,
    };
    this.records.set(input.request_id, record);
    let sent = false;
    try {
      const value = await this.sendCall(input, readOnlyOnly, () => {
        sent = true;
      });
      record.state = "done";
      this.calls.set(input.request_id, {
        value: structuredClone(value),
        mediaBytes: value.images.reduce(
          (total, image) => total + Buffer.byteLength(image.data, "base64"),
          0,
        ),
        expires: Date.now() + CACHED_CALL_MS,
      });
      this.cachedMediaBytes += this.calls.get(input.request_id)?.mediaBytes ?? 0;
      this.trimCalls();
      settle({ kind: "done", value });
      return structuredClone(value);
    } catch (error) {
      if (sent) {
        // The downstream server may have run it; never send this request_id again.
        record.state = "unknown";
        settle({ kind: "unknown" });
      } else {
        // Rejected before sending: the same request_id may be retried after fixing the cause.
        if (this.records.get(input.request_id) === record) this.records.delete(input.request_id);
        settle({ kind: "rejected", error });
      }
      throw error;
    } finally {
      record.settled = undefined;
      this.trimRecords();
    }
  }

  private async sendCall(
    input: {
      tool_ref: string;
      catalog_revision: string;
      arguments: Record<string, unknown>;
      request_id: string;
    },
    readOnlyOnly: boolean,
    markSent: () => void,
  ): Promise<McpCallExecution> {
    await this.discover();
    const currentRevision = this.revision();
    if (input.catalog_revision !== currentRevision)
      throw new KairomesError(
        "MCP_CATALOG_STALE",
        "MCP 目錄已變更；請重新搜尋並確認工具後再呼叫。",
      );
    const { runtime, discovered } = this.findTool(input.tool_ref);
    const summary = normalizeTool(runtime, discovered);
    if (!summary.enabled || summary.availability !== "ready")
      throw new KairomesError(
        "MCP_TOOL_NOT_ALLOWED",
        "此 MCP 或工具已由本機使用者停用，或目前無法使用。",
      );
    if (
      readOnlyOnly &&
      (discovered.tool.annotations?.readOnlyHint !== true ||
        discovered.tool.annotations.destructiveHint === true)
    )
      throw new KairomesError(
        "MCP_TOOL_NOT_READ_ONLY",
        "這個工具未明確宣告為唯讀；請改用 mcp_tool_call。",
      );
    if (Buffer.byteLength(stable(input.arguments)) > MAX_ARGUMENT_BYTES)
      throw new KairomesError("MCP_ARGUMENT_LIMIT", "下游 MCP 工具參數超過 Kairomes 上限。");
    let validate: ReturnType<AjvJsonSchemaValidator["getValidator"]>;
    try {
      validate = this.validator.getValidator(discovered.tool.inputSchema as JsonSchemaType);
    } catch {
      throw new KairomesError("MCP_SCHEMA_INVALID", "下游 MCP 工具的輸入 schema 無法驗證。");
    }
    const checked = validate(input.arguments);
    if (!checked.valid)
      throw new KairomesError("MCP_ARGUMENT_INVALID", "參數不符合下游 MCP 工具的 schema。");
    if (!runtime.client) throw new KairomesError("MCP_SERVER_UNAVAILABLE", "下游 MCP 目前未連線。");
    const startedAt = Date.now();
    const originalClient = runtime.client;
    const originalEpoch = runtime.connectionEpoch;
    const originalConfig = mcpConfigIdentitySource(runtime.config);
    const originalAuthEpoch = this.oauth.generation(runtime.config.id);
    await this.oauth.beforeCall(runtime.config.id);
    if (
      runtime.client !== originalClient ||
      runtime.connectionEpoch !== originalEpoch ||
      runtime.state !== "ready" ||
      mcpConfigIdentitySource(runtime.config) !== originalConfig ||
      runtime.tools.get(discovered.tool.name) !== discovered ||
      !normalizeTool(runtime, discovered).enabled ||
      this.revision() !== currentRevision
    )
      throw new KairomesError("MCP_CATALOG_STALE", "MCP 目錄已變更；請重新確認工具。");
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      markSent();
      result = await originalClient.callTool(
        { name: discovered.tool.name, arguments: input.arguments },
        undefined,
        { timeout: CALL_TIMEOUT },
      );
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (
        (code === "MCP_AUTH_REQUIRED" || code === "MCP_AUTH_SCOPE_REQUIRED") &&
        runtime.client === originalClient &&
        runtime.connectionEpoch === originalEpoch &&
        mcpConfigIdentitySource(runtime.config) === originalConfig &&
        this.oauth.generation(runtime.config.id) === originalAuthEpoch
      ) {
        this.oauth.requireLogin(runtime.config.id);
        runtime.state = "unavailable";
        throw new KairomesError("MCP_AUTH_REQUIRED", "此 MCP 需要重新登入；原工具呼叫未自動重送。");
      }
      throw new KairomesError("MCP_CALL_FAILED", "下游 MCP 工具呼叫未完成，結果可能待確認。");
    }
    if (!("content" in result) || !Array.isArray(result.content))
      throw new KairomesError("MCP_TASK_UNSUPPORTED", "目前尚不支援下游 MCP task 型工具。");
    return this.sanitizeResult(
      input.request_id,
      currentRevision,
      summary,
      result as CallToolResult,
      argumentPreview(input.arguments),
      Math.max(0, Date.now() - startedAt),
    );
  }

  activityTitle(ref: string): string | undefined {
    try {
      const { runtime, discovered } = this.findTool(ref);
      const tool = normalizeTool(runtime, discovered);
      return `${tool.server_name} · ${tool.title ?? tool.name}`;
    } catch {
      return undefined;
    }
  }

  media(mediaId: string) {
    this.trimCalls();
    for (const call of this.calls.values()) {
      const image = call.value.images.find((item) => item.mediaId === mediaId);
      if (!image) continue;
      return {
        data: Buffer.from(image.data, "base64"),
        mimeType: image.mimeType,
      };
    }
    throw new KairomesError(
      "RESULT_EXPIRED",
      "這張 MCP 圖片已超過暫存期限；請讓 ChatGPT 重新執行截圖工具。",
    );
  }

  async addStdio(input: AddStdioMount): Promise<McpMountConfig> {
    await this.load();
    await this.reloadIfChanged();
    const config = McpMountConfigSchema.parse({
      id: crypto.randomUUID(),
      name: input.name,
      enabled: true,
      transport: {
        kind: "stdio",
        command: input.command,
        args: input.args ?? [],
        ...(input.cwd ? { cwd: input.cwd } : {}),
        env: input.env ?? [],
      },
      allowed_read_tools: [],
      disabled_tools: [],
    });
    return this.addMount(config);
  }

  async addHttp(input: AddHttpMount): Promise<McpMountConfig> {
    await this.load();
    await this.reloadIfChanged();
    validateHttpUrl(input.url);
    const config = McpMountConfigSchema.parse({
      id: crypto.randomUUID(),
      name: input.name,
      enabled: true,
      transport: { kind: "http", url: input.url, header_env: input.headerEnv ?? {} },
      allowed_read_tools: [],
      disabled_tools: [],
    });
    return this.addMount(config);
  }

  async remove(id: string) {
    this.oauth.invalidate(id, true);
    await this.load();
    await this.reloadIfChanged();
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new KairomesError("MCP_SERVER_NOT_FOUND", "找不到指定的 MCP 掛載。");
    await this.disconnect(runtime);
    this.runtimes.delete(id);
    await this.persist();
  }

  async setServerEnabled(serverId: string, enabled: boolean) {
    if (!enabled) this.oauth.invalidate(serverId, true);
    await this.load();
    await this.reloadIfChanged();
    const runtime = this.runtimes.get(serverId);
    if (!runtime) throw new KairomesError("MCP_SERVER_NOT_FOUND", "找不到指定的 MCP 掛載。");
    runtime.config = { ...runtime.config, enabled };
    if (!enabled) {
      await this.disconnect(runtime);
      runtime.state = "disconnected";
      runtime.message = undefined;
    }
    await this.persist();
    if (enabled) await this.discover(true, serverId);
  }

  async setToolEnabled(
    serverId: string,
    toolName: string,
    enabled: boolean,
  ): Promise<McpCatalogTool> {
    await this.load();
    await this.reloadIfChanged();
    let runtime = this.runtimes.get(serverId);
    if (!runtime) throw new KairomesError("MCP_SERVER_NOT_FOUND", "找不到指定的 MCP 掛載。");
    if (runtime.config.enabled && !runtime.tools.has(toolName)) {
      await this.discover(true, serverId);
      runtime = this.runtimes.get(serverId);
    }
    const discovered = runtime?.tools.get(toolName);
    if (!runtime || !discovered)
      throw new KairomesError("MCP_TOOL_NOT_FOUND", "找不到指定的下游 MCP 工具。");
    runtime.config = {
      ...runtime.config,
      disabled_tools: enabled
        ? runtime.config.disabled_tools.filter((name) => name !== toolName)
        : [...new Set([...runtime.config.disabled_tools, toolName])],
      allowed_read_tools: runtime.config.allowed_read_tools.filter(
        (item) => item.name !== toolName,
      ),
    };
    await this.persist();
    return normalizeTool(runtime, discovered);
  }

  /** Backward-compatible CLI alias. Tool annotations are now risk hints, not an enablement gate. */
  async allowRead(serverId: string, toolName: string): Promise<McpCatalogTool> {
    return this.setToolEnabled(serverId, toolName, true);
  }

  /** Backward-compatible CLI alias. */
  async deny(serverId: string, toolName: string) {
    await this.setToolEnabled(serverId, toolName, false);
  }

  async refresh(serverId?: string) {
    await this.discover(true, serverId);
    return this.localState();
  }

  async localState(): Promise<LocalMcpMount[]> {
    await this.load();
    await this.reloadIfChanged();
    return [...this.runtimes.values()].map((runtime) => ({
      ...structuredClone(runtime.config),
      state: runtime.state,
      ...(runtime.message ? { message: runtime.message } : {}),
      tools: [...runtime.tools.values()].map((tool) => ({
        ...normalizeTool(runtime, tool),
        input_schema: tool.tool.inputSchema,
        ...(tool.tool.outputSchema ? { output_schema: tool.tool.outputSchema } : {}),
      })),
    }));
  }

  async panelState(): Promise<McpPanelState> {
    await this.load();
    await this.reloadIfChanged();
    // Capture policy, tools and authentication together; an async digest could cross configurations.
    return {
      catalog_revision: this.revision(),
      servers: [...this.runtimes.values()].map((runtime) => {
        const config = runtime.config;
        const fingerprint = createHash("sha256")
          .update(mcpConfigIdentitySource(config))
          .digest("hex");
        const auth = this.oauth.summary(config.id, fingerprint);
        return {
          id: config.id,
          name: config.name,
          transport: config.transport.kind,
          config_fingerprint: fingerprint,
          enabled: config.enabled,
          state: runtime.state,
          ...(runtime.message ? { message: runtime.message } : {}),
          ...(auth ? { auth } : {}),
          tools: [...runtime.tools.values()].map((tool) => normalizeTool(runtime, tool)),
        };
      }),
    };
  }

  async close() {
    this.closed = true;
    this.oauth.close();
    await this.load().catch(() => undefined);
    await Promise.all([...this.runtimes.values()].map((runtime) => this.disconnect(runtime)));
    this.calls.clear();
    this.records.clear();
    this.cachedMediaBytes = 0;
  }
}
