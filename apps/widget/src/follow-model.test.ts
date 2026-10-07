import { expect, test } from "bun:test";
import {
  isEditableTarget,
  liveStatus,
  readingKey,
  TIMELINE_SCROLL_PAUSE,
  timelineScrollPauses,
  workbenchShortcut,
} from "./follow-model.ts";

const key = (value: string, extra: Partial<Parameters<typeof readingKey>[0]> = {}) => ({
  key: value,
  editable: false,
  ...extra,
});

test("the live chip is a status: 即時 while following, 已暫停跟隨 after reading starts", () => {
  expect(liveStatus(true)).toEqual({ state: "live", label: "即時" });
  expect(liveStatus(false)).toEqual({ state: "paused", label: "已暫停跟隨" });
});

test("scrolling the timeline away from the top pauses; resting at the top does not", () => {
  expect(timelineScrollPauses(0)).toBe(false);
  expect(timelineScrollPauses(TIMELINE_SCROLL_PAUSE)).toBe(false);
  expect(timelineScrollPauses(TIMELINE_SCROLL_PAUSE + 1)).toBe(true);
});

test("keyboard scrolling is reading; typing and shortcuts with modifiers are not", () => {
  for (const value of ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "])
    expect(readingKey(key(value))).toBe(true);
  expect(readingKey(key("ArrowDown", { editable: true }))).toBe(false);
  expect(readingKey(key("End", { ctrlKey: true }))).toBe(false);
  expect(readingKey(key("Tab"))).toBe(false);
  expect(readingKey(key("a"))).toBe(false);
});

test("f toggles following and Esc closes a detail, never while typing or in xterm", () => {
  expect(workbenchShortcut(key("f"), { detailOpen: false })).toBe("toggle-follow");
  expect(workbenchShortcut(key("F"), { detailOpen: true })).toBe("toggle-follow");
  expect(workbenchShortcut(key("Escape"), { detailOpen: true })).toBe("back");
  expect(workbenchShortcut(key("Escape"), { detailOpen: false })).toBeUndefined();
  expect(workbenchShortcut(key("f", { editable: true }), { detailOpen: false })).toBeUndefined();
  expect(
    workbenchShortcut(key("Escape", { editable: true }), { detailOpen: true }),
  ).toBeUndefined();
  for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const)
    expect(
      workbenchShortcut(key("f", { [modifier]: true }), { detailOpen: false }),
    ).toBeUndefined();
});

test("/ focuses search from anywhere except a typing surface or the terminal", () => {
  expect(workbenchShortcut(key("/"), { detailOpen: false })).toBe("search");
  expect(workbenchShortcut(key("/"), { detailOpen: true })).toBe("search");
  expect(workbenchShortcut(key("/", { editable: true }), { detailOpen: false })).toBeUndefined();
  expect(workbenchShortcut(key("/", { ctrlKey: true }), { detailOpen: false })).toBeUndefined();
});

test("typing surfaces are recognised structurally, including the terminal screen", () => {
  const target = (matches: string | null, editable = false) => ({
    isContentEditable: editable,
    closest: (selector: string) => (matches && selector.includes(matches) ? {} : null),
  });
  expect(isEditableTarget(target("input"))).toBe(true);
  expect(isEditableTarget(target("textarea"))).toBe(true);
  expect(isEditableTarget(target(".xterm"))).toBe(true);
  expect(isEditableTarget(target(null, true))).toBe(true);
  expect(isEditableTarget(target(null))).toBe(false);
  expect(isEditableTarget(null)).toBe(false);
  expect(isEditableTarget({})).toBe(false);
});
