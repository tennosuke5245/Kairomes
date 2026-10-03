import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { checkServerIdentity } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

export const MCP_OAUTH_NETWORK_LIMITS = Object.freeze({
  timeoutMs: 10_000,
  maxTimeoutMs: 30_000,
  requestBytes: 1024 * 1024,
  oauthResponseBytes: 1024 * 1024,
  mcpResponseBytes: 16 * 1024 * 1024,
  dnsAddresses: 32,
});

export type McpOAuthNetworkCode =
  | "MCP_AUTH_REQUIRED"
  | "MCP_AUTH_SCOPE_REQUIRED"
  | "MCP_OAUTH_URL_BLOCKED"
  | "MCP_OAUTH_DNS_BLOCKED"
  | "MCP_OAUTH_REDIRECT_BLOCKED"
  | "MCP_OAUTH_REQUEST_LIMIT"
  | "MCP_OAUTH_RESPONSE_LIMIT"
  | "MCP_OAUTH_RESPONSE_INVALID"
  | "MCP_OAUTH_NETWORK_TIMEOUT"
  | "MCP_OAUTH_NETWORK_FAILED"
  | "MCP_OAUTH_ABORTED"
  | "MCP_OAUTH_POLICY_INVALID";

const messages: Record<McpOAuthNetworkCode, string> = {
  MCP_AUTH_REQUIRED: "服務要求重新登入；工具結果待確認。",
  MCP_AUTH_SCOPE_REQUIRED: "服務要求新的授權；工具結果待確認。",
  MCP_OAUTH_URL_BLOCKED: "此登入服務網址不受支援。",
  MCP_OAUTH_DNS_BLOCKED: "此登入服務網路位址不受支援。",
  MCP_OAUTH_REDIRECT_BLOCKED: "服務回傳了不允許的重新導向。",
  MCP_OAUTH_REQUEST_LIMIT: "登入服務請求超過限制。",
  MCP_OAUTH_RESPONSE_LIMIT: "登入服務回應超過限制。",
  MCP_OAUTH_RESPONSE_INVALID: "登入服務回應格式不受支援。",
  MCP_OAUTH_NETWORK_TIMEOUT: "登入服務連線逾時。",
  MCP_OAUTH_NETWORK_FAILED: "無法連接登入服務。",
  MCP_OAUTH_ABORTED: "登入服務請求已取消。",
  MCP_OAUTH_POLICY_INVALID: "登入服務網路設定無效。",
};

/** Contains no remote URL, response body, callback values or original error. */
export class McpOAuthNetworkError extends Error {
  constructor(readonly code: McpOAuthNetworkCode) {
    super(messages[code]);
    this.name = "McpOAuthNetworkError";
  }
}

export interface McpOAuthAddress {
  address: string;
  family: 4 | 6;
}

export interface McpOAuthPinnedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body?: Uint8Array;
  address: McpOAuthAddress;
  signal: AbortSignal;
}

export type McpOAuthResolver = (hostname: string) => Promise<McpOAuthAddress[]>;
export type McpOAuthRequester = (request: McpOAuthPinnedRequest) => Promise<Response>;
export interface McpOAuthNetworkOptions {
  resolver?: McpOAuthResolver;
  requester?: McpOAuthRequester;
  /** MCP headers only; OAuth requests retain the deadline until the body is read. */
  timeoutMs?: number;
  oauthResponseBytes?: number;
  mcpResponseBytes?: number;
}

const oauthHeaders = new Set(["accept", "content-type", "mcp-protocol-version"]);
const blockedMcpHeaders = new Set([
  "host",
  "connection",
  "proxy-authorization",
  "proxy-connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);
const hostnameOf = (url: URL) =>
  url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();

/** Conservative IANA policy: special-purpose blocks have no per-address exceptions.
 * https://www.iana.org/assignments/iana-ipv4-special-registry/
 * https://www.iana.org/assignments/iana-ipv6-special-registry/
 * https://www.iana.org/assignments/ipv6-address-space/
 */
export function isPublicMcpOAuthAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6 || address.includes("%")) return false;
  const [first = "", second = "0"] = address.split(":");
  const a = Number.parseInt(first, 16);
  const b = Number.parseInt(second || "0", 16);
  return (
    a >= 0x2000 &&
    a <= 0x3fff &&
    !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) &&
    a !== 0x2002 &&
    a !== 0x3ffe &&
    !(a === 0x3fff && b < 0x1000)
  );
}

function publicUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new McpOAuthNetworkError("MCP_OAUTH_URL_BLOCKED");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.href.includes("#"))
    throw new McpOAuthNetworkError("MCP_OAUTH_URL_BLOCKED");
  const host = hostnameOf(url);
  if (isIP(host)) {
    if (!isPublicMcpOAuthAddress(host)) throw new McpOAuthNetworkError("MCP_OAUTH_DNS_BLOCKED");
  } else if (
    !host.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion)$/.test(host) ||
    host === "home.arpa" ||
    host.endsWith(".home.arpa")
  ) {
    throw new McpOAuthNetworkError("MCP_OAUTH_DNS_BLOCKED");
  }
  return url;
}

const defaultResolver: McpOAuthResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));

/** Node invokes this lookup at connection time; it never delegates back to DNS. */
export function createMcpOAuthPinnedLookup(address: McpOAuthAddress): LookupFunction {
  if (isIP(address.address) !== address.family || !isPublicMcpOAuthAddress(address.address))
    throw new McpOAuthNetworkError("MCP_OAUTH_DNS_BLOCKED");
  const pinned = { ...address };
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ ...pinned }]);
    else callback(null, pinned.address, pinned.family);
  };
}

function safeFailure(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted && signal.reason instanceof McpOAuthNetworkError) return signal.reason;
  return error instanceof McpOAuthNetworkError
    ? error
    : new McpOAuthNetworkError("MCP_OAUTH_NETWORK_FAILED");
}

/** Connect to an IP literally, independent of runtime lookup implementation. */
export function createMcpOAuthPinnedRequestOptions(input: McpOAuthPinnedRequest): RequestOptions {
  const url = publicUrl(input.url);
  const hostname = hostnameOf(url);
  const headers = Object.fromEntries(input.headers);
  headers.host = url.host;
  headers["accept-encoding"] = "gzip, deflate, br";
  return {
    protocol: "https:",
    hostname: input.address.address,
    family: input.address.family,
    port: url.port ? Number(url.port) : 443,
    path: `${url.pathname}${url.search}`,
    method: input.method,
    headers,
    agent: false,
    maxHeaderSize: 16 * 1024,
    servername: isIP(hostname) ? "" : hostname,
    rejectUnauthorized: true,
    checkServerIdentity: (_name, certificate) => checkServerIdentity(hostname, certificate),
    lookup: createMcpOAuthPinnedLookup(input.address),
  };
}

const defaultRequester: McpOAuthRequester = (input) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const request = httpsRequest(createMcpOAuthPinnedRequestOptions(input), (incoming) => {
      const status = incoming.statusCode ?? 0;
      if (status < 200 || status > 599) {
        incoming.destroy();
        reject(new McpOAuthNetworkError("MCP_OAUTH_RESPONSE_INVALID"));
        return;
      }
      const responseHeaders = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2)
        responseHeaders.append(
          incoming.rawHeaders[index] ?? "",
          incoming.rawHeaders[index + 1] ?? "",
        );
      const encoding = responseHeaders.get("content-encoding")?.trim().toLowerCase();
      const decoder =
        encoding === "gzip"
          ? createGunzip()
          : encoding === "deflate"
            ? createInflate()
            : encoding === "br"
              ? createBrotliDecompress()
              : undefined;
      if (encoding && encoding !== "identity" && !decoder) {
        incoming.destroy();
        reject(new McpOAuthNetworkError("MCP_OAUTH_RESPONSE_INVALID"));
        return;
      }
      if (decoder) {
        responseHeaders.delete("content-encoding");
        responseHeaders.delete("content-length");
        incoming.on("error", (error) => decoder.destroy(error));
        decoder.on("close", () => incoming.destroy());
        incoming.pipe(decoder);
      }
      const body =
        input.method === "HEAD" || status === 204 || status === 205 || status === 304
          ? null
          : (Readable.toWeb(decoder ?? incoming, {
              strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
            }) as unknown as ReadableStream<Uint8Array>);
      if (!body) incoming.resume();
      settled = true;
      resolve(new Response(body, { status, headers: responseHeaders }));
    });
    const abort = () => request.destroy(safeFailure(undefined, input.signal));
    input.signal.addEventListener("abort", abort, { once: true });
    request.on("error", (error) => {
      if (!settled) reject(safeFailure(error, input.signal));
    });
    request.on("close", () => input.signal.removeEventListener("abort", abort));
    if (input.signal.aborted) abort();
    else request.end(input.body);
  });

