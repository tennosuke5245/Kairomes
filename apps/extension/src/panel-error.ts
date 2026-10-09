/** The stream dropped: what is wrong, and what the panel is showing meanwhile (spec §7). */
export const STALE_NOTICE = "本機工作台沒有回應，顯示的是上次內容。";
export const UNKNOWN_NOTICE = "結果待確認。";

/** Preserve the main recovery reason instead of replacing it with an unrelated read failure. */
export function panelErrorMessage(
  message: string,
  state: { paired: boolean; stale: boolean; approvalUnknown: boolean },
) {
  if (state.paired && state.stale) return STALE_NOTICE;
  if (state.paired && state.approvalUnknown) return UNKNOWN_NOTICE;
  return message;
}

export type NoticeTone = "danger" | "warning" | "success" | "neutral";

/** What the notice action does: re-read or reconnect (`refresh`) or leave the pairing (`pair`). */
export type NoticeActionKind = "refresh" | "pair";

/** One message for the panel's single notice slot (spec §4 Notice). */
export interface PanelNotice {
  message: string;
  tone: NoticeTone;
  action?: { kind: NoticeActionKind; label: string };
}

export interface RecoveryState {
  /** A connection exists and its pairing has not been invalidated. */
  paired: boolean;
  /** The pairing was rejected (401/403 or a different instance). */
  needsPairing: boolean;
  /** A snapshot is shown but the stream cannot authorize decisions. */
  stale: boolean;
  /** An approval or access change was sent but its result is unconfirmed. */
  approvalUnknown: boolean;
  /** The unconfirmed access change can only be cleared by leaving the pairing. */
  accessRecovery: boolean;
  /** The caller's preferred repair for this message. */
  repair: NoticeActionKind;
}

/**
 * Maps the panel's recovery state to one notice: one status sentence plus one action. A
 * stale snapshot or an unconfirmed result outranks unrelated read errors, and nothing here
 * retries a mutation: the action only re-reads state, reconnects, or leaves the pairing.
 */
export function panelRecoveryNotice(
  message: string,
  state: RecoveryState,
): PanelNotice | undefined {
  const text =
    panelErrorMessage(message, {
      paired: state.paired,
      stale: state.stale,
      approvalUnknown: state.approvalUnknown,
    }) || (state.needsPairing ? "配對已失效。" : "");
  if (!text) return undefined;
  const kind: NoticeActionKind = state.accessRecovery || state.needsPairing ? "pair" : state.repair;
  const label =
    kind === "pair"
      ? state.accessRecovery
        ? "解除配對"
        : "重新配對"
      : state.stale && !state.approvalUnknown
        ? "重新連線"
        : "查詢狀態";
  const tone: NoticeTone = text === STALE_NOTICE || text === UNKNOWN_NOTICE ? "warning" : "danger";
  return { message: text, tone, action: { kind, label } };
}

/** Notices that repeat the visible one are dropped instead of re-announced. */
export function sameNotice(a: PanelNotice | undefined, b: PanelNotice | undefined) {
  return (
    a?.message === b?.message &&
    a?.tone === b?.tone &&
    a?.action?.kind === b?.action?.kind &&
    a?.action?.label === b?.action?.label
  );
}

/** A recovery notice always outranks a transient one (a pairing hint or a success line). */
export function visibleNotice(recovery?: PanelNotice, transient?: PanelNotice) {
  return recovery ?? transient;
}

/** Success auto-dismisses after 4 s; everything else stays until it is resolved or closed. */
export const NOTICE_SUCCESS_MS = 4000;
