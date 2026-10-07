import { type PillIcon, type RowTone, TONE_PILL_ICON } from "./checks.ts";
import { formatUptime, secondsUntil } from "./format.ts";
import { type DesktopSnapshot, PROFILE_FACT, PROFILE_NAME, tunnelReasonAction } from "./model.ts";

/**
 * 連線設定 (A10): three rows, each a state pill, one meta sentence and at most two actions.
 * The kind tile is tinted by state (warning or danger only), never by identity.
 */

export type ConnectionAction =
  | "set_key"
  | "update_key"
  | "change_key"
  | "get_key"
  | "forget_key"
  | "download_client"
  | "restart_tunnel"
  | "stop_tunnel"
  | "start_tunnel"
  | "restart_runtime"
  | "pair"
  | "repair";

export const CONNECTION_ACTION_LABELS: Record<ConnectionAction, string> = {
  set_key: "設定金鑰",
  update_key: "更新金鑰",
  change_key: "更換金鑰",
  get_key: "取得 Runtime API Key",
  forget_key: "移除金鑰…",
  download_client: "下載 tunnel-client",
  restart_tunnel: "重新啟動",
  stop_tunnel: "停止",
  start_tunnel: "啟動安全通道",
  restart_runtime: "重新啟動本機服務…",
  pair: "產生配對連結",
  repair: "重新產生",
};

export type ConnectionRow = {
  tone: RowTone;
  pill: string;
  pillIcon: PillIcon;
  meta: string;
  /** At most two, in visual order. */
  actions: ConnectionAction[];
};

function state(
  tone: RowTone,
  pill: string,
  meta: string,
  actions: ConnectionAction[] = [],
  pillIcon: PillIcon = TONE_PILL_ICON[tone],
): ConnectionRow {
  return { tone, pill, pillIcon, meta, actions };
}

export const PANEL_META = "在 ChatGPT 旁顯示動態；需確認的請求在側欄審核。";

export function keyRow(snapshot: DesktopSnapshot): ConnectionRow {
  const tunnel = snapshot.companion?.tunnel;
  if (!snapshot.credentialConfigured)
    return state(
      "warning",
      "尚未設定",
      "安全通道用這把金鑰連上 ChatGPT；由作業系統保管，不會交給模型。",
      ["set_key", "get_key"],
    );
  if (tunnel?.state === "error" && tunnel.reason === "auth")
    return state("danger", "被拒絕", "ChatGPT 拒絕了這把金鑰；更新後會自動重新連線。", [
      "update_key",
      "forget_key",
    ]);
  return state("success", "已保存", "由作業系統保管，只用於安全通道，不會交給模型。", [
    "change_key",
    "forget_key",
  ]);
}

const TUNNEL_FAILURE: Record<string, string> = {
  network: "連不上 ChatGPT；確認網路後再重新啟動。",
  workbench: "接不上本機工作台。",
};

export function tunnelRow(snapshot: DesktopSnapshot, now: number): ConnectionRow {
  const tunnel = snapshot.companion?.tunnel;
  if (!tunnel)
    return state(
      "neutral",
      "等待本機服務",
      "本機服務啟動後才能管理安全通道。",
      [],
      "HourglassMedium",
    );
  if (
    tunnel.state === "missing" ||
    tunnel.reason === "not_installed" ||
    !snapshot.tunnelClientInstalled
  )
    return state(
      "warning",
      "找不到 tunnel-client",
      "下載 OpenAI 官方 tunnel-client 並放進 PATH，Kairomes 會自動找到它。",
      ["download_client"],
    );
  if (tunnel.state === "running")
    return state(
      "success",
      "執行中",
      [PROFILE_FACT, formatUptime(tunnel.startedAt, now)].filter(Boolean).join(" · "),
      ["restart_tunnel", "stop_tunnel"],
    );
  if (tunnel.state === "starting") return state("running", "啟動中", "通常幾秒內完成。");
  if (tunnel.state === "stopped")
    return snapshot.credentialConfigured
      ? state(
          "neutral",
          "已暫停",
          "ChatGPT 暫時無法讀取你的專案。",
          ["start_tunnel"],
          "PauseCircle",
        )
      : state("neutral", "已暫停", "設定 Runtime API Key 後才能啟動。", [], "PauseCircle");
  const retryIn = secondsUntil(tunnel.nextRetryAt, now);
  if (retryIn !== null)
    return state("running", "自動重試中", `安全通道中斷，將於 ${retryIn} 秒後重試。`);
  if (tunnel.reason === "auth")
    // The key row names the cause, the fix and that the Tunnel reconnects; this row adds the profile.
    return state("neutral", "等待金鑰", PROFILE_FACT, [], "PauseCircle");
  if (tunnel.reason === "profile_missing")
    return state(
      "warning",
      "找不到 profile",
      `找不到名為 ${PROFILE_NAME} 的 Tunnel profile；建立後再重新啟動。`,
      ["restart_tunnel"],
    );
  // A workbench failure restarts the local service behind its confirmation (tunnelReasonAction).
  const fix = tunnelReasonAction(tunnel.reason);
  return state("danger", "中斷", TUNNEL_FAILURE[tunnel.reason ?? ""] ?? "安全通道意外停止。", [
    fix === "restart_runtime" ? "restart_runtime" : "restart_tunnel",
  ]);
}

export type PairingState = {
  /** A one-time link is on screen right now. */
  live: boolean;
  /** A link was shown earlier on this visit and has been cleared. */
  cleared: boolean;
};

export function panelRow(snapshot: DesktopSnapshot, pairing: PairingState): ConnectionRow {
  const companion = snapshot.companion;
  // Without the local service nothing about pairing is known, so nothing is claimed or offered.
  if (!companion)
    return state("neutral", "等待本機服務", "本機服務啟動後才能配對側欄。", [], "HourglassMedium");
  const configured = companion.extension.configured;
  const actions: ConnectionAction[] =
    configured && !pairing.live ? [pairing.cleared ? "repair" : "pair"] : [];
  const paired = companion.attention.pairedPanels;
  if (paired !== null && paired > 0) return state("success", "側欄已連線", PANEL_META, actions);
  if (!configured) return state("warning", "尚未配對", PANEL_META);
  // An external workbench may not report pairings; then only the setting is known.
  return paired === null
    ? state("neutral", "已設定", PANEL_META, actions, "Question")
    : state("neutral", "已設定，未連線", PANEL_META, actions);
}
