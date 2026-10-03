/** Preserve the main recovery reason instead of replacing it with an unrelated read failure. */
export function panelErrorMessage(
  message: string,
  state: { paired: boolean; stale: boolean; approvalUnknown: boolean },
) {
  if (state.paired && state.stale) return "顯示上次快照。";
  if (state.paired && state.approvalUnknown) return "結果待確認。";
  return message;
}
