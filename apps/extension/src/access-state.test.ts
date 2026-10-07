import { expect, test } from "bun:test";
import type { AccessGrant } from "@kairomes/protocol";
import {
  accessChip,
  activeGrants,
  expiryClock,
  formatRemaining,
  grantAnnouncements,
  grantPhase,
  grantRemaining,
  grantTime,
  grantTimeText,
  spokenRemaining,
} from "./access-state.ts";

const now = 1_000_000_000;
const grant = (overrides: Partial<AccessGrant> = {}): AccessGrant => ({
  id: "grant-one",
  workspace_id: "one",
  workspace_name: "Kairomes",
  level: "full",
  expires_at: now + 12 * 60_000 + 5_000,
  ...overrides,
});

test("remaining time comes only from expires_at and never goes negative", () => {
  expect(grantRemaining(grant(), now)).toBe(725_000);
  expect(grantRemaining(grant({ expires_at: now - 1 }), now)).toBe(0);
  expect(grantRemaining(grant({ expires_at: null }), now)).toBeNull();
});

test("countdowns read m:ss, h:mm:ss above an hour, and round up", () => {
  expect(formatRemaining(725_000)).toBe("12:05");
  expect(formatRemaining(59_001)).toBe("1:00");
  expect(formatRemaining(1)).toBe("0:01");
  expect(formatRemaining(0)).toBe("0:00");
  expect(formatRemaining(-5_000)).toBe("0:00");
  expect(formatRemaining(4 * 3_600_000)).toBe("4:00:00");
  expect(formatRemaining(3_600_000 + 65_000)).toBe("1:01:05");
  expect(spokenRemaining(725_000)).toBe("12 分 5 秒");
  expect(spokenRemaining(120_000)).toBe("2 分");
  expect(spokenRemaining(9_000)).toBe("9 秒");
  expect(spokenRemaining(3_660_000)).toBe("1 小時 1 分");
});

test("a grant of an hour or more shows its expiry clock instead of h:mm:ss", () => {
  // Local clock times, so the test reads the same in every time zone.
  const start = new Date(2026, 9, 6, 13, 30, 20).getTime();
  expect(grantTime(start + 12 * 60_000 + 5_000, start)).toEqual({
    lead: "剩 ",
    value: "12:05",
    tail: "",
  });
  // 59:59.5 rounds up to an hour, which is no longer a m:ss countdown.
  expect(grantTime(start + 3_599_000, start)).toEqual({ lead: "剩 ", value: "59:59", tail: "" });
  expect(grantTime(start + 3_599_500, start)).toEqual({
    lead: "",
    value: "14:31",
    tail: " 到期",
  });
  // Rounded up to the minute, so it never reads as over while the grant still holds.
  expect(grantTimeText(grantTime(start + 60 * 60_000, start))).toBe("14:31 到期");
  expect(grantTimeText(grantTime(start + 4 * 60 * 60_000 - 20_000, start))).toBe("17:30 到期");
  expect(expiryClock(new Date(2026, 9, 6, 17, 30).getTime(), start)).toBe("17:30");
  // A 4-hour grant past midnight keeps the bare clock; 12 hours or more names the day.
  const late = new Date(2026, 9, 6, 23, 0).getTime();
  expect(expiryClock(late + 4 * 60 * 60_000, late)).toBe("03:00");
  expect(expiryClock(late + 13 * 60 * 60_000, late)).toBe("10月7日 12:00");
  const chip = accessChip({
    grants: [grant({ expires_at: start + 4 * 60 * 60_000 })],
    workspaceId: "one",
    available: true,
    unknown: false,
    now: start,
  });
  expect(chip.time).toEqual({ lead: "", value: "17:31", tail: " 到期" });
  expect(chip.ariaLabel).toBe("操作模式：全自主，剩 4 小時");
});

test("urgency starts in the last two minutes and expiry is its own phase", () => {
  expect(grantPhase(null)).toBe("steady");
  expect(grantPhase(120_001)).toBe("steady");
  expect(grantPhase(120_000)).toBe("soon");
  expect(grantPhase(1)).toBe("soon");
  expect(grantPhase(0)).toBe("expired");
});

