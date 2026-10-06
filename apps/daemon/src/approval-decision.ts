import { DenialReasonSchema, KairomesError } from "@kairomes/protocol";
import { redactKnownSecrets } from "@kairomes/workspace-core";

const LOCAL_URL_MARKER = "[LOCAL URL]";
const TOKEN_MARKER = "[TOKEN REDACTED]";
const loopbackHost = String.raw`(?:localhost|[a-z0-9-]+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|\[::ffff:127(?:\.\d{1,3}){3}\])`;
const urlTail = String.raw`(?:[/?#][\x21-\x7e]*)?`;
/** A loopback URL with a scheme; the shortest, `http://[::1]`, is longer than the marker. */
const loopbackUrl = new RegExp(
  String.raw`\bhttps?:\/\/${loopbackHost}(?::\d{1,5})?${urlTail}`,
  "gi",
);
/** `localhost:4318/...` or `127.0.0.1:4318/...` without a scheme; at least marker length. */
const loopbackHostPort = new RegExp(
  String.raw`\b(?:localhost|127(?:\.\d{1,3}){3}):\d{1,5}\b${urlTail}`,
  "gi",
);
/** Workbench, admin, panel and Companion tokens and pairing codes are 64 hex characters. */
const hexSecret = /\b[0-9a-f]{64,}\b/gi;

/**
 * Kairomes' own credentials. The approval page and pairing links are loopback URLs with a
 * 64-hex secret in the fragment, and both say never to hand them to the model; a reason pasted
 * from either must not do so. Every marker is no longer than the shortest text it replaces.
 */
function redactLocalCredentials(value: string) {
  return value
    .replace(loopbackUrl, LOCAL_URL_MARKER)
    .replace(loopbackHostPort, LOCAL_URL_MARKER)
    .replace(hexSecret, TOKEN_MARKER);
}

/**
 * Managers re-check what the trusted routes already validated: only a denial may carry a
 * reason, and it must still satisfy the shared schema. Runs before any state changes. The
 * reason goes to the model, so known credential formats are redacted like file reads, and so
 * are loopback URLs and 64-hex tokens. A redaction marker is never longer than what it
 * replaces, so the result still fits the schema's length limit.
 */
export function denialReason(approve: boolean, reason: string | undefined) {
  if (reason === undefined) return undefined;
  if (approve) throw new KairomesError("APPROVAL_REASON", "只有拒絕時可以附上原因。");
  return redactLocalCredentials(redactKnownSecrets(DenialReasonSchema.parse(reason)));
}
