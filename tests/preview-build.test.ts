import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  applyPreviewTheme,
  buildPreviewBundles,
  PREVIEW_PATHS,
  type PreviewBundles,
  type PreviewServer,
  startPreviewServer,
} from "../scripts/preview-sidebar.ts";

// Neither `bun run check` gate used to build the synthetic preview, which let X1 (fixture
// imports resolved from the wrong directory) regress unnoticed. This builds every bundle.
let bundles: PreviewBundles;
let preview: PreviewServer;
beforeAll(async () => {
  bundles = await buildPreviewBundles();
  preview = await startPreviewServer({ bundles });
}, 60_000);
afterAll(async () => {
  await preview?.stop();
});

const page = async (path: string) => {
  const response = await fetch(`${preview.origin}${path}`);
  expect(response.status, path).toBe(200);
  return { response, html: await response.text() };
};
const withQuery = (path: string, query: string) =>
  `${path}${path.includes("?") ? "&" : "?"}${query}`;
const htmlTag = (html: string) => html.match(/<html\b[^>]*>/i)?.[0] ?? "";

test("every preview bundle builds with its synthetic boundary swapped in", () => {
  for (const [name, script] of Object.entries(bundles)) {
    expect(script.length, name).toBeGreaterThan(500);
    expect(/<\/script/i.test(script), name).toBe(false);
  }
  // Fixture bridges load from tests/, so their own relative imports resolve (X1).
  const has = (name: keyof PreviewBundles, marker: string) => bundles[name].includes(marker);
  expect(has("widget", "合成命令輸出")).toBe(true);
  expect(has("widget", "宿主順序合成專案")).toBe(false);
  expect(has("hostViewer", "宿主順序合成專案")).toBe(true);
  expect(has("hostViewer", "合成命令輸出")).toBe(false);
  expect(has("panelFlow", "kairomes-synthetic-panel-session")).toBe(true);
  expect(has("panelHttp", "kairomes-synthetic-panel-session")).toBe(true);
});

test("every page is served and honours ?theme=light|dark", async () => {
  for (const path of PREVIEW_PATHS) {
    await page(path);
    for (const theme of ["light", "dark"] as const) {
      const { html } = await page(withQuery(path, `theme=${theme}`));
      expect(htmlTag(html), `${path} ${theme}`).toContain(`data-theme="${theme}"`);
      expect(htmlTag(html).match(/data-theme=/g), path).toHaveLength(1);
      expect(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark/i.test(html), path).toBe(false);
    }
  }
});

test("surfaces load the shared tokens and components before their own stylesheet", async () => {
  for (const [path, own] of [
    ["/setup", ".sp-toolbar"],
    ["/settings", ".mcp-filters"],
    ["/widget", ".signal-workbench {"],
    ["/host-viewer", ".hv {"],
    ["/mcp-result", ".mr-card {"],
    ["/desktop-handoff", ".desk-side {"],
  ] as const) {
    const { html } = await page(path);
    const tokens = html.indexOf("--k-bg:");
    const components = html.indexOf(".k-btn {");
    expect(tokens, path).toBeGreaterThan(-1);
    expect(components, path).toBeGreaterThan(tokens);
    expect(html.indexOf(own), path).toBeGreaterThan(components);
  }
  // Both migrated surfaces follow the OS theme: no light pin on either.
  expect(htmlTag((await page("/setup")).html)).not.toContain("data-theme");
  expect(htmlTag((await page("/desktop-handoff")).html)).not.toContain("data-theme");
});

test("theme and motion flags reach iframes and keep hashed styles valid", async () => {
  const embedded = (await page("/embedded?theme=dark&motion=reduce")).html;
  expect(embedded.includes('src="/embedded-widget?theme=dark&motion=reduce"')).toBe(true);
  const zoom = (await page("/zoom?view=settings&width=360&theme=light")).html;
  expect(zoom.includes('src="/settings?theme=light"')).toBe(true);
  const reduced = (await page("/widget?motion=reduce")).html;
  expect(/@media\s*\(\s*prefers-reduced-motion/i.test(reduced)).toBe(false);

  const { response, html } = await page("/oauth-result?outcome=failed&theme=dark");
  const csp = response.headers.get("content-security-policy") ?? "";
  for (const [, style] of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    const hash = createHash("sha256")
      .update(style ?? "")
      .digest("base64");
    expect(csp).toContain(`'sha256-${hash}'`);
  }
});

test("applyPreviewTheme replaces an existing theme pin", () => {
  expect(
    applyPreviewTheme(
      '<html lang="zh-Hant" data-theme="light"><style>@media (prefers-color-scheme: dark){a{b:c}}</style>',
      "dark",
    ),
  ).toBe('<html lang="zh-Hant" data-theme="dark"><style>@media all{a{b:c}}</style>');
  expect(
    applyPreviewTheme("<html><style>@media(prefers-color-scheme:dark){}</style>", "light"),
  ).toBe('<html data-theme="light"><style>@media not all{}</style>');
});
