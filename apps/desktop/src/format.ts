/**
 * Display formatting for Desktop (spec §7.5): relative times today, then 昨天 or a date;
 * countdowns as 剩 m:ss; never a seconds-precision clock time. Pure and locale-fixed so the
 * output is the same in tests, previews and the app.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function startOfDay(time: number) {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * 剛剛 · 30 秒前 · 2 分鐘前 · 3 小時前 (today) · 昨天 · 10月3日. Takes an ISO string or epoch
 * milliseconds; null for a missing or unreadable time.
 */
export function formatRelative(
  when: string | number | null | undefined,
  now = Date.now(),
): string | null {
  const time =
    typeof when === "string" ? Date.parse(when) : typeof when === "number" ? when : Number.NaN;
  if (!Number.isFinite(time)) return null;
  const ago = Math.max(0, now - time);
  if (ago < 10 * SECOND) return "剛剛";
  if (ago < MINUTE) return `${Math.floor(ago / SECOND)} 秒前`;
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} 分鐘前`;
  const today = startOfDay(now);
  if (time >= today) return `${Math.floor(ago / HOUR)} 小時前`;
  if (time >= today - DAY) return "昨天";
  const date = new Date(time);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** How long ago the last status arrived: 剛剛檢查 · 10 秒前檢查 · 2 分鐘前檢查. */
export function formatChecked(checkedAt: number | null, now = Date.now()): string | null {
  if (checkedAt === null || !Number.isFinite(checkedAt)) return null;
  const ago = Math.max(0, now - checkedAt);
  if (ago < 5 * SECOND) return "剛剛檢查";
  if (ago < MINUTE) return `${Math.floor(ago / SECOND)} 秒前檢查`;
  return `${Math.floor(ago / MINUTE)} 分鐘前檢查`;
}

/** Running time since an ISO start: 已運作 不到 1 分鐘 · 12 分鐘 · 3 小時 · 2 天. */
export function formatUptime(startedAt: string | null | undefined, now = Date.now()) {
  if (typeof startedAt !== "string") return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const elapsed = Math.max(0, now - start);
  if (elapsed < MINUTE) return "已運作不到 1 分鐘";
  if (elapsed < HOUR) return `已運作 ${Math.floor(elapsed / MINUTE)} 分鐘`;
  if (elapsed < DAY) return `已運作 ${Math.floor(elapsed / HOUR)} 小時`;
  return `已運作 ${Math.floor(elapsed / DAY)} 天`;
}

function clock(ms: number) {
  const total = Math.ceil(ms / SECOND);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** Approval and pairing countdown: 剩 4:12; 已到期 once it passes. */
export function formatCountdown(remainingMs: number): string {
  return remainingMs > 0 ? `剩 ${clock(remainingMs)}` : "已到期";
}

/**
 * Autonomy grant time left: 剩 1 小時 5 分 · 剩 12 分 · under two minutes 剩 1:45;
 * null means the grant lasts until the user revokes it.
 */
export function formatRemaining(remainingMs: number | null): string {
  if (remainingMs === null) return "直到收回";
  if (remainingMs <= 0) return "已到期";
  if (remainingMs < 2 * MINUTE) return `剩 ${clock(remainingMs)}`;
  const minutes = Math.ceil(remainingMs / MINUTE);
  if (minutes < 60) return `剩 ${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `剩 ${hours} 小時 ${rest} 分` : `剩 ${hours} 小時`;
}

/** `data-urgency` for a countdown: soon under the threshold, expired at zero. */
export function countdownUrgency(
  remainingMs: number | null,
  soonMs: number,
): "soon" | "expired" | undefined {
  if (remainingMs === null) return undefined;
  if (remainingMs <= 0) return "expired";
  return remainingMs < soonMs ? "soon" : undefined;
}

/** Approvals turn urgent under a minute, grants and pairing links under two (spec §4). */
export const APPROVAL_SOON_MS = MINUTE;
export const GRANT_SOON_MS = 2 * MINUTE;
export const PAIRING_SOON_MS = 30 * SECOND;

/** Whole seconds until an automatic retry, at least 1 while it is still pending; null when none. */
export function secondsUntil(iso: string | null | undefined, now = Date.now()): number | null {
  if (typeof iso !== "string") return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time) || time <= now) return null;
  return Math.max(1, Math.ceil((time - now) / SECOND));
}

/**
 * A pairing link's remaining lifetime from the moment Desktop received it. The link is a
 * one-time credential: once this reaches 0 the UI clears it and offers 重新產生.
 */
export function pairingRemaining(
  receivedAt: number,
  expiresInSeconds: number | undefined,
  now = Date.now(),
): number {
  const lifetime =
    typeof expiresInSeconds === "number" &&
    Number.isFinite(expiresInSeconds) &&
    expiresInSeconds > 0
      ? Math.min(expiresInSeconds, 3600)
      : 120;
  return Math.max(0, receivedAt + lifetime * SECOND - now);
}

/** Deterministic decorative hue ws-1 … ws-5, the same function as the side panel and workbench. */
export { workspaceHue } from "@kairomes/protocol/ui-state";

/** First visible character of a project name, upper-cased for Latin names. */
export function avatarLetter(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase("en") : "?";
}
