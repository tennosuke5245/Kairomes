import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin, Server } from "bun";
import { mcpOAuthCallbackResponse } from "../apps/daemon/src/mcp-oauth-page.ts";
import { commandTokens, setupCommands } from "../apps/extension/src/setup-commands.ts";
import { componentsCss, tokensCss, uiCss } from "../packages/ui-tokens/index.ts";
import { renderStudyMaterial } from "../tests/handoff-study-materials.ts";
import { createPanelHttpFixture } from "../tests/panel-http-fixture.ts";
import { createStudyHttpFixture } from "../tests/study-http-fixture.ts";
import { inlineIconSprite, renderIconSprite } from "./extension-icons.ts";

// Synthetic UI preview with bounded memory-only HTTP controls. No host, shell or reader.
// `bun run scripts/preview-sidebar.ts` serves it; tests/preview-build.test.ts imports it.
const root = new URL("../", import.meta.url);
const read = (file: string) => readFile(new URL(file, root), "utf8");
const fromRoot = (file: string) => fileURLToPath(new URL(file, root));

type BundleOptions = {
  /** Replaces apps/widget/src/bridge.ts with a synthetic bridge from tests/. */
  bridge?: "sidebar" | "host-viewer";
  /** Replaces apps/extension/src/browser.ts with the synthetic browser boundary. */
  panelFlow?: boolean;
  /** Replaces the MCP Apps host SDK with an in-page fixture. */
  mcpResult?: boolean;
};

/**
 * Redirects `./<name>.ts` imports made from files in `directory` to a fixture on disk.
 * The fixture is then loaded like any other module, so its own relative imports resolve
 * from tests/ rather than from the directory of the module it stands in for (X1).
 */
function swapModule(name: string, directory: string, fixture: string): BunPlugin {
  // Compare real paths, case-insensitively on Windows, so symlinked temp roots (macOS
  // /var → /private/var) or drive-letter casing cannot silently skip the swap.
  const canonical = (target: string) => {
    let real = path.resolve(target);
    try {
      real = realpathSync.native(real);
    } catch {
      // A virtual or missing importer cannot be the widget source directory.
    }
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  const importerDirectory = canonical(fromRoot(directory));
  const replacement = fromRoot(fixture);
  const specifier = new RegExp(`^\\./${name}(\\.ts)?$`);
  return {
    name: `synthetic-${name}`,
    setup(build) {
      build.onResolve({ filter: specifier }, (args) =>
        canonical(path.dirname(args.importer)) === importerDirectory
          ? { path: replacement }
          : undefined,
      );
    },
  };
}

const reactFromDesktop: BunPlugin = {
  name: "fixture-react",
  setup(build) {
    build.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (args) => ({
      path: Bun.resolveSync(args.path, fromRoot("apps/desktop/")),
    }));
  },
};

const mcpResultHost: BunPlugin = {
  name: "synthetic-mcp-result-host",
  setup(build) {
    build.onResolve({ filter: /^@modelcontextprotocol\/ext-apps$/ }, () => ({
      path: fromRoot("tests/mcp-result-preview-app.ts"),
    }));
  },
};

async function bundle(entry: string, options: BundleOptions = {}) {
  const plugins = [reactFromDesktop];
  if (options.bridge)
    plugins.push(
      swapModule(
        "bridge",
        "apps/widget/src/",
        options.bridge === "host-viewer"
          ? "tests/host-viewer-fixture-bridge.ts"
          : "tests/sidebar-fixture-bridge.ts",
      ),
    );
  if (options.panelFlow)
    plugins.push(swapModule("browser", "apps/extension/src/", "tests/panel-flow-browser.ts"));
  if (options.mcpResult) plugins.push(mcpResultHost);
  const result = await Bun.build({
    entrypoints: [fromRoot(entry)],
    target: "browser",
    format: "esm",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins,
  });
  if (!result.success) throw new AggregateError(result.logs, `Preview build failed: ${entry}`);
  const output = result.outputs.find((item) => item.kind === "entry-point") ?? result.outputs[0];
  if (!output) throw new Error(`Missing preview build output: ${entry}`);
  return (await output.text()).replace(/<\/script/gi, "<\\/script");
}

