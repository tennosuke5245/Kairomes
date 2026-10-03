import path from "node:path";
import { parseArgs } from "node:util";
import {
  createMcpServer,
  loadMcpResultWidget,
  loadWidget,
  McpHostManager,
  readWorkbenchConnection,
  startCompanion,
  startPreview,
  startWorkbench,
  ToolService,
  verifyWorkbenchConnection,
} from "@kairomes/daemon";
import { KairomesError, publicError, VERSION } from "@kairomes/protocol";
import { defaultDataDirectory, WorkspaceRegistry } from "@kairomes/workspace-core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openExternal } from "./browser.ts";
import { runCompanion } from "./companion.ts";
import { doctor } from "./doctor.ts";
import { validExtensionId } from "./extension-id.ts";
import { handoff } from "./handoff.ts";
import { requestPairingUrl } from "./pairing-client.ts";
import { startAttachedRelay } from "./relay.ts";
import { relayCheck } from "./relay-check.ts";

const packagedExecutable = /^kairomes(?:\.exe)?$/i.test(path.basename(process.execPath));
const commandPrefix = packagedExecutable ? "kairomes" : "bun run kairomes";
const help = `Kairomes ${VERSION} — ChatGPT 本機工作台

  bun run kairomes workspace add <folder> [--name 名稱]
  bun run kairomes workspace list
  bun run kairomes workspace remove <id>
  bun run kairomes mcp list [--refresh]
  bun run kairomes mcp add-stdio <名稱> --command <程式> [--arg <參數>] [--env <環境變數>]
  bun run kairomes mcp add-http <名稱> --url <HTTPS 或 loopback URL> [--header-env <Header=環境變數>]
  bun run kairomes mcp enable-server <server-id>
  bun run kairomes mcp disable-server <server-id>
  bun run kairomes mcp enable-tool <server-id> <tool-name>
  bun run kairomes mcp disable-tool <server-id> <tool-name>
  bun run kairomes mcp refresh [server-id]
  bun run kairomes mcp remove <server-id>
  bun run kairomes serve --attach [--stdio]  # Tunnel 連到同一個 app
  bun run kairomes serve [--stdio]           # 獨立 MCP 服務
  bun run kairomes preview [--port 4318]
  bun run kairomes app [--port 4318] [--extension-id <id>]
  bun run kairomes companion [--no-open] [--no-tunnel]  # 可見的本機控制中心
  bun run kairomes open                      # 顯示執行中工作台網址
  bun run kairomes pair --extension-id <id>   # 產生側欄一次性配對碼
  bun run kairomes doctor [--json]
  bun run kairomes relay-check [--json]       # 驗證 Tunnel attach relay 的公開工具
  bun run kairomes handoff list --workspace <folder>
  bun run kairomes handoff snapshot <id> --workspace <folder>

所有指令支援 --data-dir <folder>。若發生未分類錯誤，可加 --debug 顯示本機診斷訊息。
serve 的 stdout 僅輸出 MCP JSON-RPC。
Tunnel 設定見根目錄 README.md；憑證由官方 tunnel-client 管理。
`.replaceAll("bun run kairomes", commandPrefix);

