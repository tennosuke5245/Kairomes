// Pure time copy for the workbench (design spec §7 rule 5). Local time only; no Intl so the
// strings are stable across hosts: 剛剛, 30 秒前, 2 分鐘前, 下午 3:12, 昨天 下午 3:12, 10月3日.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

function yesterdayOf(now: number) {
  const day = new Date(now);
  day.setDate(day.getDate() - 1);
  return day;
}

/** 上午 9:05 / 下午 3:12 (12 at noon reads 下午 12:00, midnight 上午 12:00). */
export function clockTime(timestamp: number) {
  const date = new Date(timestamp);
  const hours = date.getHours();
  return `${hours < 12 ? "上午" : "下午"} ${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Relative within the last hour, a clock time later today, then 昨天 or a date. Future
 * timestamps (clock skew) read 剛剛. Seconds step by ten so a 10 s tick stays accurate.
 */
export function relativeTime(timestamp: number, now: number) {
  const elapsed = now - timestamp;
  if (elapsed < 10 * SECOND) return "剛剛";
  if (elapsed < MINUTE) return `${Math.floor(elapsed / (10 * SECOND)) * 10} 秒前`;
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分鐘前`;
  const date = new Date(timestamp);
  if (sameDay(date, new Date(now))) return clockTime(timestamp);
  if (sameDay(date, yesterdayOf(now))) return `昨天 ${clockTime(timestamp)}`;
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === new Date(now).getFullYear() ? day : `${date.getFullYear()}年${day}`;
}

/**
 * When a terminal was opened, labelled so it is not read as the row's last-activity time:
 * 剛剛開啟, 3 分鐘前開啟, 下午 12:59 開啟.
 */
export function openedTime(timestamp: number, now: number) {
  const time = relativeTime(timestamp, now);
  return /前$|^剛剛$/.test(time) ? `${time}開啟` : `${time} 開啟`;
}

export type TimeGroup = "recent" | "today" | "earlier";
export const TIME_GROUP_LABELS: Record<TimeGroup, string> = {
  recent: "剛剛",
  today: "今天",
  earlier: "更早",
};
const RECENT_WINDOW = 10 * MINUTE;

export function timeGroup(timestamp: number, now: number): TimeGroup {
  if (now - timestamp < RECENT_WINDOW) return "recent";
  return sameDay(new Date(timestamp), new Date(now)) ? "today" : "earlier";
}

/** Buckets in a fixed 剛剛 → 今天 → 更早 order; each bucket keeps its input order. */
export function groupByTime<T>(items: readonly T[], timeOf: (item: T) => number, now: number) {
  const buckets = new Map<TimeGroup, T[]>([
    ["recent", []],
    ["today", []],
    ["earlier", []],
  ]);
  for (const item of items) buckets.get(timeGroup(timeOf(item), now))?.push(item);
  return [...buckets]
    .filter(([, members]) => members.length > 0)
    .map(([group, members]) => ({ group, label: TIME_GROUP_LABELS[group], items: members }));
}

/** 0:14, 12:05, 1:02:03: a running timer (已執行 m:ss). */
export function clockDuration(milliseconds: number) {
  const total = Math.max(0, Math.floor(milliseconds / SECOND));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** A finished run: 不到 0.1 秒, 0.4 秒, 4.2 秒, 42 秒, 6 分鐘, 1 小時 5 分鐘. */
export function formatDuration(milliseconds: number) {
  const value = Math.max(0, milliseconds);
  if (value < 100) return "不到 0.1 秒";
  if (value < 10 * SECOND) return `${(Math.floor(value / 100) / 10).toFixed(1)} 秒`;
  if (value < MINUTE) return `${Math.floor(value / SECOND)} 秒`;
  if (value < HOUR) return `${Math.floor(value / MINUTE)} 分鐘`;
  const minutes = Math.floor((value % HOUR) / MINUTE);
  return `${Math.floor(value / HOUR)} 小時${minutes ? ` ${minutes} 分鐘` : ""}`;
}

export type CountdownUrgency = "soon" | "expired" | undefined;

/** Approval expiry: 剩 4:12; under a minute it is urgent; at zero it reads 已到期. */
export function countdown(
  expiresAt: number,
  now: number,
): { text: string; urgency: CountdownUrgency } {
  const left = expiresAt - now;
  if (left <= 0) return { text: "已到期", urgency: "expired" };
  return {
    text: `剩 ${clockDuration(Math.ceil(left / SECOND) * SECOND)}`,
    urgency: left < MINUTE ? "soon" : undefined,
  };
}