test("expired grants never count as autonomy", () => {
  const live = grant();
  const persistent = grant({ id: "p", expires_at: null });
  expect(activeGrants([live, persistent, grant({ id: "old", expires_at: now })], now)).toEqual([
    live,
    persistent,
  ]);
  expect(activeGrants(undefined, now)).toEqual([]);
});

test("the chip shows the browsed project's mode with its own countdown", () => {
  const chip = accessChip({
    grants: [grant(), grant({ id: "two", workspace_id: "two", level: "files", expires_at: null })],
    workspaceId: "one",
    available: true,
    unknown: false,
    now,
  });
  expect(chip).toMatchObject({
    mode: "auto",
    icon: "Lightning",
    fill: true,
    label: "全自主",
    time: { lead: "剩 ", value: "12:05", tail: "" },
    urgent: false,
    ariaLabel: "操作模式：全自主，剩 12 分 5 秒",
  });
  const files = accessChip({
    grants: [grant({ level: "files", expires_at: null })],
    workspaceId: "one",
    available: true,
    unknown: false,
    now,
  });
  expect(files).toMatchObject({ mode: "files", label: "檔案自主", fill: false, urgent: false });
  expect(files.time).toBeUndefined();
  expect(files.ariaLabel).toBe("操作模式：檔案自主，直到收回");
});

test("a project without a grant, or an expired grant, reads 逐步確認", () => {
  for (const grants of [[], [grant({ expires_at: now })], [grant({ workspace_id: "other" })]])
    expect(
      accessChip({ grants, workspaceId: "one", available: true, unknown: false, now }),
    ).toMatchObject({ mode: "step", label: "逐步確認", icon: "ShieldCheck" });
});

test("all projects summarise every grant with the earliest countdown", () => {
  const chip = accessChip({
    grants: [
      grant({ level: "files", expires_at: null, workspace_name: "docs-site", id: "a" }),
      grant({ id: "b", workspace_id: "two", expires_at: now + 90_000 }),
    ],
    workspaceId: null,
    available: true,
    unknown: false,
    now,
  });
  expect(chip).toMatchObject({
    mode: "auto",
    label: "2 個專案自主",
    time: { lead: "剩 ", value: "1:30", tail: "" },
    urgent: true,
  });
  expect(chip.ariaLabel).toBe(
    "操作模式：docs-site 檔案自主，直到收回；Kairomes 全自主，剩 1 分 30 秒",
  );
});

test("an offline panel or an unconfirmed change never shows a mode as settled", () => {
  for (const state of [
    { available: false, unknown: false },
    { available: true, unknown: true },
  ]) {
    const chip = accessChip({ grants: [grant()], workspaceId: "one", now, ...state });
    expect(chip).toMatchObject({ mode: "unknown", label: "權限待確認", urgent: false });
    expect(chip.time).toBeUndefined();
  }
});

test("grant heads-ups are announced once per phase change, never every second", () => {
  let phases = new Map();
  const timed = grant({ expires_at: now + 125_000 });
  let result = grantAnnouncements(phases, [timed], now);
  expect(result.messages).toEqual([]);
  phases = result.phases;
  result = grantAnnouncements(phases, [timed], now + 4_000);
  expect(result.messages).toEqual([]);
  phases = result.phases;
  result = grantAnnouncements(phases, [timed], now + 5_000);
  expect(result.messages).toEqual(["Kairomes 全自主剩不到 2 分鐘"]);
  phases = result.phases;
  result = grantAnnouncements(phases, [timed], now + 6_000);
  expect(result.messages).toEqual([]);
  phases = result.phases;
  result = grantAnnouncements(phases, [timed], now + 125_000);
  expect(result.messages).toEqual(["Kairomes 全自主已到期，改回逐步確認"]);
  expect(grantAnnouncements(result.phases, [], now + 126_000).messages).toEqual([]);
});
