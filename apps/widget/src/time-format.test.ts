import { expect, test } from "bun:test";
import {
  clockDuration,
  clockTime,
  countdown,
  formatDuration,
  groupByTime,
  openedTime,
  relativeTime,
  timeGroup,
} from "./time-format.ts";

// Local wall-clock fixtures, so the assertions hold in any time zone.
const at = (hour: number, minute: number, second = 0, day = 6) =>
  new Date(2026, 9, day, hour, minute, second).getTime();
const now = at(15, 30);

test("relative time reads 剛剛, then seconds and minutes, then a clock time, 昨天 or a date", () => {
  expect(relativeTime(now, now)).toBe("剛剛");
  expect(relativeTime(now + 60_000, now)).toBe("剛剛"); // clock skew is never "in the future"
  expect(relativeTime(now - 9_999, now)).toBe("剛剛");
  expect(relativeTime(now - 10_000, now)).toBe("10 秒前");
  expect(relativeTime(now - 39_000, now)).toBe("30 秒前");
  expect(relativeTime(now - 60_000, now)).toBe("1 分鐘前");
  expect(relativeTime(now - 59 * 60_000, now)).toBe("59 分鐘前");
  expect(relativeTime(at(15, 12), at(16, 20))).toBe("下午 3:12");
  expect(relativeTime(at(9, 5), now)).toBe("上午 9:05");
  expect(relativeTime(at(15, 12, 0, 5), now)).toBe("昨天 下午 3:12");
  expect(relativeTime(at(15, 12, 0, 3), now)).toBe("10月3日");
  expect(relativeTime(new Date(2025, 11, 31, 8, 0).getTime(), now)).toBe("2025年12月31日");
});

test("clock time keeps noon and midnight on a 12-hour dial", () => {
  expect(clockTime(at(0, 5))).toBe("上午 12:05");
  expect(clockTime(at(12, 0))).toBe("下午 12:00");
  expect(clockTime(at(23, 59))).toBe("下午 11:59");
});

test("groups are 剛剛 within ten minutes, 今天 for the rest of the day, 更早 before", () => {
  expect(timeGroup(now - 9 * 60_000, now)).toBe("recent");
  expect(timeGroup(now - 10 * 60_000, now)).toBe("today");
  expect(timeGroup(at(0, 1), now)).toBe("today");
  expect(timeGroup(at(23, 59, 0, 5), now)).toBe("earlier");
  // Right after midnight, a few minutes ago is still 剛剛 even though it was yesterday.
  expect(timeGroup(at(23, 58, 0, 5), at(0, 2))).toBe("recent");
  const items = [
    { id: "a", time: now - 1000 },
    { id: "b", time: at(9, 0) },
    { id: "c", time: now - 5000 },
    { id: "d", time: at(9, 0, 0, 1) },
  ];
  expect(
    groupByTime(items, (item) => item.time, now).map((group) => [
      group.label,
      group.items.map((item) => item.id),
    ]),
  ).toEqual([
    ["剛剛", ["a", "c"]],
    ["今天", ["b"]],
    ["更早", ["d"]],
  ]);
  expect(groupByTime([], () => 0, now)).toEqual([]);
});

test("durations: running timers tick as m:ss, finished runs read seconds or minutes", () => {
  expect(clockDuration(14_900)).toBe("0:14");
  expect(clockDuration(-5)).toBe("0:00");
  expect(clockDuration(12 * 60_000 + 5_000)).toBe("12:05");
  expect(clockDuration(3_723_000)).toBe("1:02:03");
  expect(formatDuration(23)).toBe("不到 0.1 秒");
  expect(formatDuration(100)).toBe("0.1 秒");
  expect(formatDuration(420)).toBe("0.4 秒");
  expect(formatDuration(4_260)).toBe("4.2 秒");
  expect(formatDuration(42_000)).toBe("42 秒");
  expect(formatDuration(6 * 60_000 + 59_000)).toBe("6 分鐘");
  expect(formatDuration(65 * 60_000)).toBe("1 小時 5 分鐘");
  expect(formatDuration(2 * 3_600_000)).toBe("2 小時");
});

test("countdowns round up, turn urgent under a minute and read 已到期 at zero", () => {
  expect(countdown(now + 252_000, now)).toEqual({ text: "剩 4:12", urgency: undefined });
  expect(countdown(now + 251_200, now)).toEqual({ text: "剩 4:12", urgency: undefined });
  expect(countdown(now + 59_000, now)).toEqual({ text: "剩 0:59", urgency: "soon" });
  expect(countdown(now, now)).toEqual({ text: "已到期", urgency: "expired" });
  expect(countdown(now - 1, now)).toEqual({ text: "已到期", urgency: "expired" });
});

test("a terminal's opened time says so, so it is not read as the row's activity time", () => {
  expect(openedTime(now, now)).toBe("剛剛開啟");
  expect(openedTime(now - 3 * 60_000, now)).toBe("3 分鐘前開啟");
  expect(openedTime(at(12, 59), now)).toBe("下午 12:59 開啟");
  expect(openedTime(at(9, 5, 0, 5), now)).toBe("昨天 上午 9:05 開啟");
});
