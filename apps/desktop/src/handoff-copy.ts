export type HandoffCopyPreview = { text: string; digest: string };

/** Tauri returns trusted public error messages as strings; never stringify unknown data. */
export function handoffError(caught: unknown): Error {
  if (caught instanceof Error && caught.message.trim()) return caught;
  if (typeof caught === "string" && caught.trim()) return new Error(caught);
  return new Error("無法完成接續核對。");
}

export async function copyHandoffContent(
  preview: HandoffCopyPreview,
  actions: {
    prepare(): Promise<HandoffCopyPreview>;
    writeText(text: string): Promise<void>;
    invalidate(): void;
    fallback(): void;
    active(): boolean;
  },
): Promise<boolean> {
  let prepared: HandoffCopyPreview;
  try {
    prepared = await actions.prepare();
    if (!actions.active()) return false;
    if (prepared.digest !== preview.digest || prepared.text !== preview.text)
      throw new Error("內容已改變，請重新審閱。");
  } catch (caught) {
    if (actions.active()) actions.invalidate();
    throw handoffError(caught);
  }
  try {
    await actions.writeText(prepared.text);
  } catch {
    if (actions.active()) actions.fallback();
    throw new Error("剪貼簿無法使用，內容已選取，可手動複製。");
  }
  return actions.active();
}
