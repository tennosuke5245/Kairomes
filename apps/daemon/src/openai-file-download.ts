import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import {
  KairomesError,
  LIMITS,
  OPENAI_FILE_REFERENCE_LIMITS,
  type OpenAIFileReference,
} from "@kairomes/protocol";
import { imageSignature } from "@kairomes/workspace-core";

/** Same shape as `dns.promises.lookup(hostname, { all: true, verbatim: true })`. */
export type FileLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;
/** One HTTPS GET whose connection must go to `address`, the address that passed the checks. */
export type PinnedFileRequest = {
  url: URL;
  address: { address: string; family: 4 | 6 };
  signal: AbortSignal;
};
export type FileTransport = (request: PinnedFileRequest) => Promise<Response>;

/**
 * Hosts that may serve a ChatGPT file parameter. The Apps SDK promises a temporary HTTPS
 * download URL but no fixed CDN host; today these are `files.oaiusercontent.com` and other
 * `*.oaiusercontent.com` hosts, plus signed `chatgpt.com/backend-api/...` content URLs. The list
 * stays limited to OpenAI-owned roots instead of trusting every HTTPS URL in a tool call.
 */
const trustedOpenAIRoots = ["oaiusercontent.com", "chatgpt.com", "openai.com", "oaistatic.com"];
const trustedOpenAIFileHosts = new Set(["oaidalleapiprodscus.blob.core.windows.net"]);
const maxRedirects = 2;
const downloadTimeoutMs = 20_000;
const accept = "image/png,image/jpeg,image/webp,application/octet-stream;q=0.5";

export type OpenAIFileDownloadOptions = {
  lookup?: FileLookup;
  transport?: FileTransport;
  timeoutMs?: number;
  /** Aborts the download, for example when the import is cancelled. */
  signal?: AbortSignal;
};

function sourceRejected(message: string) {
  return new KairomesError("IMPORT_SOURCE_REJECTED", message);
}

function unsafeIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    return true;
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 address, or undefined when it is not one. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address;
  const tail: number[] = [];
  if (text.includes(".")) {
    const index = text.lastIndexOf(":");
    const v4 = text.slice(index + 1);
    if (isIP(v4) !== 4) return undefined;
    const [a, b, c, d] = v4.split(".").map(Number) as [number, number, number, number];
    tail.push((a << 8) | b, (c << 8) | d);
    text = text.slice(0, index + 1);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string) =>
    part === "" ? [] : part.split(":").map((group) => Number.parseInt(group, 16));
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const fill = 8 - tail.length - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return undefined;
  const groups = [...head, ...new Array<number>(Math.max(fill, 0)).fill(0), ...rest, ...tail];
  if (groups.length !== 8 || groups.some((group) => !(group >= 0 && group <= 0xffff)))
    return undefined;
  return groups;
}

/**
 * True for every address a download must not reach: private, loopback, link-local, CGNAT,
 * multicast, documentation, benchmarking and other non-global ranges. IPv6 is accepted only
 * inside global unicast 2000::/3 minus its special-purpose blocks; IPv4-mapped and NAT64
 * addresses are judged by the IPv4 address they carry.
 */
export function unsafeNetworkAddress(input: string) {
  const address = input.split("%")[0]?.toLocaleLowerCase() ?? "";
  const version = isIP(address);
  if (version === 4) return unsafeIpv4(address);
  if (version !== 6) return true;
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const embedded = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  // ::ffff:0:0/96 (IPv4-mapped) and 64:ff9b::/96 (NAT64 well-known prefix).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff)
    return unsafeIpv4(embedded);
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
    return unsafeIpv4(embedded);
  if ((g0 & 0xe000) !== 0x2000) return true;
  return (
    (g0 === 0x2001 && g1 < 0x200) ||
    (g0 === 0x2001 && g1 === 0xdb8) ||
    g0 === 0x2002 ||
    (g0 === 0x3fff && g1 < 0x1000)
  );
}

export function trustedOpenAIFileHost(value: string) {
  const hostname = value.toLocaleLowerCase();
  return (
    trustedOpenAIFileHosts.has(hostname) ||
    trustedOpenAIRoots.some((root) => hostname === root || hostname.endsWith(`.${root}`))
  );
}

