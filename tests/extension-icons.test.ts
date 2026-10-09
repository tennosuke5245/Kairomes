import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PANEL_FILL_ICONS, PANEL_ICONS, spriteId } from "../apps/extension/src/icons.ts";
import {
  ICON_SPRITE_PLACEHOLDER,
  inlineIconSprite,
  missingSpriteIcons,
  renderIconSprite,
} from "../scripts/extension-icons.ts";

const html = await readFile(new URL("../apps/extension/sidepanel.html", import.meta.url), "utf8");

test("the build-time sprite defines every panel icon from the installed Phosphor set", async () => {
  const sprite = await renderIconSprite();
  for (const name of PANEL_ICONS)
    expect(sprite).toContain(`<symbol id="${spriteId(name)}" viewBox="0 0 256 256">`);
  for (const name of PANEL_FILL_ICONS) expect(sprite).toContain(`id="${spriteId(name, true)}"`);
  // Static markup only: no inline style, script or event handler can reach the CSP page.
  expect(/style=|<script|\son[a-z]+=/i.test(sprite)).toBe(false);
});

test("sidepanel.html references only icons the sprite defines", async () => {
  expect(html).toContain(ICON_SPRITE_PLACEHOLDER);
  const page = inlineIconSprite(html, await renderIconSprite());
  expect(page).not.toContain(ICON_SPRITE_PLACEHOLDER);
  expect(missingSpriteIcons(page)).toEqual([]);
  expect(missingSpriteIcons('<use href="#ph-nope"/>')).toEqual(["ph-nope"]);
  expect(() => inlineIconSprite("<body></body>", "")).toThrow();
});

test("the panel page keeps CSP-safe markup and no text glyph icons", () => {
  expect(/\sstyle=|\son[a-z]+=/i.test(html)).toBe(false);
  // Text glyphs are replaced by sprite icons (spec §6).
  expect(/[←×↗＋]/.test(html)).toBe(false);
  expect(html).toContain('allow="fullscreen; clipboard-write"');
});
