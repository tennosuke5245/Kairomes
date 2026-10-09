import { expect, test } from "bun:test";
import { focusControl, focusHeading, focusLost, focusScope, pickFocusTarget } from "./focus.ts";

test("focus counts as lost only when its element left and nothing else holds focus", () => {
  const body = {};
  const removed = { isConnected: false };
  const present = { isConnected: true };
  expect(focusLost(removed, body, body)).toBe(true);
  expect(focusLost(removed, null, body)).toBe(true);
  // Another element already has focus (a dialog, the handoff step heading): leave it there.
  expect(focusLost(removed, {}, body)).toBe(false);
  // Still in the page (focus was put down on purpose, or the button only changed label).
  expect(focusLost(present, body, body)).toBe(false);
  // A press on empty space forgot the element first.
  expect(focusLost(null, body, body)).toBe(false);
});

test("a replaced control hands focus to the region's control first, then its heading", () => {
  const start = { name: "啟動安全通道", priority: 1, usable: true };
  const heading = { name: "安全通道", priority: 2, usable: true };
  const hidden = { name: "停止", priority: 1, usable: false };
  expect(pickFocusTarget([heading, hidden, start])).toBe(start);
  // A Tunnel that is starting has no control: the row heading takes focus.
  expect(pickFocusTarget([heading, hidden])).toBe(heading);
  // The first usable control in document order wins among equals.
  const copy = { name: "複製連結", priority: 1, usable: true };
  expect(pickFocusTarget([copy, start])).toBe(copy);
  expect(pickFocusTarget([hidden])).toBeNull();
  expect(pickFocusTarget([])).toBeNull();
});

test("the markup helpers mark regions, controls and focusable headings", () => {
  expect(focusScope).toEqual({ "data-focus-scope": "" });
  expect(focusControl).toEqual({ "data-focus-target": "1" });
  expect(focusHeading).toEqual({ "data-focus-target": "2", tabIndex: -1 });
});
