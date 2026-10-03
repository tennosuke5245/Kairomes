import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { PluginBuilder } from "bun";
import { mcpOAuthCallbackResponse } from "../apps/daemon/src/mcp-oauth-page.ts";
import { renderStudyMaterial } from "../tests/handoff-study-materials.ts";
import { createPanelHttpFixture } from "../tests/panel-http-fixture.ts";
import { createStudyHttpFixture } from "../tests/study-http-fixture.ts";

// Synthetic UI preview with bounded memory-only HTTP controls. No host, shell or reader.
const root = new URL("../", import.meta.url);
const read = (file: string) => readFile(new URL(file, root), "utf8");
const css = await read("apps/extension/sidepanel.css");
const mcpCss = await read("apps/extension/mcp-panel.css");
const logo = (await readFile(new URL("apps/extension/assets/kairomes-k-128.png", root))).toString(
  "base64",
);
const base = (await read("apps/extension/sidepanel.html"))
  .replace('<link rel="stylesheet" href="sidepanel.css">', `<style>${css}</style>`)
  .replace('<link rel="stylesheet" href="mcp-panel.css">', `<style>${mcpCss}</style>`)
  .replaceAll("assets/kairomes-k-128.png", `data:image/png;base64,${logo}`)
  .replace('<script type="module" src="sidepanel.js"></script>', "")
  .replace(
    '<code id="extension-id" class="extension-id"></code>',
    '<code id="extension-id" class="extension-id">abcdefghijklmnopabcdefghijklmnop</code>',
  );
async function bundle(
  entry: string,
  fixture = false,
  panelFlow = false,
  mcpResult = false,
  hostViewer = false,
) {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL(entry, root))],
    target: "browser",
    format: "esm",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "fixture-react",
        setup(build) {
          build.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (args) => ({
            path: Bun.resolveSync(args.path, fileURLToPath(new URL("apps/desktop/", root))),
          }));
        },
      },
      ...(fixture
        ? [
            {
              name: "pure-sidebar-fixture",
              setup(build: PluginBuilder) {
                build.onLoad(
                  { filter: /[\\/]apps[\\/]widget[\\/]src[\\/]bridge\.ts$/ },
                  async () => ({
                    contents: (
                      await read(
                        hostViewer
                          ? "tests/host-viewer-fixture-bridge.ts"
                          : "tests/sidebar-fixture-bridge.ts",
                      )
                    )
                      .replaceAll(
                        "../apps/widget/src/tool-result.ts",
                        fileURLToPath(new URL("apps/widget/src/tool-result.ts", root)).replaceAll(
                          "\\",
                          "/",
                        ),
                      )
                      .replaceAll(
                        "./study-fixture-data.ts",
                        fileURLToPath(new URL("tests/study-fixture-data.ts", root)).replaceAll(
                          "\\",
                          "/",
                        ),
                      )
                      .replaceAll(
                        "./study-widget-state.ts",
                        fileURLToPath(new URL("tests/study-widget-state.ts", root)).replaceAll(
                          "\\",
                          "/",
                        ),
                      ),
                    loader: "ts",
                    resolveDir: fileURLToPath(new URL("tests/", root)),
                  }),
                );
              },
            },
          ]
        : []),
      ...(panelFlow
        ? [
            {
              name: "synthetic-browser-boundary",
              setup(build: PluginBuilder) {
                build.onLoad(
                  { filter: /[\\/]apps[\\/]extension[\\/]src[\\/]browser\.ts$/ },
                  async () => ({
                    contents: await read("tests/panel-flow-browser.ts"),
                    loader: "ts",
                  }),
                );
              },
            },
          ]
        : []),
      ...(mcpResult
        ? [
            {
              name: "synthetic-mcp-result-host",
              setup(build: PluginBuilder) {
                build.onResolve({ filter: /^@modelcontextprotocol\/ext-apps$/ }, () => ({
                  path: fileURLToPath(new URL("tests/mcp-result-preview-app.ts", root)),
                }));
              },
            },
          ]
        : []),
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "Sidebar fixture build failed");
  const output = result.outputs[0];
  if (!output) throw new Error("Missing fixture build output");
  return (await output.text()).replace(/<\/script/gi, "<\\/script");
}
const approval = await bundle("tests/approval-preview.ts");
const settings = await bundle("tests/settings-preview.ts");
const handoffScript = await bundle("tests/handoff-preview.tsx");
const desktopHandoffScript = await bundle("tests/desktop-handoff-preview.tsx");
const panelFlowScript = await bundle("tests/panel-flow-preview.ts", false, true);
const panelHttpScript = await bundle("tests/panel-http-preview.ts", false, true);
const panelHttpFixture = createPanelHttpFixture();
const studyHttpFixture = createStudyHttpFixture();
const studyControlScript = await bundle("tests/study-control-preview.ts");
const desktopCss = await read("apps/desktop/src/styles.css");
const handoff = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kairomes 合成交接測試</title><style>${desktopCss}</style></head><body><div id="root"></div><script type="module">${handoffScript}</script></body></html>`;
const desktopHandoff = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kairomes Desktop 合成生命週期</title><style>${desktopCss}</style></head><body><div id="root"></div><script type="module">${desktopHandoffScript}</script></body></html>`;
const widgetScript = await bundle("apps/widget/src/main.tsx", true);
const hostViewerScript = await bundle("apps/widget/src/main.tsx", true, false, false, true);
const widgetCss = `${await read("apps/widget/node_modules/@xterm/xterm/css/xterm.css")}\n${await read("apps/widget/src/styles.css")}`;
const mcpResultScript = await bundle("apps/widget/src/mcp-result.ts", false, false, true);
const mcpResultCss = await read("apps/widget/src/mcp-result.css");
const mcpResultPage = (theme: "host" | "light" | "dark" = "host") =>
  `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kairomes 合成 MCP 成果</title><style>:root{--kairomes-logo:url("data:image/png;base64,${logo}")} ${theme === "host" ? mcpResultCss : mcpResultCss.replace("@media (prefers-color-scheme: dark)", theme === "dark" ? "@media all" : "@media not all")}</style></head><body><div id="root"></div><script type="module">${mcpResultScript}</script></body></html>`;
