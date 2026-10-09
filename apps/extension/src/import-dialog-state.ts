// Pure rules for the 匯入圖片 dialog, kept apart from the DOM so they can be tested.

export type DialogPhase = "edit" | "creating" | "uploading" | "verifying" | "approving";

/**
 * Enter in the path field. It never runs the one-step create, upload and approve: it only checks
 * the path and moves on to 匯入, which needs its own click. While an input method is composing
 * (Zhuyin, Pinyin, Japanese…) Enter picks a candidate and is left alone entirely. Chrome reports
 * that keydown with `isComposing`; Safari ends the composition first but still sends keyCode 229.
 */
export function pathEnterAction(
  event: { key: string; isComposing?: boolean; keyCode?: number },
  composing = false,
): "none" | "check" {
  if (event.key !== "Enter") return "none";
  if (composing || event.isComposing || event.keyCode === 229) return "none";
  return "check";
}

/**
 * What 取消 or Esc does. Creating, uploading and reading back can be abandoned (an abandoned
 * create or upload counts as unconfirmed, and the dialog withdraws its own import). Only the
 * decision itself is waited for, since its result must be shown.
 */
export function dialogCancelAction(phase: DialogPhase): "close" | "abort" | "wait" {
  if (phase === "edit") return "close";
  return phase === "approving" ? "wait" : "abort";
}
