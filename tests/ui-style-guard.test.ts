import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// Static guards for the shared UI layer (G8). Surface lanes add their own stylesheets to
// GUARDED_STYLESHEETS once they are migrated to tokens.
const root = new URL("../", import.meta.url);
const read = (file: string) => readFile(new URL(file, root), "utf8");
const TOKENS = "packages/ui-tokens/tokens.css";
const COMPONENTS = "packages/ui-tokens/components.css";
const SIDE_PANEL = ["apps/extension/sidepanel.css", "apps/extension/mcp-panel.css"];
const WIDGET = "apps/widget/src/styles.css";
const MCP_RESULT = "apps/widget/src/mcp-result.css";
const GUARDED_STYLESHEETS = [TOKENS, COMPONENTS, ...SIDE_PANEL, WIDGET, MCP_RESULT];
const MIN_FONT_PX = 12;

type Rule = { at: string[]; selector: string; declarations: Map<string, string> };

/** Minimal CSS reader: comments stripped, at-rules nest, plain rules hold declarations. */
function parseCss(source: string): Rule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const at: string[] = [];
  let start = 0;
  for (let index = 0; index < css.length; index++) {
    const character = css[index];
    if (character === "}") {
      at.pop();
      start = index + 1;
    } else if (character === ";" && !at.length) {
      start = index + 1; // top-level statements such as @import
    } else if (character === "{") {
      const prelude = css.slice(start, index).trim().replace(/\s+/g, " ");
      if (prelude.startsWith("@") && !prelude.startsWith("@font-face")) {
        at.push(prelude);
        start = index + 1;
        continue;
      }
      const end = css.indexOf("}", index);
      const declarations = new Map<string, string>();
      for (const declaration of css.slice(index + 1, end).split(";")) {
        const colon = declaration.indexOf(":");
        if (colon < 0) continue;
        declarations.set(
          declaration.slice(0, colon).trim(),
          declaration
            .slice(colon + 1)
            .trim()
            .replace(/\s+/g, " "),
        );
      }
      rules.push({ at: [...at], selector: prelude, declarations });
      index = end;
      start = end + 1;
    }
  }
  return rules;
}

function block(rules: Rule[], selector: string, at: string[] = []) {
  const found = rules.find(
    (rule) => rule.selector === selector && JSON.stringify(rule.at) === JSON.stringify(at),
  );
  if (!found) throw new Error(`tokens.css is missing ${at.join(" ")} ${selector}`);
  return Object.fromEntries(
    [...found.declarations].filter(([name]) => name.startsWith("--k-")),
  ) as Record<string, string>;
}

const tokens = parseCss(await read(TOKENS));
const light = block(tokens, ':root, [data-theme="light"]');
const darkMedia = block(tokens, ':root:not([data-theme="light"])', [
  "@media (prefers-color-scheme: dark)",
]);
const dark = block(tokens, ':root[data-theme="dark"], [data-theme="dark"]');
const scales = block(tokens, ":root");