function operationScope(timeoutMs: number, parent?: AbortSignal | null) {
  const controller = new AbortController();
  const abort = (code: McpOAuthNetworkCode) => {
    if (!controller.signal.aborted) controller.abort(new McpOAuthNetworkError(code));
  };
  const cancel = () => abort("MCP_OAUTH_ABORTED");
  parent?.addEventListener("abort", cancel, { once: true });
  if (parent?.aborted) cancel();
  const timer = setTimeout(() => abort("MCP_OAUTH_NETWORK_TIMEOUT"), timeoutMs);
  const deadlineComplete = () => clearTimeout(timer);
  const dispose = () => {
    deadlineComplete();
    parent?.removeEventListener("abort", cancel);
  };
  return { signal: controller.signal, abort, deadlineComplete, dispose };
}

async function active<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw safeFailure(undefined, signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(safeFailure(undefined, signal));
    signal.addEventListener("abort", abort, { once: true });
    value.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(safeFailure(undefined, signal));
        else resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(safeFailure(error, signal));
      },
    );
  });
}

async function requestBody(body: BodyInit | null | undefined): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return;
  let bytes: Uint8Array;
  if (typeof body === "string" || body instanceof URLSearchParams) {
    const text = String(body);
    if (Buffer.byteLength(text) > MCP_OAUTH_NETWORK_LIMITS.requestBytes)
      throw new McpOAuthNetworkError("MCP_OAUTH_REQUEST_LIMIT");
    bytes = new TextEncoder().encode(text);
  } else if (body instanceof Blob) {
    if (body.size > MCP_OAUTH_NETWORK_LIMITS.requestBytes)
      throw new McpOAuthNetworkError("MCP_OAUTH_REQUEST_LIMIT");
    bytes = new Uint8Array(await body.arrayBuffer());
  } else if (body instanceof ArrayBuffer) {
    if (body.byteLength > MCP_OAUTH_NETWORK_LIMITS.requestBytes)
      throw new McpOAuthNetworkError("MCP_OAUTH_REQUEST_LIMIT");
    bytes = new Uint8Array(body.slice(0));
  } else if (ArrayBuffer.isView(body)) {
    if (body.byteLength > MCP_OAUTH_NETWORK_LIMITS.requestBytes)
      throw new McpOAuthNetworkError("MCP_OAUTH_REQUEST_LIMIT");
    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
  } else throw new McpOAuthNetworkError("MCP_OAUTH_REQUEST_LIMIT");
  if (bytes.byteLength > MCP_OAUTH_NETWORK_LIMITS.requestBytes)
    throw new McpOAuthNetworkError("MCP_OAUTH_REQUEST_LIMIT");
  return bytes;
}

function toolCall(method: string, body?: Uint8Array) {
  if (method !== "POST" || !body) return false;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    const matches = (item: unknown) =>
      Boolean(
        item &&
          typeof item === "object" &&
          "jsonrpc" in item &&
          item.jsonrpc === "2.0" &&
          "method" in item &&
          item.method === "tools/call",
      );
    return Array.isArray(value) ? value.some(matches) : matches(value);
  } catch {
    return false;
  }
}