const resultIdentityScript = await bundle("tests/result-identity-preview.tsx");
const resultIdentityPage = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kairomes 合成成果身份</title><style>${widgetCss}</style></head><body><div id="root"></div><script type="module">${resultIdentityScript}</script></body></html>`;
const terminalControls =
  '<aside style="position:fixed;bottom:0;right:0;z-index:500;background:white;border:1px solid #ccc;padding:4px" aria-label="合成終端測試"><details><summary>終端測試</summary><button id="fixture-terminal-stop">終端結束</button><button id="fixture-terminal-remove">移除選擇</button><output id="terminal-fixture-probe"></output></details></aside>';
const widget = (controls: boolean, embedded = false, terminal = false) =>
  `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="kairomes-mode" content="workbench">${embedded ? '<meta name="kairomes-parent-origin" content="chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">' : ""}<title>Kairomes 合成側欄測試</title><style>:root{--kairomes-logo:url("data:image/png;base64,${logo}")} ${widgetCss}</style></head><body>${controls ? '<aside style="position:fixed;bottom:4px;right:4px;z-index:200;background:white;border:1px solid #ccc;padding:4px" aria-label="合成閱讀測試"><details><summary>閱讀測試</summary><button id="fixture-new-event">新增活動</button><button id="fixture-fail-read">下一次讀取失敗</button><button id="fixture-unmount">解除掛載</button></details></aside>' : ""}${terminal ? terminalControls : ""}<div id="root"></div><script type="module">${widgetScript}</script></body></html>`;
// Synthetic MessageEvents exercise the actual receiver's source/origin gates.
// This is deliberately not a real Extension-origin end-to-end test.
const embedded = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>合成導覽來源驗證</title><body style="margin:0"><div id="fixture-navigation"><button data-case="origin">錯誤來源</button><button data-case="window">錯誤視窗</button><button data-case="version">錯誤版本</button><button data-case="valid">有效來源</button></div><iframe id="fixture-frame" src="/embedded-widget" title="合成嵌入工作台" style="width:100%;height:calc(100vh - 40px);border:0"></iframe><script>for (const button of document.querySelectorAll('[data-case]')) button.onclick=()=>{const target=document.querySelector('iframe').contentWindow;const kind=button.dataset.case;target.dispatchEvent(new target.MessageEvent('message',{source:kind==='window'?target:window,origin:kind==='origin'?'https://invalid.example':'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',data:{type:'kairomes:workspace-filter',version:kind==='version'?2:1,workspaceId:'00000000-0000-4000-8000-000000000020'}}));};</script></body></html>`;
function paired() {
  return base
    .replace('<main id="setup">', '<main id="setup" hidden>')
    .replace(
      '<span id="connection-status" role="img" aria-label="未配對" title="未配對"><i></i></span>',
      '<span id="connection-status" role="img" aria-label="合成測試" title="合成測試" class="connected"><i></i></span>',
    );
}
const approvalPage = `${paired().replace(
  '<section id="access" aria-label="操作權限設定" hidden>',
  '<section id="access" aria-label="操作權限設定">',
)}<script type="module">${approval}</script>`;
const settingsPage =
  paired()
    .replace('aria-label="Kairomes 設定" hidden', 'aria-label="Kairomes 設定"')
    .replace('aria-label="MCP 工具整合" hidden', 'aria-label="MCP 工具整合"') +
  `<script type="module">${settings}</script>`;