function luminance(hex: string) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Not a 6-digit hex colour: ${hex}`);
  const value = Number.parseInt(hex.slice(1), 16);
  const [red, green, blue] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(
    (channel) => {
      const srgb = channel / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    },
  );
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}
const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
};
function hue(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  const [red, green, blue] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(
    (channel) => channel / 255,
  ) as [number, number, number];
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
  if (!delta) return 0;
  const raw =
    max === red
      ? ((green - blue) / delta) % 6
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  return (raw * 60 + 360) % 360;
}

// Every declared foreground/background pairing, measured on unrounded values (spec §2.2).
type Pair = [foreground: string, background: string, use: string];
const SURFACES = ["k-bg", "k-surface", "k-surface-2"];
const TONES = ["brand", "running", "success", "warning", "danger", "neutral"];
const TEXT_PAIRS: Pair[] = [
  ...["k-ink-1", "k-ink-2", "k-ink-3"].flatMap((ink) =>
    SURFACES.map((surface): Pair => [ink, surface, "body, secondary and meta text"]),
  ),
  ["k-ink-1", "k-surface-3", "pressed or selected row"],
  ["k-ink-2", "k-surface-3", "secondary text on pressed"],
  ["k-ink-3", "k-surface-3", "disabled button label on pressed"],
  ...TONES.flatMap((tone): Pair[] => [
    ...SURFACES.map((surface): Pair => [`k-${tone}-on`, surface, `${tone} text on a surface`]),
    [`k-${tone}-on`, `k-${tone}-soft`, `${tone} pill or tinted text`],
    ["k-ink-1", `k-${tone}-soft`, `notice body on the ${tone} tint`],
    ["k-ink-2", `k-${tone}-soft`, `secondary text on the ${tone} tint`],
  ]),
  ["k-brand", "k-bg", "brand text"],
  ["k-primary-ink", "k-primary-bg", "primary button"],
  ["k-primary-ink", "k-primary-bg-hover", "primary button hover"],
  ["k-brand-ink", "k-brand", "需確認 count badge"],
  ["k-danger-ink", "k-danger", "danger button in a dialog"],
  ["k-code-ink", "k-code-bg", "code and output"],
  ["k-ink-3", "k-code-bg", "output line numbers"],
  ["k-danger-on", "k-code-bg", "stderr line"],
  ["k-success-on", "k-code-bg", "passing line"],
  ["k-code-ink", "k-diff-add-bg", "added diff line"],
  ["k-code-ink", "k-diff-del-bg", "removed diff line"],
  ["k-ink-3", "k-diff-add-bg", "line number on an added line"],
  ["k-ink-3", "k-diff-del-bg", "line number on a removed line"],
  ["k-diff-add-mark", "k-diff-add-bg", "+ sign"],
  ["k-diff-del-mark", "k-diff-del-bg", "− sign"],
  ["k-danger-on", "k-diff-del-bg", "failing test line in output"],
  ["k-diff-hunk-ink", "k-diff-hunk-bg", "diff hunk label"],
  ["k-mark-ink", "k-mark-bg", "search match"],
  ["k-ink-1", "k-selection", "selected text"],
  ...[1, 2, 3, 4, 5].map((index): Pair => ["k-ws-ink", `k-ws-${index}`, "project avatar letter"]),
];
const NON_TEXT_PAIRS: Pair[] = [
  ...SURFACES.map((surface): Pair => ["k-line-control", surface, "input and switch boundary"]),
  ...[...SURFACES, "k-surface-3"].map((surface): Pair => ["k-focus", surface, "focus ring"]),
  ...TONES.flatMap((tone) =>
    ["k-bg", "k-surface", `k-${tone}-soft`].map(
      (surface): Pair => [`k-${tone}`, surface, `${tone} dot, icon or fill`],
    ),
  ),
  ["k-brand", "k-surface-3", "需確認 badge on a pressed button"],
  ["k-primary-bg", "k-surface", "switch on, pressed chip"],
  ["k-ink-3", "k-surface-2", "switch knob (off)"],
  ["k-brand-mark", "k-bg", "K logo"],
  ["k-brand-mark", "k-surface", "K logo"],
  ...[1, 2, 3, 4, 5].map((index): Pair => [`k-ws-${index}`, "k-surface", "workspace tag square"]),
];

describe("tokens.css", () => {
  test("both dark blocks are identical and every light colour has a dark value", () => {
    expect(darkMedia).toEqual(dark);
    const lightNames = Object.keys(light).sort();
    expect(Object.keys(dark).sort()).toEqual(lightNames);
  });

  test("theme-independent scales stay on :root only", () => {
    for (const name of Object.keys(scales)) expect(name in light || name in dark, name).toBe(false);
    for (const name of [
      "--k-text-meta",
      "--k-space-1",
      "--k-radius-md",
      "--k-dur-1",
      "--k-z-dialog",
    ])
      expect(scales[name], name).toBeDefined();
  });

  for (const [theme, values] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    test(`${theme}: every text pair meets 4.5:1`, () => {
      const failures = TEXT_PAIRS.flatMap(([foreground, background, use]) => {
        const ratio = contrast(values[`--${foreground}`] ?? "", values[`--${background}`] ?? "");
        return ratio >= 4.5 ? [] : [`${foreground} on ${background} (${use}): ${ratio.toFixed(2)}`];
      });
      expect(failures).toEqual([]);
    });

    test(`${theme}: focus ring, control edges, dots and logo meet 3:1`, () => {
      const failures = NON_TEXT_PAIRS.flatMap(([foreground, background, use]) => {
        const ratio = contrast(values[`--${foreground}`] ?? "", values[`--${background}`] ?? "");
        return ratio >= 3 ? [] : [`${foreground} on ${background} (${use}): ${ratio.toFixed(2)}`];
      });
      expect(failures).toEqual([]);
    });

    test(`${theme}: 失敗 never reads as 需確認 (brand and danger hues ≥ 20° apart)`, () => {
      const gap = Math.abs(hue(values["--k-brand"] ?? "") - hue(values["--k-danger"] ?? "")) % 360;
      expect(Math.min(gap, 360 - gap)).toBeGreaterThanOrEqual(20);
    });
  }

  test("the reduced-motion rule also covers pseudo-elements", () => {
    const reduced = tokens.filter((rule) =>
      rule.at.includes("@media (prefers-reduced-motion: reduce)"),
    );
    const universal = reduced.find((rule) => rule.selector.includes("*::before"));
    expect(universal?.selector).toContain("*::after");
    expect(universal?.declarations.get("animation-duration")).toContain("!important");
    expect(universal?.declarations.get("transition-duration")).toContain("!important");
  });
});

/** Resolves a font-size value to px when it can; null for inherit-like values. */
function fontPixels(value: string): number | null {
  const scale = value.match(/var\((--k-text-[\w-]+)\)/);
  if (scale) return fontPixels(scales[scale[1] ?? ""] ?? "");
  const size = value.match(/(?:^|\s)(\d*\.?\d+)(px|rem|em|%)(?=\s|\/|$)/);
  if (!size) return null;
  const amount = Number(size[1]);
  if (size[2] === "px") return amount;
  if (size[2] === "rem") return amount * 16;
  // Relative to the parent: anything that shrinks text is reported as a 0px floor breach.
  return (size[2] === "%" ? amount / 100 : amount) < 1 ? 0 : null;
}

describe("guarded stylesheets", () => {
  test(`no font-size below ${MIN_FONT_PX}px and the meta size stays 13px`, async () => {
    expect(fontPixels("var(--k-text-meta)")).toBe(13);
    const failures: string[] = [];
    for (const file of GUARDED_STYLESHEETS) {
      for (const rule of parseCss(await read(file))) {
        for (const [property, value] of rule.declarations) {
          const pixels =
            property === "font-size" || property === "font"
              ? fontPixels(value)
              : property.startsWith("--k-text-")
                ? fontPixels(value)
                : null;
          if (pixels !== null && pixels < MIN_FONT_PX)
            failures.push(`${file} ${rule.selector} { ${property}: ${value} }`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("no color-mix() (the Desktop WebView targets chrome105)", async () => {
    for (const file of GUARDED_STYLESHEETS) {
      const css = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(/color-mix\(/i.test(css), file).toBe(false);
    }
  });

  test("components.css and the side panel take every colour from tokens", async () => {
    for (const file of [COMPONENTS, ...SIDE_PANEL]) {
      const css = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css.match(/#[0-9a-f]{3,8}\b/gi) ?? [], file).toEqual([]);
      expect(css.match(/\b(?:rgba?|hsla?)\(/gi) ?? [], file).toEqual([]);
    }
  });

  test("the side panel uses no legacy palette names and no theme pin", async () => {
    for (const file of SIDE_PANEL) {
      const css = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, "");
      // Every var() is a --k-* token or the shared [data-tone] plumbing (--tone, --tone-soft,
      // --tone-on, --tone-line): the legacy alias block (--red, --paper, …) is gone.
      expect(css.match(/var\(--(?!k-|tone\)|tone-(?:soft|on|line)\))[\w-]+/g) ?? [], file).toEqual(
        [],
      );
    }
    const html = await read("apps/extension/sidepanel.html");
    expect(html.match(/<html\b[^>]*>/)?.[0]).not.toContain("data-theme");
  });

  test("the workbench, host viewer and MCP result card take every colour from tokens", async () => {
    for (const file of [WIDGET, MCP_RESULT]) {
      const css = await read(file);
      // No light-only or OS-only palettes: no legacy aliases, no own dark-mode branch.
      expect(css, file).not.toMatch(/--signal-(?:bg|paper|ink|muted|faint|line|red|green)\b/);
      expect(css, file).not.toMatch(
        /--(?:bg|panel|raised|paper|ink|muted|faint|accent|error|red|green|line|text)\s*:/,
      );
      expect(css, file).not.toMatch(/prefers-color-scheme/);
      expect(css, file).not.toContain("chatgpt-workbench");
      const literals = parseCss(css).flatMap((rule) =>
        [...rule.declarations]
          .filter(([, value]) => /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i.test(value))
          .map(([property, value]) => `${file} ${rule.selector} { ${property}: ${value} }`),
      );
      expect(literals).toEqual([]);
    }
    expect(parseCss(await read(WIDGET)).length).toBeGreaterThan(200);
  });

  test("the replaced renderers and pickers leave no styles behind", async () => {
    const selectors = (await Promise.all([WIDGET, MCP_RESULT].map(read))).flatMap((css) =>
      parseCss(css).map((rule) => rule.selector),
    );
    const legacy =
      /\.(?:topbar|body-grid|sidebar|main-panel|view-tabs|chat-composer|welcome|workspace-picker|section-label|icon-button|accent-button|error-banner|connection|result-card|result-header|result-status|signal-diff|full-diff|inspector-(?:heading|status|section|callout|primary|technical|command|error)|signal-file|signal-search|editor-code|line-numbers|search-result|file-row|command-(?:toolbar|output|argv)|terminal-(?:toolbar|footer|screen)|output-preview|result-excerpt)(?![\w-])/;
    expect(selectors.filter((selector) => legacy.test(selector))).toEqual([]);
  });
});