const bundleSpecs = {
  approval: ["tests/approval-preview.ts"],
  settings: ["tests/settings-preview.ts"],
  handoff: ["tests/handoff-preview.tsx"],
  desktopHandoff: ["tests/desktop-handoff-preview.tsx"],
  panelFlow: ["tests/panel-flow-preview.ts", { panelFlow: true }],
  panelHttp: ["tests/panel-http-preview.ts", { panelFlow: true }],
  studyControl: ["tests/study-control-preview.ts"],
  widget: ["apps/widget/src/main.tsx", { bridge: "sidebar" }],
  hostViewer: ["apps/widget/src/main.tsx", { bridge: "host-viewer" }],
  mcpResult: ["apps/widget/src/mcp-result.ts", { mcpResult: true }],
  resultIdentity: ["tests/result-identity-preview.tsx"],
} satisfies Record<string, [string, BundleOptions?]>;
export type PreviewBundleName = keyof typeof bundleSpecs;
export type PreviewBundles = Record<PreviewBundleName, string>;

/** Builds every synthetic preview script in parallel. Throws on the first failed build. */
export async function buildPreviewBundles(): Promise<PreviewBundles> {
  const built = await Promise.all(
    Object.entries(bundleSpecs).map(
      async ([name, [entry, options]]) => [name, await bundle(entry, options)] as const,
    ),
  );
  return Object.fromEntries(built) as PreviewBundles;
}

export type PreviewTheme = "light" | "dark";
const darkSchemeMedia = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi;
const reducedMotionMedia = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/gi;

/**
 * Selects a theme on a synthetic page: `data-theme` on <html> drives the token blocks, and
 * the `prefers-color-scheme: dark` branches that legacy stylesheets still key on are forced
 * on or off. Same-origin iframes inherit the choice. This is not OS or host integration.
 */
export function applyPreviewTheme(html: string, theme: PreviewTheme) {
  return withIframeParam(
    html
      .replace(darkSchemeMedia, theme === "dark" ? "@media all" : "@media not all")
      .replace(
        /<html\b[^>]*>/i,
        (tag) => `${tag.replace(/\sdata-theme="[^"]*"/i, "").slice(0, -1)} data-theme="${theme}">`,
      ),
    "theme",
    theme,
  );
}

function applyReducedMotion(html: string) {
  return withIframeParam(html.replace(reducedMotionMedia, "@media all"), "motion", "reduce");
}

function withIframeParam(html: string, name: string, value: string) {
  return html.replace(
    /(<iframe\b[^>]*\ssrc=")(\/[^"]*)"/gi,
    (_match, start: string, src: string) => {
      const url = new URL(src, "http://preview.invalid");
      url.searchParams.set(name, value);
      return `${start}${url.pathname}${url.search}"`;
    },
  );
}

/** Recomputes CSP style hashes after a synthetic page's inline styles were rewritten. */
function rehashStyles(html: string, csp: string) {
  const hashes = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(
    ([, style]) =>
      `'sha256-${createHash("sha256")
        .update(style ?? "")
        .digest("base64")}'`,
  );
  return csp.replace(/style-src [^;]*/, `style-src ${hashes.join(" ")}`);
}

