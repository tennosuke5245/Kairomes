import { expect, test } from "bun:test";
import { importHydrationText, panelView, settingsBackLabel } from "./panel-view.ts";

const closed = { settingsOpen: false, approvalsOpen: false, hasWorkbench: true, frameLoaded: true };

test("one body view at a time, with settings and approvals replacing the workbench", () => {
  expect(panelView(closed)).toBe("workbench");
  expect(panelView({ ...closed, approvalsOpen: true })).toBe("approvals");
  expect(panelView({ ...closed, settingsOpen: true, approvalsOpen: true })).toBe("settings");
  expect(panelView({ ...closed, hasWorkbench: false, frameLoaded: false })).toBe("setup");
  expect(panelView({ ...closed, hasWorkbench: false, settingsOpen: true })).toBe("settings");
});

test("a known workbench that is not loaded shows the empty state, not a blank body", () => {
  expect(panelView({ ...closed, frameLoaded: false })).toBe("empty");
});

test("settings return to the workbench or to pairing", () => {
  expect(settingsBackLabel(true)).toBe("返回工作台");
  expect(settingsBackLabel(false)).toBe("返回配對");
});

test("image import diagnostics appear only once ChatGPT made a request", () => {
  expect(importHydrationText(undefined)).toBeUndefined();
  expect(importHydrationText({ hydrated: 0, omitted: 0, rejected: 0 })).toBeUndefined();
  expect(importHydrationText({ hydrated: 2, omitted: 1, rejected: 0 })).toBe(
    "圖片匯入請求：附圖 2 · 未附圖 1 · 被拒 0",
  );
});
