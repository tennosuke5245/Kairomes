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
