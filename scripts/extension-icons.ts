import { fileURLToPath } from "node:url";
import {
  PANEL_FILL_ICONS,
  PANEL_ICONS,
  type PanelIcon,
  spriteId,
} from "../apps/extension/src/icons.ts";

// Renders the side panel's Phosphor sprite at build time from the workspace's installed
// @phosphor-icons/react (Desktop already depends on it), so the extension gains no runtime
// or new dev dependency. The output is static SVG markup inlined into sidepanel.html; SVG
// presentation attributes are not inline styles, so CSP `style-src 'self'` still holds.
export const ICON_SPRITE_PLACEHOLDER = "<!-- kairomes:icon-sprite -->";

const resolveFrom = fileURLToPath(new URL("../apps/desktop/", import.meta.url));

type ReactLike = { createElement(type: unknown, props: Record<string, unknown>): unknown };
type ServerLike = { renderToStaticMarkup(element: unknown): string };

let cached: Promise<string> | undefined;

async function render() {
  const react = (await import(Bun.resolveSync("react", resolveFrom))) as ReactLike;
  const server = (await import(Bun.resolveSync("react-dom/server", resolveFrom))) as ServerLike;
  const symbol = async (name: PanelIcon, fill: boolean) => {
    const module = (await import(
      Bun.resolveSync(`@phosphor-icons/react/dist/csr/${name}`, resolveFrom)
    )) as Record<string, unknown>;
    const component = module[name];
    if (!component) throw new Error(`Phosphor icon ${name} is not installed`);
    const markup = server.renderToStaticMarkup(
      react.createElement(component, { weight: fill ? "fill" : "regular" }),
    );
    const inner = markup.replace(/^<svg\b[^>]*>/, "").replace(/<\/svg>$/, "");
    if (!inner || /<(script|foreignObject|style)\b|\son\w+=/i.test(inner))
      throw new Error(`Unexpected markup for icon ${name}`);
    return `<symbol id="${spriteId(name, fill)}" viewBox="0 0 256 256">${inner}</symbol>`;
  };
  const symbols = await Promise.all([
    ...PANEL_ICONS.map((name) => symbol(name, false)),
    ...PANEL_FILL_ICONS.map((name) => symbol(name, true)),
  ]);
  return `<svg xmlns="http://www.w3.org/2000/svg" class="sp-sprite" width="0" height="0" aria-hidden="true" focusable="false">${symbols.join("")}</svg>`;
}

/** The sprite markup: one `<symbol id="ph-…" viewBox="0 0 256 256">` per panel icon. */
export function renderIconSprite() {
  cached ??= render();
  return cached;
}

/** Replaces the placeholder in sidepanel.html; throws if the page lost it. */
export function inlineIconSprite(html: string, sprite: string) {
  if (!html.includes(ICON_SPRITE_PLACEHOLDER))
    throw new Error("sidepanel.html is missing the icon sprite placeholder");
  return html.replace(ICON_SPRITE_PLACEHOLDER, () => sprite);
}

/** Sprite ids referenced by `href="#ph-…"` that the sprite does not define. */
export function missingSpriteIcons(html: string) {
  const defined = new Set([...html.matchAll(/<symbol id="(ph-[a-z0-9-]+)"/g)].map((m) => m[1]));
  return [
    ...new Set([...html.matchAll(/href="#(ph-[a-z0-9-]+)"/g)].map((match) => match[1] ?? "")),
  ].filter((id) => !defined.has(id));
}