export function parseOpenAIFileUrl(value: string) {
  if (/^(?:\/mnt\/|sandbox:|file:)/iu.test(value.trim()))
    throw sourceRejected(
      "這是 ChatGPT 執行環境內的路徑，不是 ChatGPT 交付的檔案；請改由使用者在 Kairomes 側欄放入圖片。",
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw sourceRejected("圖片下載網址格式不正確；請改由使用者在 Kairomes 側欄放入圖片。");
  }
  const hostname = url.hostname.toLocaleLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash ||
    hostname.endsWith(".") ||
    isIP(hostname.replace(/^\[|\]$/gu, "")) !== 0 ||
    !trustedOpenAIFileHost(hostname)
  )
    throw sourceRejected(
      "只接受 ChatGPT 交付的 OpenAI 檔案下載網址，不下載任意網址或 Base64；請改由使用者在 Kairomes 側欄放入圖片。",
    );
  return url;
}

/**
 * Checks a file object from a tool call before any network request: bounded fields and an
 * HTTPS download URL on an OpenAI-owned host. Sandbox paths, data: URLs (Base64), other
 * schemes and arbitrary hosts are rejected with IMPORT_SOURCE_REJECTED.
 */
export function checkFileReference(reference: OpenAIFileReference) {
  const limit = OPENAI_FILE_REFERENCE_LIMITS;
  if (
    reference.download_url.length < 1 ||
    reference.download_url.length > limit.download_url ||
    reference.file_id.length < 1 ||
    reference.file_id.length > limit.file_id ||
    (reference.mime_type?.length ?? 0) > limit.mime_type ||
    (reference.file_name?.length ?? 0) > limit.file_name
  )
    throw sourceRejected("圖片檔案參照的欄位長度不正確；請改由使用者在 Kairomes 側欄放入圖片。");
  return parseOpenAIFileUrl(reference.download_url);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function resolveSafeAddress(url: URL, lookup: FileLookup, signal: AbortSignal) {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await abortable(lookup(url.hostname, { all: true, verbatim: true }), signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new KairomesError("FILE_DOWNLOAD_FAILED", "無法解析圖片下載位置，請稍後重試。");
  }
  if (!addresses.length || addresses.some(({ address }) => unsafeNetworkAddress(address)))
    throw new KairomesError("UNSAFE_FILE_HOST", "圖片下載位置解析到不允許的網路位址，已停止下載。");
  const first = addresses[0] as { address: string; family: number };
  return { address: first.address, family: isIP(first.address) === 6 ? 6 : 4 } as const;
}

function webResponse(message: IncomingMessage) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const status = message.statusCode ?? 502;
  const empty = status < 200 || [204, 205, 304].includes(status);
  if (empty) message.resume();
  const body = empty
    ? null
    : new ReadableStream<Uint8Array>({
        start(controller) {
          message.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          message.on("end", () => controller.close());
          message.on("error", (error) => controller.error(error));
        },
        cancel() {
          message.destroy();
        },
      });
  return new Response(body, { status: status >= 200 && status <= 599 ? status : 502, headers });
}

/**
 * HTTPS GET over a fresh connection to the already checked address. The custom `lookup`
 * answers only with that address, so the socket cannot follow a second, rebound DNS answer,
 * while `servername` and the default certificate checks still verify the original hostname.
 * No cookies, credentials, Referer or proxy settings are used.
 */