async function main() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      name: { type: "string" },
      port: { type: "string" },
      "control-port": { type: "string" },
      stdio: { type: "boolean" },
      attach: { type: "boolean" },
      "no-open": { type: "boolean" },
      "no-tunnel": { type: "boolean" },
      "extension-id": { type: "string" },
      json: { type: "boolean" },
      debug: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      workspace: { type: "string" },
      "source-home": { type: "string" },
      command: { type: "string" },
      arg: { type: "string", multiple: true },
      cwd: { type: "string" },
      env: { type: "string", multiple: true },
      url: { type: "string" },
      "header-env": { type: "string", multiple: true },
      refresh: { type: "boolean" },
    },
  });
  const command = positionals[0];
  // The official tunnel-client passes its environment to the stdio MCP child.
  // Only Companion needs the key; clear it before any command starts processes.
  const tunnelApiKey = command === "companion" ? process.env.CONTROL_PLANE_API_KEY : undefined;
  delete process.env.CONTROL_PLANE_API_KEY;
  const directory = path.resolve(values["data-dir"] ?? defaultDataDirectory());
  const extensionId =
    typeof values["extension-id"] === "string" ? values["extension-id"] : undefined;
  if (!command || values.help) {
    console.log(help);
    return;
  }
  if (command === "handoff") {
    await handoff(positionals[1], positionals[2], values.workspace, values["source-home"]);
    return;
  }
  if (command === "mcp") {
    const manager = new McpHostManager(directory);
    try {
      const action = positionals[1];
      if (action === "list" && positionals.length === 2) {
        if (values.refresh) await manager.refresh();
        console.log(JSON.stringify(await manager.localState(), null, 2));
      } else if (action === "add-stdio" && positionals[2] && values.command) {
        const config = await manager.addStdio({
          name: positionals[2],
          command: values.command,
          args: values.arg,
          cwd: values.cwd,
          env: values.env,
        });
        await manager.refresh(config.id);
        console.log(
          JSON.stringify(
            (await manager.localState()).find((item) => item.id === config.id),
            null,
            2,
          ),
        );
      } else if (action === "add-http" && positionals[2] && values.url) {
        const headerEnv = Object.fromEntries(
          (values["header-env"] ?? []).map((entry) => {
            const separator = entry.indexOf("=");
            if (separator < 1 || separator === entry.length - 1)
              throw new KairomesError(
                "USAGE",
                "--header-env 請使用 Header=ENV_NAME，例如 Authorization=MCP_TOKEN。",
              );
            return [entry.slice(0, separator), entry.slice(separator + 1)];
          }),
        );
        const config = await manager.addHttp({
          name: positionals[2],
          url: values.url,
          headerEnv,
        });
        await manager.refresh(config.id);
        console.log(
          JSON.stringify(
            (await manager.localState()).find((item) => item.id === config.id),
            null,
            2,
          ),
        );
      } else if (
        ["enable-tool", "allow-read"].includes(action ?? "") &&
        positionals[2] &&
        positionals[3]
      ) {
        console.log(
          JSON.stringify(
            await manager.setToolEnabled(positionals[2], positionals[3], true),
            null,
            2,
          ),
        );
      } else if (
        ["disable-tool", "deny"].includes(action ?? "") &&
        positionals[2] &&
        positionals[3]
      ) {
        await manager.setToolEnabled(positionals[2], positionals[3], false);
        console.log("已停用此下游工具；設定變更不需要重新連結 ChatGPT Connector。");
      } else if (["enable-server", "disable-server"].includes(action ?? "") && positionals[2]) {
        await manager.setServerEnabled(positionals[2], action === "enable-server");
        console.log(
          action === "enable-server"
            ? "已開啟此 MCP 與未個別停用的工具。"
            : "已關閉此 MCP；ChatGPT 無法再呼叫它的工具。",
        );
      } else if (action === "refresh" && positionals.length <= 3) {
        console.log(JSON.stringify(await manager.refresh(positionals[2]), null, 2));
      } else if (action === "remove" && positionals[2] && positionals.length === 3) {
        await manager.remove(positionals[2]);
        console.log("已解除 MCP 掛載；沒有刪除外部伺服器或其資料。");
      } else {
        throw new KairomesError(
          "USAGE",
          "請指定 mcp list、add-stdio、add-http、enable-server、disable-server、enable-tool、disable-tool、refresh 或 remove。",
        );
      }
    } finally {
      await manager.close();
    }
    return;
  }
  if (values.attach && command !== "serve")
    throw new KairomesError("USAGE", "--attach 僅適用 serve。");
  if (values["extension-id"] && !["app", "pair"].includes(command))
    throw new KairomesError("USAGE", "--extension-id 僅適用 app 或 pair。");
  if (command === "serve" && values.attach) {
    await startAttachedRelay(directory);
    return;
  }
  if (command === "open") {
    const connection = await readWorkbenchConnection(directory);
    await verifyWorkbenchConnection(connection);
    console.log(
      `本機工作台（請勿公開）：\n${connection.origin}/#session=${connection.uiToken}\n本機審批（請勿交給模型）：\n${connection.origin}/approvals#session=${connection.adminToken}`,
    );
    return;
  }
  if (command === "pair") {
    if (!validExtensionId(extensionId))
      throw new KairomesError("USAGE", "請提供瀏覽器顯示的 --extension-id。");
    const connection = await readWorkbenchConnection(directory);
    await verifyWorkbenchConnection(connection);
    const response = await fetch(`${connection.origin}/api/pairing/create`, {
      method: "POST",
      redirect: "error",
      headers: {
        Origin: connection.origin,
        "Content-Type": "application/json",
        Authorization: `Bearer ${connection.adminToken}`,
      },
      body: JSON.stringify({ extensionId }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404)
      throw new KairomesError(
        "APP_UPDATE_REQUIRED",
        "目前 app 仍是舊版，請重新啟動 app 與 Tunnel 後再配對。",
      );
    const result = await response.json();
    if (!response.ok)
      throw new KairomesError("PAIRING_FAILED", result.message ?? "無法產生配對碼。");
    console.log(
      `側欄配對碼（兩分鐘內有效，只能使用一次；請貼入 Extension，不要交給模型）：\n${result.pairingUrl}`,
    );
    return;
  }
  if (command === "doctor") {
    const report = await doctor(directory);
    console.log(
      values.json
        ? JSON.stringify(report, null, 2)
        : report.checks
            .map((check) => `[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`)
            .join("\n"),
    );
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  if (command === "relay-check") {
    const report = await relayCheck(directory);
    console.log(
      values.json
        ? JSON.stringify(report, null, 2)
        : [
            `[${report.ok ? "PASS" : "FAIL"}] attach relay: ${report.tools.length}/${report.expected.length} 個預期工具`,
            `本機工作台：${report.origin}`,
            `工具：${report.tools.join(", ")}`,
            ...(report.missing.length ? [`缺少：${report.missing.join(", ")}`] : []),
            ...(report.unexpected.length ? [`額外：${report.unexpected.join(", ")}`] : []),
            ...(report.ok
              ? [
                  "若 ChatGPT 仍顯示舊工具，先到 Kairomes Connector 按「重新整理」，讓它重新抓取 tools/list。",
                ]
              : []),
            "此檢查只呼叫 MCP initialize 與 tools/list；不會執行任何 Kairomes 工具或命令。",
          ].join("\n"),
    );
    process.exitCode = report.ok ? 0 : 1;
    return;
  }
  if (command === "companion") {
    const controlPort = Number(values["control-port"] ?? 0);
    if (!Number.isInteger(controlPort) || controlPort < 0 || controlPort > 65535)
      throw new KairomesError("USAGE", "Companion 控制連接埠須為 0～65535 的整數。");
    await runCompanion({
      dataDirectory: directory,
      port: controlPort,
      openBrowser: !values["no-open"],
      autoStartTunnel: !values["no-tunnel"],
      tunnelApiKey,
    });
    return;
  }
  if (!["workspace", "serve", "preview", "app"].includes(command))
    throw new KairomesError("USAGE", "未知指令，請使用 --help 查看說明。");
  const registry = await WorkspaceRegistry.open(directory);
  let persistent = false;
  try {
    if (command === "workspace") {
      const action = positionals[1];
      if (action === "list" && positionals.length === 2)
        console.log(JSON.stringify(registry.list(), null, 2));
      else if (action === "add" && positionals.length === 3 && positionals[2]) {
        console.log(JSON.stringify(await registry.add(positionals[2], values.name), null, 2));
      } else if (action === "remove" && positionals.length === 3 && positionals[2]) {
        registry.remove(positionals[2]);
        console.log("已解除掛載；原始資料夾與檔案保持完整。");
      } else
        throw new KairomesError(
          "USAGE",
          "請指定 workspace add、list 或 remove，以及需要的路徑或 ID。",
        );
    } else if (command === "serve") {
      const [html, mcpResultHtml] = await Promise.all([loadWidget(), loadMcpResultWidget()]);
      const service = new ToolService(registry, Boolean(html));
      const server = createMcpServer(registry, html, service, true, mcpResultHtml);
      const companion = startCompanion(service);
      console.error(
        `Kairomes 本機審批（僅給本機使用者，請勿交給模型）：\n${companion.approvalsUrl}`,
      );
      const transport = new StdioServerTransport();
      let closed = false;
      const shutdown = async () => {
        if (closed) return;
        closed = true;
        await companion.close();
        await server.close();
        registry.close();
      };
      process.once("SIGINT", () => {
        void shutdown();
      });
      process.once("SIGTERM", () => {
        void shutdown();
      });
      process.stdin.once("end", () => {
        void shutdown();
      });
      try {
        await server.connect(transport);
      } catch (error) {
        await companion.close();
        await server.close();
        throw error;
      }
      persistent = true;
    } else {
      const [html, mcpResultHtml] = await Promise.all([loadWidget(), loadMcpResultWidget()]);
      if (!html)
        throw new KairomesError("WIDGET_MISSING", "缺少工作台資源，請先執行 bun run build。");
      const port = Number(values.port ?? 4318);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new KairomesError("USAGE", "連接埠須為 0～65535 的整數。");
      const preview =
        command === "app"
          ? await startWorkbench(registry, html, port, extensionId, {
              mcpResultHtml,
              openBrowser: openExternal,
            })
          : startPreview(registry, html, port);
      let autoPairingUrl: string | undefined;
      if (command === "app" && extensionId) {
        try {
          const origin = new URL(preview.url).origin;
          const adminToken = new URLSearchParams(new URL(preview.approvalsUrl).hash.slice(1)).get(
            "session",
          );
          if (!adminToken)
            throw new KairomesError("PAIRING_FAILED", "工作台沒有提供本機配對憑證。");
          autoPairingUrl = await requestPairingUrl(origin, adminToken, extensionId);
        } catch (error) {
          await preview.close();
          throw error;
        }
      }
      console.error(
        `Kairomes ${command === "app" ? "ChatGPT 網頁工具工作台（聊天請用 chatgpt.com）" : "本機預覽"}（此 URL 含本次存取權杖，僅在本機開啟）：\n${preview.url}\n本機審批（請勿交給模型）：\n${preview.approvalsUrl}`,
      );
      if (command === "app")
        console.error(
          `Tunnel relay descriptor 已發布：${path.join(registry.dataDirectory, "workbench-connection.json")} → ${new URL(preview.url).origin}`,
        );
      if (autoPairingUrl)
        console.error(
          `\n貼到 Kairomes Extension 的一次性配對連結（兩分鐘有效）：\n${autoPairingUrl}`,
        );
      let closed = false;
      const shutdown = async () => {
        if (closed) return;
        closed = true;
        await preview.close();
        registry.close();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      persistent = true;
    }
  } finally {
    if (!persistent) registry.close();
  }
}

main().catch((error: unknown) => {
  const safe = publicError(error);
  console.error(
    `${safe.code}: ${safe.message}\n使用 --help 查看指令；請確認 bun install 與 bun run build 已完成。`,
  );
  if (process.argv.includes("--debug") && !(error instanceof KairomesError)) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`本機診斷（請勿公開包含私人路徑或憑證的內容）：${detail}`);
  }
  process.exitCode = 1;
});
