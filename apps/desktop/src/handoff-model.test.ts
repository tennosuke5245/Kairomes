import { expect, test } from "bun:test";
import {
  baselineSummary,
  briefReady,
  canCopyHandoff,
  coverageSummary,
  emptySourcesText,
  HANDOFF_COPIED_TEXT,
  handoffCopyBlocker,
  handoffStepHeading,
  handoffSteps,
  handoffTitle,
  relatedPaths,
  relatedPathsError,
  sessionUpdated,
  sourceStatusPill,
} from "./handoff-model.ts";

const NOW = new Date(2026, 9, 6, 15, 12, 0).getTime();

test("the header names the project once and the stepper marks done, current and todo", () => {
  expect(handoffTitle("Kairomes")).toBe("從 Codex 接續 · Kairomes");
  expect(handoffSteps("source", false).map((step) => step.state)).toEqual([
    "current",
    "todo",
    "todo",
  ]);
  expect(handoffSteps("brief", false)).toEqual([
    { label: "選擇來源", state: "done" },
    { label: "整理內容", state: "current" },
    { label: "預覽並複製", state: "todo" },
  ]);
  expect(handoffSteps("preview", false).map((step) => step.state)).toEqual([
    "done",
    "done",
    "current",
  ]);
  // After a copy the last step is done; nothing claims the content was sent.
  expect(handoffSteps("preview", true).every((step) => step.state === "done")).toBe(true);
  expect(handoffStepHeading("brief")).toBe("步驟 2／3：整理內容");
  expect(HANDOFF_COPIED_TEXT).toBe("已複製，可以貼到 ChatGPT。");
  expect(HANDOFF_COPIED_TEXT).not.toMatch(/已發送|已接手|成功/);
});

test("source rows show a relative time and a pill whose tone only flags blockers", () => {
  expect(sessionUpdated((NOW - 5 * 60_000) / 1000, NOW)).toBe("5 分鐘前");
  expect(sessionUpdated(new Date(2026, 9, 3, 9, 0).getTime() / 1000, NOW)).toBe("10月3日");
  expect(sessionUpdated(0, NOW)).toBe("時間不明");
  expect(sessionUpdated(Number.NaN, NOW)).toBe("時間不明");
  expect(sourceStatusPill("idle")).toEqual({ tone: "neutral", icon: "PauseCircle", label: "閒置" });
  expect(sourceStatusPill("notLoaded").tone).toBe("neutral");
  for (const status of ["inProgress", "active", "running"])
    expect(sourceStatusPill(status)).toEqual({
      tone: "running",
      icon: "HourglassMedium",
      label: "進行中",
    });
  expect(sourceStatusPill("systemError").label).toBe("來源異常");
  expect(sourceStatusPill("unavailable").label).toBe("無法核對");
  // Anything unrecognised is a warning, never neutral or a success.
  expect(sourceStatusPill("somethingNew")).toEqual({
    tone: "warning",
    icon: "Question",
    label: "狀態不明",
  });
  expect(emptySourcesText(false)).toBe("沒有這個專案的 Codex 紀錄，可以改用手動建立摘要。");
  expect(emptySourcesText(true)).toContain("下一頁");
});

test("coverage is summarised once, adding only what limits the excerpt", () => {
  const coverage = {
    hasOlderTurns: false,
    textTruncated: false,
    itemsTruncated: false,
    recentTurnsRequested: 3,
  };
  expect(coverageSummary({ coverage, partialTurns: [], pendingTurns: [] })).toBe("最近 3 輪");
  expect(
    coverageSummary({
      coverage: { ...coverage, itemsTruncated: true },
      partialTurns: [{}],
      pendingTurns: [{}],
    }),
  ).toBe("最近 3 輪 · 有中斷 · 有進行中 · 範圍有限");
  expect(
    coverageSummary({
      coverage: { ...coverage, hasOlderTurns: true },
      partialTurns: [],
      pendingTurns: [],
    }),
  ).toBe("最近 3 輪 · 範圍有限");
});

test("the form needs 目標 and 下一步, and at most 20 related paths", () => {
  expect(briefReady({ goal: "  ", next_action: "x" })).toBe(false);
  expect(briefReady({ goal: "改測試", next_action: "  " })).toBe(false);
  expect(briefReady({ goal: "改測試", next_action: "跑 bun test" })).toBe(true);
  expect(relatedPaths(" src/main.ts \r\n\n README.md\n")).toEqual(["src/main.ts", "README.md"]);
  const twenty = Array.from({ length: 20 }, (_, index) => `f${index}.ts`).join("\n");
  expect(relatedPathsError(twenty)).toBeNull();
  expect(relatedPathsError(`${twenty}\nextra.ts`)).toBe("最多 20 個檔案，目前 21 個。");
});

test("the baseline reads as checked or incomplete in one line", () => {
  expect(baselineSummary({ complete: true, files: [{}, {}] as never })).toEqual({
    complete: true,
    text: "相關檔案已核對 · 2 個檔案",
  });
  expect(baselineSummary({ complete: false, files: [] })).toEqual({
    complete: false,
    text: "基準不完整，僅供核對 · 0 個檔案",
  });
});

test("copy stays unavailable until every gate holds, and says why when it cannot be fixed here", () => {
  const preview = { complete: true, blocked_reason: null };
  const ready = {
    busy: false,
    reviewed: true,
    sourceStopped: true,
    permissionsChecked: true,
    preview,
  };
  expect(canCopyHandoff(ready)).toBe(true);
  expect(handoffCopyBlocker(ready)).toBeNull();
  for (const gate of ["reviewed", "sourceStopped", "permissionsChecked"] as const)
    expect(canCopyHandoff({ ...ready, [gate]: false })).toBe(false);
  expect(canCopyHandoff({ ...ready, busy: true })).toBe(false);
  expect(canCopyHandoff({ ...ready, preview: null })).toBe(false);
  // The attestations are made on the form, so the reason points back there.
  expect(handoffCopyBlocker({ ...ready, sourceStopped: false })).toContain("返回修改");
  // An incomplete baseline can be reviewed but never copied, even with every box ticked.
  const incomplete = { ...ready, preview: { complete: false, blocked_reason: null } };
  expect(canCopyHandoff(incomplete)).toBe(false);
  expect(handoffCopyBlocker(incomplete)).toBe("相關檔案基準不完整，只能核對，不能複製。");
  // A source block is shown on its own, so the hint does not repeat it.
  const blocked = {
    ...ready,
    preview: { complete: false, blocked_reason: "來源仍有進行中紀錄，僅供核對。" },
  };
  expect(canCopyHandoff(blocked)).toBe(false);
  expect(handoffCopyBlocker(blocked)).toBeNull();
});