export function pinnedHttpsTransport(request: typeof https.request = https.request): FileTransport {
  return ({ url, address, signal }) =>
    new Promise<Response>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const hostname = url.hostname;
      const outgoing = request(
        {
          protocol: "https:",
          hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          agent: false,
          servername: hostname,
          headers: { Accept: accept, "Accept-Encoding": "identity" },
          lookup: ((
            host: string,
            options: { all?: boolean } | undefined,
            callback: (...args: unknown[]) => void,
          ) => {
            if (host !== hostname) {
              callback(new Error("unexpected lookup"));
              return;
            }
            if (options?.all) callback(null, [{ ...address }]);
            else callback(null, address.address, address.family);
          }) as never,
        },
        (message) => {
          signal.addEventListener("abort", () => message.destroy(new Error("aborted")), {
            once: true,
          });
          resolve(webResponse(message));
        },
      );
      signal.addEventListener("abort", () => outgoing.destroy(new Error("aborted")), {
        once: true,
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
}

async function fetchChecked(
  initialUrl: URL,
  lookup: FileLookup,
  transport: FileTransport,
  signal: AbortSignal,
) {
  let url = initialUrl;
  for (let attempt = 0; attempt <= maxRedirects; attempt++) {
    const address = await resolveSafeAddress(url, lookup, signal);
    const response = await transport({ url, address, signal });
    if (response.status < 300 || response.status >= 400) return response;
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get("location");
    if (!location || attempt === maxRedirects)
      throw new KairomesError(
        "FILE_REDIRECT_BLOCKED",
        "圖片下載網址的重新導向未通過安全檢查，已停止下載。",
      );
    try {
      url = parseOpenAIFileUrl(new URL(location, url).toString());
    } catch {
      throw new KairomesError(
        "FILE_REDIRECT_BLOCKED",
        "圖片下載網址重新導向到不允許的位置，已停止下載。",
      );
    }
  }
  throw new KairomesError("FILE_REDIRECT_BLOCKED", "圖片下載網址重新導向次數過多。");
}

/**
 * Downloads a ChatGPT file parameter into memory: HTTPS only, OpenAI-owned hosts only, every
 * DNS answer must be a public address and the connection is pinned to the checked one, at most
 * two redirects (each re-checked the same way), 20 seconds in total and at most 25 MiB counted
 * while streaming. The body must start with a PNG, JPEG or WebP signature whatever its
 * Content-Type says, so an HTML page or JSON error stops after its first bytes. Errors never
 * carry the URL or the remote body.
 */
export async function downloadOpenAIFile(
  reference: OpenAIFileReference,
  options: OpenAIFileDownloadOptions = {},
) {
  const url = checkFileReference(reference);
  const lookup = options.lookup ?? (dnsLookup as unknown as FileLookup);
  const transport = options.transport ?? pinnedHttpsTransport();
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, options.timeoutMs ?? downloadTimeoutMs);
  timer.unref?.();
  const cancel = () => abort.abort();
  if (options.signal?.aborted) abort.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Buffer[] = [];
  try {
    const response = await fetchChecked(url, lookup, transport, abort.signal);
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new KairomesError(
        "FILE_DOWNLOAD_FAILED",
        `ChatGPT 檔案下載失敗（HTTP ${response.status}）；短效網址可能已過期。`,
      );
    }
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > LIMITS.artifactBytes) {
      await response.body?.cancel().catch(() => {});
      throw new KairomesError("ARTIFACT_TOO_LARGE", "圖片超過 25 MiB 匯入上限。");
    }
    if (!response.body)
      throw new KairomesError("FILE_DOWNLOAD_FAILED", "ChatGPT 檔案下載回應沒有內容。");
    const reader = response.body.getReader();
    let bytes = 0;
    let signatureChecked = false;
    const checkSignature = () => {
      signatureChecked = true;
      if (!imageSignature(Buffer.concat(chunks, bytes)))
        throw new KairomesError(
          "IMPORT_NOT_IMAGE",
          "下載內容不是 PNG、JPEG 或 WebP 圖片（可能是網頁或錯誤訊息）。",
        );
    };
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > LIMITS.artifactBytes)
          throw new KairomesError("ARTIFACT_TOO_LARGE", "圖片超過 25 MiB 匯入上限。");
        chunks.push(Buffer.from(next.value));
        if (!signatureChecked && bytes >= 12) checkSignature();
      }
      if (bytes === 0) throw new KairomesError("FILE_DOWNLOAD_FAILED", "ChatGPT 檔案內容是空的。");
      if (!signatureChecked) checkSignature();
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const data = Buffer.concat(chunks, bytes);
    for (const chunk of chunks) chunk.fill(0);
    return data;
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    if (options.signal?.aborted)
      throw new KairomesError("IMPORT_CANCELLED", "匯入已取消，下載已停止。");
    if (timedOut)
      throw new KairomesError("FILE_DOWNLOAD_TIMEOUT", "下載 ChatGPT 檔案逾時，請稍後重試。");
    if (error instanceof KairomesError) throw error;
    // Network errors can name hosts or addresses; report a fixed category instead.
    throw new KairomesError(
      "FILE_DOWNLOAD_FAILED",
      "無法下載 ChatGPT 提供的圖片；短效網址可能已失效。",
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