const htmlHeaders = {
  "content-type": "text/html;charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

/** Page paths served by the preview. Query flags (`?theme`, `?motion`, …) apply to each. */
export const PREVIEW_PATHS = [
  "/",
  "/setup",
  "/approvals",
  "/settings",
  "/widget",
  "/widget?timeline=1",
  "/reading",
  "/terminal",
  "/host-viewer",
  "/handoff",
  "/desktop-handoff",
  "/embedded",
  "/embedded-widget",
  "/panel-flow",
  "/panel-http",
  "/results-identity",
  "/mcp-result",
  "/study-control",
  "/study-material?material=alpha",
  "/oauth-result?outcome=connected",
  "/zoom?view=widget&width=360",
] as const;

/** Builds the page map from prebuilt bundles. Stylesheets are read from the working tree. */
export async function createPreviewPages(bundles: PreviewBundles) {
  const logo = (await readFile(new URL("apps/extension/assets/kairomes-k-128.png", root))).toString(
    "base64",
  );
  // The side panel links each stylesheet; the preview inlines the same files in order.
  const extensionStyles: Record<string, string> = {
    "tokens.css": tokensCss,
    "components.css": componentsCss,
    "sidepanel.css": await read("apps/extension/sidepanel.css"),
    "mcp-panel.css": await read("apps/extension/mcp-panel.css"),
  };
  // Each substitution must still match the side panel markup, so drift fails the build.
  const swap = (html: string, from: string, to: string) => {
    if (!html.includes(from)) throw new Error(`Preview cannot find ${from} in sidepanel.html`);
    return html.replace(from, () => to);
  };
  // sidepanel.ts fills these at runtime; the static preview shows synthetic values.
  const syntheticId = "abcdefghijklmnopabcdefghijklmnop";
  const commands = setupCommands(syntheticId);
  // The same argument spans sidepanel.ts builds (the synthetic values need no escaping).
  const tokens = (command: string) =>
    commandTokens(command)
      .map((token) => `<span class="sp-copy__token">${token}</span>`)
      .join(" ");
  const runtimeText: Record<string, string> = {
    "extension-id": syntheticId,
    "start-command": tokens(commands.start),
    "tunnel-command": tokens(commands.tunnel),
    "pair-command": tokens(commands.pair),
    "tunnel-command-settings": tokens(commands.tunnel),
  };
  let sidepanelHtml = swap(
    inlineIconSprite(await read("apps/extension/sidepanel.html"), await renderIconSprite()),
    '<script type="module" src="sidepanel.js"></script>',
    "",
  );
  for (const [id, text] of Object.entries(runtimeText))
    sidepanelHtml = swap(
      sidepanelHtml,
      `<code id="${id}" class="k-codebox sp-copy__value"></code>`,
      `<code id="${id}" class="k-codebox sp-copy__value">${text}</code>`,
    );
  sidepanelHtml = swap(
    sidepanelHtml,
    '<span id="extension-version"></span>',
    '<span id="extension-version">0.3.0</span>',
  );
  const base = sidepanelHtml.replace(
    /<link rel="stylesheet" href="([^"]+)">/g,
    (_match, href: string) => {
      const style = extensionStyles[href];
      if (style === undefined)
        throw new Error(`Preview does not inline the side panel stylesheet ${href}`);
      return `<style>${style}</style>`;
    },
  );
  const panelHttpFixture = createPanelHttpFixture();
  const studyHttpFixture = createStudyHttpFixture();
  // Desktop pages mirror index.html's <html> attributes (including any theme pin) and
  // main.tsx's stylesheet order.
  const desktopHtml =
    (await read("apps/desktop/index.html")).match(/<html\b[^>]*>/i)?.[0] ?? '<html lang="zh-Hant">';
  const desktopCss = `${uiCss}\n${await read("apps/desktop/src/styles.css")}`;
  const handoff = `<!doctype html>${desktopHtml}<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kairomes 合成交接測試</title><style>${desktopCss}</style></head><body><div id="root"></div><script type="module">${bundles.handoff}</script></body></html>`;
  const desktopHandoff = `<!doctype html>${desktopHtml}<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kairomes Desktop 合成生命週期</title><style>${desktopCss}</style></head><body><div id="root"></div><script type="module">${bundles.desktopHandoff}</script></body></html>`;
  // Same order as scripts/build-widget.ts: tokens, components, xterm, widget styles.
  const widgetCss = `${uiCss}\n${await read("apps/widget/node_modules/@xterm/xterm/css/xterm.css")}\n${await read("apps/widget/src/styles.css")}`;
  const mcpResultCss = `${uiCss}\n${await read("apps/widget/src/mcp-result.css")}`;
  const mcpResultPage = `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kairomes 合成 MCP 成果</title><style>${mcpResultCss}</style></head><body><div id="root"></div><script type="module">${bundles.mcpResult}</script></body></html>`;
  const resultIdentityPage = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kairomes 合成成果身份</title><style>${widgetCss}</style></head><body><div id="root"></div><script type="module">${bundles.resultIdentity}</script></body></html>`;
  const terminalControls =
    '<aside style="position:fixed;bottom:0;right:0;z-index:500;background:white;color:#000;color-scheme:light;border:1px solid #ccc;padding:4px" aria-label="合成終端測試"><details><summary>終端測試</summary><button id="fixture-terminal-stop">終端結束</button><button id="fixture-terminal-remove">移除選擇</button><output id="terminal-fixture-probe"></output></details></aside>';
  const widget = (controls: boolean, embedded = false, terminal = false) =>
    `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="kairomes-mode" content="workbench">${embedded ? '<meta name="kairomes-parent-origin" content="chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">' : ""}<title>Kairomes 合成側欄測試</title><style>${widgetCss}</style></head><body>${controls ? '<aside style="position:fixed;bottom:4px;right:4px;z-index:200;background:white;color:#000;color-scheme:light;border:1px solid #ccc;padding:4px" aria-label="合成閱讀測試"><details><summary>閱讀測試</summary><button id="fixture-new-event">新增活動</button><button id="fixture-fail-read">下一次讀取失敗</button><button id="fixture-unmount">解除掛載</button></details></aside>' : ""}${terminal ? terminalControls : ""}<div id="root"></div><script type="module">${bundles.widget}</script></body></html>`;
  // Synthetic MessageEvents exercise the actual receiver's source/origin gates.
  // This is deliberately not a real Extension-origin end-to-end test.
  const embedded = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>合成導覽來源驗證</title><body style="margin:0"><div id="fixture-navigation"><button data-case="origin">錯誤來源</button><button data-case="window">錯誤視窗</button><button data-case="version">錯誤版本</button><button data-case="valid">有效來源</button></div><iframe id="fixture-frame" src="/embedded-widget" title="合成嵌入工作台" style="width:100%;height:calc(100vh - 40px);border:0"></iframe><script>for (const button of document.querySelectorAll('[data-case]')) button.onclick=()=>{const target=document.querySelector('iframe').contentWindow;const kind=button.dataset.case;target.dispatchEvent(new target.MessageEvent('message',{source:kind==='window'?target:window,origin:kind==='origin'?'https://invalid.example':'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',data:{type:'kairomes:workspace-filter',version:kind==='version'?2:1,workspaceId:'00000000-0000-4000-8000-000000000020'}}));};</script></body></html>`;
  // Toolbar state (connection dot, switcher, access chip) is set by the fixture scripts.
  const paired = () =>
    swap(base, '<main id="setup" class="sp-page', '<main hidden id="setup" class="sp-page');
  const approvalPage = `${paired()}<script type="module">${bundles.approval}</script>`;
  const settingsShell = swap(
    swap(paired(), 'aria-label="Kairomes 設定" hidden', 'aria-label="Kairomes 設定"'),
    'aria-label="MCP 工具整合" hidden',
    'aria-label="MCP 工具整合"',
  );
  const settingsPage = `${settingsShell}<script type="module">${bundles.settings}</script>`;
  const panelFlowPage = `${base}<aside id="synthetic-panel-controls" style="position:fixed;bottom:0;right:0;z-index:500;background:white;border:1px solid #ccc;padding:4px" aria-label="合成測試控制"><details><summary>測試控制</summary><button data-fixture-action="pending">新增核准</button><button data-fixture-action="offline">離線</button><button data-fixture-action="online">恢復連線</button><button data-fixture-action="invalid">配對失效</button><button data-fixture-action="lost">下一次回應遺失</button><button data-fixture-action="finish">完成延遲變更</button><button data-fixture-action="import">新增圖片匯入</button><button data-fixture-action="lose-upload">下一次上傳回應遺失</button><output id="fixture-probe"></output></details></aside><script type="module">${bundles.panelFlow}</script>`;
  const panelHttpPage = panelFlowPage
    .replace(
      '<button data-fixture-action="finish">完成延遲變更</button>',
      '<button data-fixture-action="uncertain">下一次核准未決</button><button data-fixture-action="settle">完成未決核准</button><button data-fixture-action="hold-list">延遲下次查詢</button><button data-fixture-action="release-list">送回延遲查詢</button><button data-fixture-action="uncertain-access">下一次授權未決</button><button data-fixture-action="settle-access">完成未決授權</button>',
    )
    .replace(
      `<script type="module">${bundles.panelFlow}</script>`,
      () => `<script type="module">${bundles.panelHttp}</script>`,
    );
  const controlButtons = (material: string, actions: [string, string][]) =>
    actions
      .map(
        ([action, label]) =>
          `<button type="button" data-material="${material}" data-study-action="${action}">${label}</button>`,
      )
      .join(" ");
  const escapeHtml = (text: string) =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const manualStudyPage = (material: "alpha" | "beta") =>
    `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>人工接續 ${material}</title><style>body{font:14px system-ui;margin:24px;max-width:900px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}textarea{box-sizing:border-box;width:100%;min-height:260px;font:inherit}label{display:block;margin:16px 0 6px}</style></head><body><details><summary>來源材料</summary><pre>${escapeHtml(renderStudyMaterial(material))}</pre></details><label for="manual-summary">接續摘要</label><textarea id="manual-summary" spellcheck="false"></textarea></body></html>`;
  const studyControlPage =
    `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>合成試用主持控制</title><style>body{font:16px system-ui;margin:24px;max-width:800px}button,a{font:inherit;display:inline-block;padding:8px;margin:2px}section{margin:20px 0}output{display:block;font-size:14px}</style></head><body><h1>主持控制</h1><p>重設後重新載入參與者分頁。</p><nav><a href="/setup" target="_blank">T01</a><a href="/approvals?study=1&count=10" target="_blank">T02／03</a><a href="/widget?study=1" target="_blank">T04</a><a href="/panel-http?study=1" target="_blank">T05／06</a><a href="/handoff?study=alpha" target="_blank">H1 α</a><a href="/handoff?study=beta" target="_blank">H1 β</a></nav><section><h2>HTTP</h2>${controlButtons(
      "panel",
      [
        ["reset", "重設"],
        ["uncertain", "下次未決"],
        ["pending", "新增請求"],
        ["settle", "確認未決"],
        ["hold-catalog", "延遲 catalog"],
        ["offline", "中斷串流"],
        ["release-catalog-failure", "送回失敗"],
        ["online", "恢復"],
      ],
    )}</section><section><h2>成果</h2>${controlButtons("widget", [
      ["reset", "重設"],
      ["edit-file", "更新文字檔"],
      ["edit-image", "更新圖片"],
      ["new-event", "新增活動"],
      ["fail-read", "下次讀取失敗"],
      ["unmount", "解除掛載"],
    ])}</section>${["alpha", "beta"]
      .map(
        (material) =>
          `<section><h2>H1 ${material}</h2>${controlButtons(material, [
            ["reset", "重設"],
            ["edit-file", "審閱後改檔"],
            ["source-pending", "來源未完成"],
            ["missing-file", "缺少檔案"],
          ])}</section>`,
      )
      .join(
        "",
      )}<output id="study-state" aria-live="polite"></output><script type="module">${bundles.studyControl}</script></body></html>`.replace(
      "</nav>",
      '<a href="/study-material?material=alpha" target="_blank">人工 α</a><a href="/study-material?material=beta" target="_blank">人工 β</a></nav>',
    );
  const hostViewerPage = `<!doctype html><html lang="zh-Hant-TW"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kairomes 宿主順序合成檢查</title><style>${widgetCss}</style><body><aside style="position:fixed;top:50%;right:4px;z-index:200;background:white;color:#000;color-scheme:light;border:1px solid #ccc;padding:4px" aria-label="內部合成控制"><details><summary>宿主順序測試</summary><button id="host-viewer-file">送入宿主檔案 B</button><button id="host-viewer-catalog">更新工具清單</button><button id="host-viewer-release">完成舊讀取</button><output id="host-viewer-probe"></output></details></aside><div id="root"></div><script type="module">${bundles.hostViewer}</script></body></html>`;
  const pages: Record<string, string> = {
    "/host-viewer": hostViewerPage,
    // Stand-in workbench for the coordinator fixtures; it follows the parent's preview theme.
    "/": `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>合成工作台</title><style>${tokensCss} body{margin:0;padding:12px;background:var(--k-bg);color:var(--k-ink-2);font:14px/1.5 var(--k-font-sans)}</style><script>try{const theme=parent.document.documentElement.dataset.theme;if(theme)document.documentElement.dataset.theme=theme}catch{}</script><body><p>合成工作台</p></body></html>`,
    "/setup": base,
    "/approvals": approvalPage,
    "/settings": settingsPage,
    "/widget": widget(false),
    "/reading": widget(true),
    "/terminal": widget(false, false, true),
    "/handoff": handoff,
    "/desktop-handoff": desktopHandoff,
    "/embedded": embedded,
    "/embedded-widget": widget(false, true),
    "/panel-flow": panelFlowPage,
    "/panel-http": panelHttpPage,
    "/results-identity": resultIdentityPage,
    "/mcp-result": mcpResultPage,
    "/study-control": studyControlPage,
  };
  return { logo, pages, panelHttpPage, manualStudyPage, panelHttpFixture, studyHttpFixture };
}

