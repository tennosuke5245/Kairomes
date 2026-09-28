import { KairomesError } from "@kairomes/protocol";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function messageOf(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

export async function requestPairingUrl(
  origin: string,
  adminToken: string,
  extensionId: string,
  fetcher: Fetcher = fetch,
) {
  const response = await fetcher(`${origin}/api/pairing/create`, {
    method: "POST",
    redirect: "error",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ extensionId }),
    signal: AbortSignal.timeout(5000),
  });
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    result = undefined;
  }
  if (response.status === 404)
    throw new KairomesError(
      "APP_UPDATE_REQUIRED",
      "目前 app 仍是舊版，請重新啟動 app 與 Tunnel 後再產生配對連結。",
    );
  if (!response.ok)
    throw new KairomesError("PAIRING_FAILED", messageOf(result) ?? "無法產生配對連結。");
  const pairingUrl =
    result && typeof result === "object"
      ? (result as { pairingUrl?: unknown }).pairingUrl
      : undefined;
  if (typeof pairingUrl !== "string")
    throw new KairomesError("PAIRING_FAILED", "app 回傳的配對連結無效。");
  return pairingUrl;
}
