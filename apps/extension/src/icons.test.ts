import { expect, test } from "bun:test";
import { iconSpriteId } from "@kairomes/protocol/ui-state";
import { PANEL_FILL_ICONS, PANEL_ICONS, spriteId } from "./icons.ts";

test("sprite ids follow the protocol rule, with -fill for the filled weight", () => {
  expect(spriteId("GearSix")).toBe("ph-gear-six");
  expect(spriteId("GearSix", true)).toBe("ph-gear-six-fill");
  expect(spriteId("CaretUpDown")).toBe("ph-caret-up-down");
  expect(spriteId("ArrowSquareOut")).toBe("ph-arrow-square-out");
  expect(spriteId("XCircle")).toBe(iconSpriteId("XCircle"));
});

test("the icon lists are unique, sorted and fill icons have a regular weight", () => {
  expect(new Set(PANEL_ICONS).size).toBe(PANEL_ICONS.length);
  expect([...PANEL_ICONS].sort()).toEqual([...PANEL_ICONS]);
  for (const name of PANEL_FILL_ICONS) expect(PANEL_ICONS).toContain(name);
});
