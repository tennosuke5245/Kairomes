import { expect, test } from "bun:test";
import { workspaceHue as sharedWorkspaceHue } from "@kairomes/protocol/ui-state";
import {
  APPROVAL_SOON_MS,
  avatarLetter,
  countdownUrgency,
  formatChecked,
  formatCountdown,
  formatRelative,
  formatRemaining,
  formatUptime,
  GRANT_SOON_MS,
  pairingRemaining,
  secondsUntil,
  workspaceHue,
} from "./format.ts";

// Local wall-clock times, so day boundaries hold in any time zone the tests run in.
const NOW = new Date(2026, 9, 6, 15, 12, 0).getTime();
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

test("relative times read 剛剛, seconds, minutes and hours today, then 昨天 or a date", () => {
  expect(formatRelative(at(-3_000), NOW)).toBe("剛剛");
  expect(formatRelative(at(-30_000), NOW)).toBe("30 秒前");
  expect(formatRelative(at(-2 * 60_000), NOW)).toBe("2 分鐘前");
  expect(formatRelative(at(-3 * 3_600_000), NOW)).toBe("3 小時前");
  expect(formatRelative(new Date(2026, 9, 5, 23, 59).toISOString(), NOW)).toBe("昨天");
  expect(formatRelative(new Date(2026, 9, 3, 9, 0).toISOString(), NOW)).toBe("10月3日");
  // A clock running ahead never shows a future time.
  expect(formatRelative(at(5_000), NOW)).toBe("剛剛");
  expect(formatRelative(null, NOW)).toBeNull();
  expect(formatRelative("not a date", NOW)).toBeNull();
  // Epoch milliseconds read the same as the ISO form; a non-finite number is missing.
  expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe("5 分鐘前");
  expect(formatRelative(Number.NaN, NOW)).toBeNull();
});

test("the last check and the uptime are stated in coarse units", () => {
  expect(formatChecked(NOW - 2_000, NOW)).toBe("剛剛檢查");
  expect(formatChecked(NOW - 10_000, NOW)).toBe("10 秒前檢查");
  expect(formatChecked(NOW - 125_000, NOW)).toBe("2 分鐘前檢查");
  expect(formatChecked(null, NOW)).toBeNull();
  expect(formatUptime(at(-20_000), NOW)).toBe("已運作不到 1 分鐘");
  expect(formatUptime(at(-38 * 60_000), NOW)).toBe("已運作 38 分鐘");
  expect(formatUptime(at(-3 * 3_600_000 - 59 * 60_000), NOW)).toBe("已運作 3 小時");
  expect(formatUptime(at(-50 * 3_600_000), NOW)).toBe("已運作 2 天");
  expect(formatUptime(null, NOW)).toBeNull();
});

test("countdowns read 剩 m:ss and 已到期, never a clock time", () => {
  expect(formatCountdown(252_000)).toBe("剩 4:12");
  expect(formatCountdown(59_001)).toBe("剩 1:00");
  expect(formatCountdown(1)).toBe("剩 0:01");
  expect(formatCountdown(3_725_000)).toBe("剩 1:02:05");
  expect(formatCountdown(0)).toBe("已到期");
  expect(formatCountdown(-5)).toBe("已到期");
});

test("grant time left reads in minutes, m:ss under two minutes, and 直到收回 without expiry", () => {
  expect(formatRemaining(null)).toBe("直到收回");
  expect(formatRemaining(0)).toBe("已到期");
  expect(formatRemaining(105_000)).toBe("剩 1:45");
  expect(formatRemaining(11 * 60_000 + 30_000)).toBe("剩 12 分");
  expect(formatRemaining(60 * 60_000)).toBe("剩 1 小時");
  expect(formatRemaining(65 * 60_000)).toBe("剩 1 小時 5 分");
});

test("urgency turns soon below the threshold and expired at zero", () => {
  expect(countdownUrgency(59_000, APPROVAL_SOON_MS)).toBe("soon");
  expect(countdownUrgency(61_000, APPROVAL_SOON_MS)).toBeUndefined();
  expect(countdownUrgency(100_000, GRANT_SOON_MS)).toBe("soon");
  expect(countdownUrgency(0, GRANT_SOON_MS)).toBe("expired");
  expect(countdownUrgency(null, GRANT_SOON_MS)).toBeUndefined();
});

test("retry seconds round up and stop once the time has passed", () => {
  expect(secondsUntil(at(7_200), NOW)).toBe(8);
  expect(secondsUntil(at(10), NOW)).toBe(1);
  expect(secondsUntil(at(0), NOW)).toBeNull();
  expect(secondsUntil(null, NOW)).toBeNull();
});

test("a pairing link counts down from when Desktop received it and then expires", () => {
  expect(pairingRemaining(NOW, 120, NOW + 15_000)).toBe(105_000);
  expect(pairingRemaining(NOW, 120, NOW + 200_000)).toBe(0);
  // A missing or absurd lifetime falls back to the Companion's two minutes, capped at an hour.
  expect(pairingRemaining(NOW, undefined, NOW)).toBe(120_000);
  expect(pairingRemaining(NOW, -1, NOW)).toBe(120_000);
  expect(pairingRemaining(NOW, 999_999, NOW)).toBe(3_600_000);
});

test("workspace hues are stable per id and the avatar uses the first character", () => {
  const ids = [
    "2ff7f6d9-a7ee-46e6-b4c4-2e21602056e4",
    "8c0f3a51-6d2e-4b7a-9f14-3e5d2c1b0a99",
    "00000000-0000-4000-8000-000000000001",
  ];
  for (const id of ids) {
    expect(workspaceHue(id)).toBe(workspaceHue(id));
    expect(workspaceHue(id)).toBeGreaterThanOrEqual(1);
    expect(workspaceHue(id)).toBeLessThanOrEqual(5);
  }
  expect(new Set(Array.from({ length: 40 }, (_, index) => workspaceHue(`id-${index}`))).size).toBe(
    5,
  );
  // Same function as the side panel and workbench, so a project keeps its colour everywhere.
  expect(workspaceHue).toBe(sharedWorkspaceHue);
  expect(avatarLetter("kairomes")).toBe("K");
  expect(avatarLetter("  個人筆記")).toBe("個");
  expect(avatarLetter("")).toBe("?");
});
