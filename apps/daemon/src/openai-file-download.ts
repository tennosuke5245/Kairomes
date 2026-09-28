import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { KairomesError, LIMITS, type OpenAIFileReference } from "@kairomes/protocol";

type Lookup = typeof dnsLookup;
type Fetch = typeof fetch;

// The ChatGPT file-input contract guarantees an injected temporary HTTPS URL,
// but deliberately does not promise one fixed CDN hostname. Keep this list
// limited to OpenAI-owned delivery domains rather than treating every HTTPS
// URL supplied in a model tool call as trusted.
const trustedOpenAIRoots = ["openai.com", "chatgpt.com", "oaiusercontent.com", "oaistatic.com"];
const trustedOpenAIFileHosts = new Set(["oaidalleapiprodscus.blob.core.windows.net"]);
const maxRedirects = 2;

type OpenAIFileDownloadOptions = {
  fetch?: Fetch;
  lookup?: Lookup;
  timeoutMs?: number;
};

function unsafeIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

export function unsafeNetworkAddress(input: string) {
  const address = input.split("%")[0]?.toLocaleLowerCase() ?? "";
  const version = isIP(address);
  if (version === 4) return unsafeIpv4(address);
  if (version !== 6) return true;
  if (address.startsWith("::ffff:")) {
    const mapped = address.slice("::ffff:".length);
    return isIP(mapped) !== 4 || unsafeIpv4(mapped);
  }
  return (
    address === "::" ||
    address === "::1" ||
    /^f[cd]/u.test(address) ||
    /^fe[89ab]/u.test(address) ||
    address.startsWith("ff") ||
    address.startsWith("2001:db8:")
  );
}

export function trustedOpenAIFileHost(value: string) {
  const hostname = value.toLocaleLowerCase().replace(/\.$/u, "");
  return (
    trustedOpenAIFileHosts.has(hostname) ||
    trustedOpenAIRoots.some((root) => hostname === root || hostname.endsWith(`.${root}`))
  );
}

export function parseOpenAIFileUrl(value: string) {
  const internalReference = /^(?:\/mnt\/data\/|sandbox:|file:\/\/\/mnt\/data\/)/iu.test(
    value.trim(),
  );
  if (internalReference)
    throw new KairomesError(
      "FILE_REFERENCE_NOT_INJECTED",
      "這是 ChatGPT 執行環境內部路徑，不是可下載網址；目前不支援 ChatGPT→本機媒體匯入。",
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new KairomesError("INVALID_FILE_URL", "ChatGPT 提供的檔案下載網址格式不正確。");
  }
  const hostname = url.hostname.toLocaleLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.hash ||
    !trustedOpenAIFileHost(hostname)
  ) {
    if (url.protocol === "file:" || url.protocol === "sandbox:")
      throw new KairomesError(
        "FILE_REFERENCE_NOT_INJECTED",
        "這是 ChatGPT 執行環境內部路徑，不是可下載網址；目前不支援 ChatGPT→本機媒體匯入。",
      );
    throw new KairomesError(
      "UNTRUSTED_FILE_URL",
      "只接受 ChatGPT 注入的 OpenAI 檔案下載網址；不支援任意 URL。",
    );
  }
  return url;
}

async function resolveSafeFileHost(url: URL, lookup: Lookup) {
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => unsafeNetworkAddress(address)))
    throw new KairomesError("UNSAFE_FILE_HOST", "ChatGPT 檔案下載位置解析到不允許的網路位址。");
}

async function fetchOpenAIFile(
  initialUrl: URL,
  lookup: Lookup,
  fetcher: Fetch,
  signal: AbortSignal,
) {
  let url = initialUrl;
  for (let attempt = 0; attempt <= maxRedirects; attempt++) {
    await resolveSafeFileHost(url, lookup);
    const response = await fetcher(url, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { Accept: "image/png,image/jpeg,image/webp,application/octet-stream;q=0.5" },
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location || attempt === maxRedirects)
      throw new KairomesError(
        "FILE_REDIRECT_BLOCKED",
        "ChatGPT 檔案網址的重新導向未通過安全檢查，本次匯入已停止。",
      );
    try {
      url = parseOpenAIFileUrl(new URL(location, url).toString());
    } catch {
      throw new KairomesError(
        "FILE_REDIRECT_BLOCKED",
        "ChatGPT 檔案網址的重新導向未通過安全檢查，本次匯入已停止。",
      );
    }
  }
  throw new KairomesError("FILE_REDIRECT_BLOCKED", "ChatGPT 檔案重新導向次數過多。");
}

export async function downloadOpenAIFile(
  reference: OpenAIFileReference,
  options: OpenAIFileDownloadOptions = {},
) {
  const url = parseOpenAIFileUrl(reference.download_url);
  const resolve = options.lookup ?? dnsLookup;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 20_000);
  timer.unref();
  try {
    const response = await fetchOpenAIFile(url, resolve, options.fetch ?? fetch, abort.signal);
    if (!response.ok)
      throw new KairomesError(
        "FILE_DOWNLOAD_FAILED",
        `ChatGPT 檔案下載失敗（HTTP ${response.status}）。短效網址可能已過期，請重試同一個匯入動作。`,
      );
    const declared = response.headers.get("content-length");
    if (declared && Number(declared) > LIMITS.artifactBytes)
      throw new KairomesError("ARTIFACT_TOO_LARGE", "圖片超過 25 MiB 匯入上限。");
    if (!response.body)
      throw new KairomesError("FILE_DOWNLOAD_FAILED", "ChatGPT 檔案下載回應沒有內容。");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > LIMITS.artifactBytes) {
          await reader.cancel();
          throw new KairomesError("ARTIFACT_TOO_LARGE", "圖片超過 25 MiB 匯入上限。");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (bytes === 0) throw new KairomesError("FILE_DOWNLOAD_FAILED", "ChatGPT 檔案內容是空的。");
    return Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      bytes,
    );
  } catch (error) {
    if (abort.signal.aborted)
      throw new KairomesError("FILE_DOWNLOAD_TIMEOUT", "下載 ChatGPT 檔案逾時，請稍後重試。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
