import type {
  ImageImportDownloadResult,
  ImageImportHydrationDetail,
  ImageImportRejectionReason,
  ImageImportVerifyFailure,
} from "@kairomes/protocol";

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

const rejectionLabels: Record<ImageImportRejectionReason, string> = {
  sandbox_path: "沙箱路徑",
  non_https: "非 HTTPS",
  host_not_allowed: "網域不在清單",
  malformed: "格式錯誤",
  length: "長度超限",
};
const downloadLabels: Record<ImageImportDownloadResult, string> = {
  ok: "成功",
  dns: "DNS",
  unsafe_address: "不允許的位址",
  http_4xx: "HTTP 4xx",
  http_5xx: "HTTP 5xx",
  empty: "空內容",
  network: "網路",
  redirect: "重新導向",
  timeout: "逾時",
  not_image: "不是圖片",
  too_large: "過大",
  cancelled: "已取消",
};
const verifyLabels: Record<ImageImportVerifyFailure, string> = {
  extension_mismatch: "副檔名不符",
  invalid_image: "圖片無效",
  dimensions: "尺寸過大",
  animated: "動畫",
  other: "其他",
};

/** Non-zero items of one category, in the fixed order of its labels. */
function counted<K extends string>(counts: Record<K, number>, labels: Record<K, string>) {
  return (Object.keys(labels) as K[])
    .filter((key) => (counts[key] ?? 0) > 0)
    .map((key) => `${labels[key]} ${counts[key]}`);
}

/**
 * Trusted diagnostic under importHydrationText: where ChatGPT's image delivery stopped, as
 * counts in fixed categories only (never a URL, host or file ID). Undefined while everything is
 * 0 or from an older workbench without the detail.
 */
export function importHydrationDetailText(detail: ImageImportHydrationDetail | undefined) {
  if (!detail) return undefined;
  const parts: string[] = [];
  if (detail.created > 0) parts.push(`建立 ${detail.created}`);
  if (detail.retried > 0) parts.push(`重送 ${detail.retried}`);
  const results = counted(detail.download_results, downloadLabels);
  if (detail.download_attempts > 0 || results.length)
    parts.push(
      `下載 ${detail.download_attempts}${results.length ? `（${results.join("、")}）` : ""}`,
    );
  const rejected = counted(detail.rejected, rejectionLabels);
  if (rejected.length) parts.push(`被拒：${rejected.join("、")}`);
  const failed = counted(detail.verify_failed, verifyLabels);
  if (failed.length) parts.push(`驗證失敗：${failed.join("、")}`);
  if (!parts.length) return undefined;
  return `交付細節：${parts.join(" · ")}`;
}
