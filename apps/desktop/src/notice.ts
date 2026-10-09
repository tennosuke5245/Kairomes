/**
 * The single Desktop notice slot (spec §4 Notice): one message at a time, new replaces old,
 * repeats collapse, success dismisses itself. Pure so the slot rules are testable without a DOM.
 */

export type NoticeTone = "success" | "warning" | "danger" | "neutral";

export type Notice = {
  tone: NoticeTone;
  text: string;
  /** Messages with the same source share a key, so recovery can clear only its own message. */
  source?: "status" | "action" | "handoff";
};

/** Success messages clear themselves after this long; others stay until replaced or closed. */
export const NOTICE_SUCCESS_MS = 4000;

/** Status reads that fail show this fixed text, never the raw error. */
export const STATUS_ERROR_TEXT = "暫時讀不到 Kairomes 狀態；會自動重試。";

export function sameNotice(a: Notice | null, b: Notice | null) {
  return a?.tone === b?.tone && a?.text === b?.text && a?.source === b?.source;
}

/**
 * Applies the next message to the slot. A repeat returns the current object unchanged, so a
 * status error raised by every poll is announced once instead of every two seconds.
 */
export function nextNotice(current: Notice | null, next: Notice | null): Notice | null {
  return sameNotice(current, next) ? current : next;
}

/** Clears the slot only when it holds a message from `source` (e.g. status recovered). */
export function clearNotice(current: Notice | null, source: Notice["source"]): Notice | null {
  return current && current.source === source ? null : current;
}

/** Danger interrupts (role=alert); everything else is polite (role=status). */
export function noticeRole(tone: NoticeTone): "alert" | "status" {
  return tone === "danger" ? "alert" : "status";
}

/** The message of a failed action: the host's fixed text when there is one, else a fallback. */
export function errorText(caught: unknown, fallback: string): string {
  if (caught instanceof Error && caught.message) return caught.message;
  if (typeof caught === "string" && caught) return caught;
  return fallback;
}

/** Most folders one pick or drop may add, so a stray drop of a large tree cannot flood the list. */
export const MAX_FOLDERS_PER_ADD = 20;

/**
 * One message for a batch of added folders (multi-select or drag and drop): which were added,
 * and the first host error when some were not. The host's text is already a fixed sentence.
 */
export function addProjectsNotice(added: readonly string[], failures: readonly string[]): Notice {
  const [first] = failures;
  if (!first)
    return {
      tone: "success",
      text: added.length === 1 ? `已加入「${added[0]}」。` : `已加入 ${added.length} 個專案。`,
      source: "action",
    };
  if (!added.length)
    return {
      tone: "danger",
      text: failures.length === 1 ? first : `${failures.length} 個資料夾都沒有加入：${first}`,
      source: "action",
    };
  return {
    tone: "warning",
    text: `已加入 ${added.length} 個專案；${failures.length} 個資料夾沒有加入：${first}`,
    source: "action",
  };
}
