import { toneFor, type UiDataTone } from "@kairomes/protocol/ui-state";

/** Panel ↔ local workbench link, as shown by the logo dot and the 一般 settings row. */
export type ConnectionState =
  | "unpaired"
  | "browse"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "invalid";

export function connectionView(state: ConnectionState): {
  tone: UiDataTone;
  label: string;
  pulse: boolean;
} {
  if (state === "connected" || state === "connecting" || state === "reconnecting") {
    const view = toneFor("connection", state);
    return { tone: view.dataTone, label: view.label, pulse: state !== "connected" };
  }
  if (state === "invalid") return { tone: "danger", label: "配對已失效", pulse: false };
  if (state === "browse") return { tone: "neutral", label: "僅可瀏覽", pulse: false };
  return { tone: "neutral", label: "未配對", pulse: false };
}

/** 需確認: always present once paired; neutral, and only the count badge is crimson. */
export function needButton(count: number) {
  const pending = Math.max(0, Math.floor(count));
  return {
    count: String(pending),
    badge: pending ? badgeCount(pending) : "",
    ariaLabel: pending ? `需確認 ${pending} 件` : "需確認，目前沒有請求",
  };
}

/** 執行中: shown only while work runs, so it never reserves space in an idle toolbar. */
export function activeIndicator(count: number) {
  const running = Math.max(0, Math.floor(count));
  return {
    hidden: running === 0,
    badge: badgeCount(running),
    ariaLabel: `執行中 ${running} 項`,
  };
}

function badgeCount(count: number) {
  return count > 99 ? "99+" : String(count);
}

/**
 * Text for the browser toolbar badge (chrome.action). It only counts decisions the panel can
 * act on right now: an offline or unpaired panel clears it rather than show a stale count.
 */
export function actionBadgeText(pending: number, connected: boolean) {
  return connected && pending > 0 ? badgeCount(Math.floor(pending)) : "";
}
