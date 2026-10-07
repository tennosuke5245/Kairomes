/** The single full-height body below the toolbar. The toolbar itself never changes height. */
export type PanelView = "setup" | "settings" | "approvals" | "workbench" | "empty";

export function panelView(state: {
  settingsOpen: boolean;
  approvalsOpen: boolean;
  /** A workbench URL is known (paired, or a browse-only link). */
  hasWorkbench: boolean;
  /** The iframe has been given that URL. */
  frameLoaded: boolean;
}): PanelView {
  if (state.settingsOpen) return "settings";
  if (state.approvalsOpen) return "approvals";
  if (!state.hasWorkbench) return "setup";
  return state.frameLoaded ? "workbench" : "empty";
}

/** The settings back button returns to wherever the body came from. */
export function settingsBackLabel(hasWorkbench: boolean) {
  return hasWorkbench ? "返回工作台" : "返回配對";
}

/**
 * Trusted diagnostic for image imports in 設定 › 一般: how ChatGPT's image_import_request calls
 * arrived since the workbench started (file attached, no file, or a file reference rejected).
 * Undefined before the first call or from an older workbench, so nothing is claimed.
 */
export function importHydrationText(
  counts: { hydrated: number; omitted: number; rejected: number } | undefined,
) {
  if (!counts) return undefined;
  const { hydrated, omitted, rejected } = counts;
  if (hydrated + omitted + rejected === 0) return undefined;
  return `圖片匯入請求：附圖 ${hydrated} · 未附圖 ${omitted} · 被拒 ${rejected}`;
}