const panelFlowPage = `${base}<aside id="synthetic-panel-controls" style="position:fixed;bottom:0;right:0;z-index:500;background:white;border:1px solid #ccc;padding:4px" aria-label="合成測試控制"><details><summary>測試控制</summary><button data-fixture-action="pending">新增核准</button><button data-fixture-action="offline">離線</button><button data-fixture-action="online">恢復連線</button><button data-fixture-action="invalid">配對失效</button><button data-fixture-action="lost">下一次回應遺失</button><button data-fixture-action="finish">完成延遲變更</button><output id="fixture-probe"></output></details></aside><script type="module">${panelFlowScript}</script>`;
const panelHttpPage = panelFlowPage
  .replace(
    '<button data-fixture-action="finish">完成延遲變更</button>',
    '<button data-fixture-action="uncertain">下一次核准未決</button><button data-fixture-action="settle">完成未決核准</button><button data-fixture-action="hold-list">延遲下次查詢</button><button data-fixture-action="release-list">送回延遲查詢</button><button data-fixture-action="uncertain-access">下一次授權未決</button><button data-fixture-action="settle-access">完成未決授權</button>',
  )
  .replace(
    `<script type="module">${panelFlowScript}</script>`,
    () => `<script type="module">${panelHttpScript}</script>`,
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
    )}<output id="study-state" aria-live="polite"></output><script type="module">${studyControlScript}</script></body></html>`.replace(
    "</nav>",
    '<a href="/study-material?material=alpha" target="_blank">人工 α</a><a href="/study-material?material=beta" target="_blank">人工 β</a></nav>',
  );
const pages: Record<string, string> = {
  "/host-viewer": `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kairomes 宿主順序合成檢查</title><style>${widgetCss}</style><body><aside aria-label="內部合成控制"><button id="host-viewer-file">送入宿主檔案 B</button><button id="host-viewer-catalog">更新工具清單</button><button id="host-viewer-release">完成舊讀取</button><output id="host-viewer-probe"></output></aside><div id="root"></div><script type="module">${hostViewerScript}</script></body></html>`,
  "/": '<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>合成工作台</title><body><p>合成工作台</p></body></html>',
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
  "/mcp-result": mcpResultPage(),
  "/study-control": studyControlPage,
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  maxRequestBodySize: 4096,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("host") !== `127.0.0.1:${server.port}`)
      return new Response("Not found", { status: 404 });
    const synthetic = await panelHttpFixture.handle(request);
    if (synthetic) return synthetic;
    const study = await studyHttpFixture.handle(request);
    if (study) return study;
    if (request.method !== "GET") return new Response("Not found", { status: 404 });
    if (url.pathname === "/oauth-result") {
      const result = url.searchParams.get("outcome");
      return mcpOAuthCallbackResponse(
        result === "connected" || result === "failed" ? result : "authorized",
      );
    }
    if (url.pathname === "/kairomes-k-128.png")
      return new Response(Buffer.from(logo, "base64"), {
        headers: { "content-type": "image/png" },
      });
    if (url.pathname === "/study-material") {
      const material = url.searchParams.get("material");
      if (material !== "alpha" && material !== "beta")
        return new Response("Not found", { status: 404 });
      return new Response(manualStudyPage(material), {
        headers: {
          "content-type": "text/html;charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    }
    if (url.pathname === "/zoom") {
      const view = ["approvals", "settings", "widget"].includes(url.searchParams.get("view") ?? "")
        ? url.searchParams.get("view")
        : "approvals";
      const width = Number(url.searchParams.get("width") ?? 400);
      const screen = [360, 400, 480].includes(width) ? width : 400;
      // Effective CSS viewport and physical scaling, not real browser zoom.
      const zoomPage = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>200% 等效縮放 fixture</title><body style="margin:0;overflow:hidden"><iframe id="fixture-zoom" title="200% 等效閱讀區" src="/${view}" style="width:${screen / 2}px;height:450px;border:0;transform:scale(2);transform-origin:top left"></iframe></body></html>`;
      return new Response(zoomPage, {
        headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
      });
    }
    // These query flags select the product's CSS branches for cascade checks.
    // They do not change browser/OS preferences or prove native media integration.
    const theme = url.searchParams.get("theme");
    const page =
      url.pathname === "/mcp-result" && (theme === "light" || theme === "dark")
        ? mcpResultPage(theme)
        : url.pathname === "/panel-http" && url.searchParams.get("study") === "1"
          ? panelHttpPage.replace(/<aside id="synthetic-panel-controls"[\s\S]*?<\/aside>/, "")
          : pages[url.pathname];
    return page
      ? new Response(
          url.searchParams.get("motion") === "reduce"
            ? page.replaceAll("@media (prefers-reduced-motion: reduce)", "@media all")
            : page,
          {
            headers: {
              "content-type": "text/html;charset=utf-8",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
            },
          },
        )
      : new Response("Not found", { status: 404 });
  },
});
console.log(
  `Synthetic sidebar fixture: port ${server.port}; /study-control /setup /approvals /settings /widget /reading /host-viewer /terminal?terminal=1 /handoff /desktop-handoff /embedded /panel-flow /panel-http /results-identity /mcp-result. No host or credentials.`,
);
