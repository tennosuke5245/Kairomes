import { expect, test } from "bun:test";
import {
  boundedInspectorWidth,
  INSPECTOR_LAYOUT,
  inspectorBounds,
  inspectorKeyWidth,
} from "./inspector-size.ts";

test("saved pane widths and keyboard End share the actual container limit after shrinking", () => {
  const wide = inspectorBounds(1400);
  const embedded = inspectorBounds(820);
  expect(wide.max).toBe(760);
  expect(embedded.max).toBe(492);
  expect(boundedInspectorWidth(760, embedded)).toBe(492);
  // End must reach the same advertised maximum, rather than the former window-500 cap.
  expect(inspectorKeyWidth("End", 410, embedded)).toBe(492);
  expect(inspectorKeyWidth("ArrowLeft", 490, embedded)).toBe(492);
  expect(inspectorKeyWidth("Home", 492, embedded)).toBe(320);
  expect(inspectorKeyWidth("ArrowRight", 320, embedded)).toBe(320);
  expect(inspectorKeyWidth("Tab", 410, embedded)).toBeUndefined();
  expect(boundedInspectorWidth(Number.NaN, wide)).toBe(410);
  expect(boundedInspectorWidth(100, wide)).toBe(320);
  expect(
    embedded.max + INSPECTOR_LAYOUT.canvasMin + INSPECTOR_LAYOUT.handle + INSPECTOR_LAYOUT.gutter,
  ).toBe(820);
  expect(inspectorBounds(1050).max).toBe(722);
  expect(inspectorBounds(1200).max).toBe(760);
});
