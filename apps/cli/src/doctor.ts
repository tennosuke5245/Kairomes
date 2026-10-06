import { fileURLToPath } from "node:url";
import { collectDiagnostics } from "@kairomes/daemon";
import {
  type DiagnosticCheck,
  diagnosticSummary,
  Inputs,
  VERSION,
  WIDGET_URI,
} from "@kairomes/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { probeCompanion } from "./companion.ts";

type Check = { name: string; status: "pass" | "warn" | "fail"; detail: string };

export type DoctorReport = {
  checks: Check[];
  /** Shared fixed-id checks (enums, counts and versions only), as Companion reports them. */
  diagnostics: DiagnosticCheck[];
  /** Copyable plain-text summary of diagnostics; safe to share. */
  summary: string;
  ok: boolean;
};

export async function doctor(dataDirectory: string): Promise<DoctorReport> {
  // Collected first, so the serve handshake below cannot create the data directory beforehand.
  // Only Companion supervises the Tunnel, so this CLI reports its state as unknown.
  const diagnostics = await collectDiagnostics({
    dataDirectory,
    companion: await probeCompanion(dataDirectory),
  });
  const checks: Check[] = [
    { name: "runtime", status: "pass", detail: `Bun ${Bun.version} / ${process.platform}` },
  ];
  try {
    const terminal = new Bun.Terminal({ cols: 80, rows: 24 });
    terminal.close();
    checks.push({
      name: "pty",
      status: "pass",
      detail: "Runtime 支援 PTY；終端機請求須由本機使用者批准。",
    });
  } catch {
    checks.push({
      name: "pty",
      status: "warn",
      detail: "此 runtime／平台不支援 PTY；唯讀功能不受影響。",
    });
  }
  checks.push({
    name: "tunnel-client",
    status: Bun.which("tunnel-client") ? "pass" : "warn",
    detail: Bun.which("tunnel-client")
      ? "PATH 中找到官方 client；未驗證登入或 Tunnel 狀態。"
      : "PATH 中沒有 tunnel-client；請依官方文件安裝。",
  });
  checks.push({
    name: "chatgpt-access",
    status: "warn",
    detail: "需要手動驗證 developer mode、Tunnel Read + Use，以及工作區關聯。",
  });
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value &&
      /^(path|systemroot|windir|temp|tmp|home|userprofile|localappdata|appdata|pathext)$/i.test(
        name,
      )
    )
      env[name] = value;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "serve",
      "--data-dir",
      dataDirectory,
    ],
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "kairomes-doctor", version: VERSION });
  try {
    await client.connect(transport, { timeout: 5000 });
    const tools = await client.listTools({}, { timeout: 5000 });
    const result = await client.callTool({ name: "kairomes_status", arguments: {} }, undefined, {
      timeout: 5000,
    });
    const expected = Object.keys(Inputs);
    if (
      result.isError ||
      tools.tools.length !== expected.length ||
      !expected.every((name) => tools.tools.some((tool) => tool.name === name))
    )
      throw new Error("Protocol check failed");
    checks.push({
      name: "mcp-stdio",
      status: "pass",
      detail: `真實子程序完成 initialize、${expected.length}-tool tools/list 與 tools/call；包含工作區、變更、命令、終端機、圖片預覽及 4 個固定下游 MCP Broker，未執行主機命令或下游工具。`,
    });
    const resources = await client.listResources({}, { timeout: 5000 });
    if (!resources.resources.some((resource) => resource.uri === WIDGET_URI)) {
      checks.push({
        name: "widget",
        status: "fail",
        detail: "找不到 UI resource，請先執行 bun run build。",
      });
    } else {
      const resource = await client.readResource({ uri: WIDGET_URI }, { timeout: 5000 });
      const valid = resource.contents.some(
        (item) => "text" in item && item.text.includes('id="root"'),
      );
      checks.push({
        name: "widget",
        status: valid ? "pass" : "fail",
        detail: valid ? "UI resource 已透過 MCP 讀取。" : "UI resource 內容無效。",
      });
    }
  } catch {
    checks.push({
      name: "mcp-stdio",
      status: "fail",
      detail: "MCP 子程序未完成握手或工具呼叫。請檢查安裝與 data-dir。",
    });
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
  return {
    checks,
    diagnostics,
    summary: diagnosticSummary(diagnostics, VERSION),
    ok:
      !checks.some((check) => check.status === "fail") &&
      !diagnostics.some((check) => check.state === "error"),
  };
}