/** Match a syntactically valid Bearer challenge, not a substring in another realm. */
function insufficientScope(header: string | null) {
  if (!header || header.length > 16 * 1024) return false;
  const segments: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < header.length; index++) {
    const character = header[index];
    if (escaped) escaped = false;
    else if (quoted && character === "\\") escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ",") {
      segments.push(header.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted || escaped) return false;
  segments.push(header.slice(start).trim());
  let bearer = false;
  let valid = true;
  let error: string | undefined;
  const seen = new Set<string>();
  const matched = () => bearer && valid && error === "insufficient_scope";
  for (let segment of segments) {
    const scheme = /^([!#$%&'*+.^_`|~\w-]+)(?:\s+(.*))?$/.exec(segment);
    if (scheme) {
      if (matched()) return true;
      bearer = scheme[1]?.toLowerCase() === "bearer";
      valid = true;
      error = undefined;
      seen.clear();
      segment = scheme[2] ?? "";
    }
    if (!bearer || !segment) continue;
    const parameter =
      /^([!#$%&'*+.^_`|~\w-]+)\s*=\s*(?:"((?:[^"\\\r\n]|\\[^\r\n])*)"|([!#$%&'*+.^_`|~\w-]+))$/.exec(
        segment,
      );
    const name = parameter?.[1]?.toLowerCase();
    if (!parameter || !name || seen.has(name)) valid = false;
    else {
      seen.add(name);
      if (name === "error") error = (parameter[2] ?? parameter[3] ?? "").replace(/\\(.)/g, "$1");
    }
  }
  return matched();
}

function boundedResponse(
  response: Response,
  limit: number,
  scope: ReturnType<typeof operationScope>,
) {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > limit)
    throw new McpOAuthNetworkError("MCP_OAUTH_RESPONSE_LIMIT");
  if (!response.body) {
    scope.dispose();
    return new Response(null, { status: response.status, headers: response.headers });
  }
  const reader = response.body.getReader();
  let bytes = 0;
  let finished = false;
  let abort: (() => void) | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (abort) scope.signal.removeEventListener("abort", abort);
    scope.dispose();
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        abort = () => {
          if (finished) return;
          finish();
          controller.error(safeFailure(undefined, scope.signal));
          void reader.cancel().catch(() => undefined);
        };
        scope.signal.addEventListener("abort", abort, { once: true });
        if (scope.signal.aborted) abort();
      },
      async pull(controller) {
        try {
          const next = await active(reader.read(), scope.signal);
          if (finished) return;
          if (next.done) {
            finish();
            controller.close();
            return;
          }
          bytes += next.value.byteLength;
          if (bytes > limit) throw new McpOAuthNetworkError("MCP_OAUTH_RESPONSE_LIMIT");
          controller.enqueue(next.value);
        } catch (error) {
          if (finished) return;
          const failure = safeFailure(error, scope.signal);
          scope.abort(failure.code);
          if (!finished) {
            finish();
            controller.error(failure);
          }
          await reader.cancel().catch(() => undefined);
        }
      },
      async cancel() {
        finish();
        scope.abort("MCP_OAUTH_ABORTED");
        await reader.cancel().catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(stream, { status: response.status, headers: response.headers });
}

function configuredLimit(value: number | undefined, fallback: number, maximum: number) {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
    throw new McpOAuthNetworkError("MCP_OAUTH_POLICY_INVALID");
  return limit;
}

export function createMcpOAuthNetwork(
  endpoint: string | URL,
  options: McpOAuthNetworkOptions = {},
) {
  const target = publicUrl(endpoint).href;
  const resolver = options.resolver ?? defaultResolver;
  const requester = options.requester ?? defaultRequester;
  const timeout = configuredLimit(
    options.timeoutMs,
    MCP_OAUTH_NETWORK_LIMITS.timeoutMs,
    MCP_OAUTH_NETWORK_LIMITS.maxTimeoutMs,
  );
  const oauthLimit = configuredLimit(
    options.oauthResponseBytes,
    MCP_OAUTH_NETWORK_LIMITS.oauthResponseBytes,
    MCP_OAUTH_NETWORK_LIMITS.oauthResponseBytes,
  );
  const mcpLimit = configuredLimit(
    options.mcpResponseBytes,
    MCP_OAUTH_NETWORK_LIMITS.mcpResponseBytes,
    MCP_OAUTH_NETWORK_LIMITS.mcpResponseBytes,
  );

  async function addressFor(url: URL, signal: AbortSignal) {
    const hostname = hostnameOf(url);
    const family = isIP(hostname);
    const addresses = family
      ? [{ address: hostname, family: family as 4 | 6 }]
      : await active(resolver(hostname), signal);
    if (
      !addresses.length ||
      addresses.length > MCP_OAUTH_NETWORK_LIMITS.dnsAddresses ||
      addresses.some(
        (address) =>
          isIP(address.address) !== address.family || !isPublicMcpOAuthAddress(address.address),
      )
    )
      throw new McpOAuthNetworkError("MCP_OAUTH_DNS_BLOCKED");
    return { ...addresses[0] } as McpOAuthAddress;
  }

  async function perform(input: string | URL, init: RequestInit | undefined, mcp: boolean) {
    const scope = operationScope(timeout, init?.signal);
    let response: Response | undefined;
    try {
      const url = publicUrl(input);
      if (mcp && url.href !== target) throw new McpOAuthNetworkError("MCP_OAUTH_URL_BLOCKED");
      const method = (init?.method ?? "GET").toUpperCase();
      if (!["GET", "POST", "DELETE", "HEAD"].includes(method))
        throw new McpOAuthNetworkError("MCP_OAUTH_REQUEST_LIMIT");
      const body = await active(requestBody(init?.body), scope.signal);
      if ((method === "GET" || method === "HEAD") && body)
        throw new McpOAuthNetworkError("MCP_OAUTH_REQUEST_LIMIT");
      const headers = new Headers();
      for (const [name, value] of new Headers(init?.headers))
        if (mcp ? !blockedMcpHeaders.has(name) : oauthHeaders.has(name)) headers.set(name, value);
      const address = await addressFor(url, scope.signal);
      const requesting = requester({ url, method, headers, body, address, signal: scope.signal });
      void requesting.then(
        (late) => {
          if (scope.signal.aborted) void late.body?.cancel().catch(() => undefined);
        },
        () => undefined,
      );
      response = await active(requesting, scope.signal);
      if (response.status >= 300 && response.status < 400)
        throw new McpOAuthNetworkError("MCP_OAUTH_REDIRECT_BLOCKED");
      if (mcp && toolCall(method, body)) {
        if (response.status === 401) throw new McpOAuthNetworkError("MCP_AUTH_REQUIRED");
        if (response.status === 403 && insufficientScope(response.headers.get("www-authenticate")))
          throw new McpOAuthNetworkError("MCP_AUTH_SCOPE_REQUIRED");
      }
      if (mcp) {
        scope.deadlineComplete();
        return boundedResponse(response, mcpLimit, scope);
      }
      const bounded = boundedResponse(response, oauthLimit, scope);
      const bytes = await active(bounded.arrayBuffer(), scope.signal);
      scope.dispose();
      return new Response(bytes.byteLength ? bytes : null, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      const failure = safeFailure(error, scope.signal);
      scope.abort(failure.code);
      scope.dispose();
      await response?.body?.cancel().catch(() => undefined);
      throw failure;
    }
  }

  const oauthFetch: FetchLike = (input, init) => perform(input, init, false);
  const mcpFetch: FetchLike = (input, init) => perform(input, init, true);
  const fetch: FetchLike = (input, init) => {
    try {
      return perform(input, init, publicUrl(input).href === target);
    } catch (error) {
      return Promise.reject(safeFailure(error));
    }
  };
  async function validateAuthorizationTarget(input: string | URL): Promise<URL> {
    const scope = operationScope(timeout);
    try {
      const url = publicUrl(input);
      await addressFor(url, scope.signal);
      return url;
    } catch (error) {
      throw safeFailure(error, scope.signal);
    } finally {
      scope.dispose();
    }
  }
  return { fetch, oauthFetch, mcpFetch, validateAuthorizationTarget };
}