export type PreviewServer = { server: Server<undefined>; origin: string; stop(): Promise<void> };

/** Starts the loopback-only preview on a random port (or `port`). */
export async function startPreviewServer(
  options: { port?: number; bundles?: PreviewBundles } = {},
): Promise<PreviewServer> {
  const site = await createPreviewPages(options.bundles ?? (await buildPreviewBundles()));
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    // Synthetic image uploads reach the HTTP fixture; JSON routes keep their own 4 KiB cap.
    maxRequestBodySize: 26 * 1024 * 1024,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("host") !== `127.0.0.1:${server.port}`)
        return new Response("Not found", { status: 404 });
      const synthetic = await site.panelHttpFixture.handle(request);
      if (synthetic) return synthetic;
      const study = await site.studyHttpFixture.handle(request);
      if (study) return study;
      if (request.method !== "GET") return new Response("Not found", { status: 404 });
      // These query flags select the product's CSS branches for cascade checks.
      // They do not change browser/OS preferences or prove native media integration.
      const themeParam = url.searchParams.get("theme");
      const theme: PreviewTheme | undefined =
        themeParam === "light" || themeParam === "dark" ? themeParam : undefined;
      const reduceMotion = url.searchParams.get("motion") === "reduce";
      const render = (html: string) => {
        const themed = theme ? applyPreviewTheme(html, theme) : html;
        return reduceMotion ? applyReducedMotion(themed) : themed;
      };
      if (url.pathname === "/oauth-result") {
        const result = url.searchParams.get("outcome");
        const response = mcpOAuthCallbackResponse(
          result === "connected" || result === "failed" ? result : "authorized",
        );
        const html = render(await response.text());
        const headers = new Headers(response.headers);
        const csp = headers.get("content-security-policy");
        if (csp) headers.set("content-security-policy", rehashStyles(html, csp));
        return new Response(html, { status: response.status, headers });
      }
      if (url.pathname === "/kairomes-k-128.png")
        return new Response(Buffer.from(site.logo, "base64"), {
          headers: { "content-type": "image/png" },
        });
      if (url.pathname === "/study-material") {
        const material = url.searchParams.get("material");
        if (material !== "alpha" && material !== "beta")
          return new Response("Not found", { status: 404 });
        return new Response(render(site.manualStudyPage(material)), { headers: htmlHeaders });
      }
      if (url.pathname === "/zoom") {
        const view = ["approvals", "settings", "widget"].includes(
          url.searchParams.get("view") ?? "",
        )
          ? url.searchParams.get("view")
          : "approvals";
        const width = Number(url.searchParams.get("width") ?? 400);
        const screen = [360, 400, 480].includes(width) ? width : 400;
        // The approval fixture can open a queue tab or a detail (navigation only).
        const opened = url.searchParams.get("open") ?? "";
        const query =
          view === "approvals" &&
          ([
            "queue",
            "running",
            "recent",
            "command",
            "terminal",
            "files",
            "reason",
            "truncated",
          ].includes(opened) ||
            /^import-[a-z-]{1,24}$/.test(opened))
            ? `?open=${opened}`
            : "";
        // Effective CSS viewport and physical scaling, not real browser zoom.
        const zoomPage = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>200% 等效縮放 fixture</title><body style="margin:0;overflow:hidden"><iframe id="fixture-zoom" title="200% 等效閱讀區" src="/${view}${query}" style="width:${screen / 2}px;height:450px;border:0;transform:scale(2);transform-origin:top left"></iframe></body></html>`;
        return new Response(render(zoomPage), {
          headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
        });
      }
      const page =
        url.pathname === "/panel-http" && url.searchParams.get("study") === "1"
          ? site.panelHttpPage.replace(/<aside id="synthetic-panel-controls"[\s\S]*?<\/aside>/, "")
          : site.pages[url.pathname];
      return page
        ? new Response(render(page), { headers: htmlHeaders })
        : new Response("Not found", { status: 404 });
    },
  });
  return {
    server,
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const preview = await startPreviewServer();
  console.log(
    `Synthetic sidebar fixture: port ${preview.server.port}; /study-control /setup /approvals /settings /widget(?timeline=1|connect=hold|connect=fail) /reading /host-viewer /terminal?terminal=1 /handoff /desktop-handoff /embedded /panel-flow /panel-http /results-identity /mcp-result. Every page accepts ?theme=light|dark and ?motion=reduce. No host or credentials.`,
  );
}
