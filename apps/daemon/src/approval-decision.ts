import { DenialReasonSchema, KairomesError } from "@kairomes/protocol";
import { redactKnownSecrets } from "@kairomes/workspace-core";

/**
 * Managers re-check what the trusted routes already validated: only a denial may carry a
 * reason, and it must still satisfy the shared schema. Runs before any state changes. The
 * reason goes to the model, so known credential formats are redacted like file reads; a
 * redaction marker is never longer than what it replaces.
 */
export function denialReason(approve: boolean, reason: string | undefined) {
  if (reason === undefined) return undefined;
  if (approve) throw new KairomesError("APPROVAL_REASON", "只有拒絕時可以附上原因。");
  return redactKnownSecrets(DenialReasonSchema.parse(reason));
}
