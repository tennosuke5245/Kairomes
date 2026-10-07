import { expect, test } from "bun:test";
import type { McpAuthSummary, McpCatalogTool, McpPanelState } from "@kairomes/protocol";
import { mcpAuthPresentation } from "./mcp-auth-tracker.ts";
import {
  isSearchShortcut,
  MCP_ADD_CONSEQUENCE,
  MCP_TEMPLATES,
  mcpArgPlaceholder,
  mcpChipCounts,
  mcpFailureReason,
  mcpLoginConsequence,
  mcpPathInput,
  mcpRemoteRunner,
  mcpRiskCounts,
  mcpServerView,
  mcpStdioRiskLine,
  mcpSummary,
  mcpToolRisks,
  parseMcpArgs,
} from "./mcp-view.ts";

type Server = McpPanelState["servers"][number];
const id = "00000000-0000-4000-8000-000000000001";
const tool = (name: string, hints: Partial<McpCatalogTool> = {}): McpCatalogTool => ({
  ref: `ref-${name}`,
  server_id: id,
  server_name: "Chrome DevTools",
  name,
  enabled: true,
  availability: "ready",
  read_only_hint: null,
  destructive_hint: null,
  open_world_hint: null,
  schema_fingerprint: `schema-${name}`,
  ...hints,
});
const server = (fields: Partial<Server> = {}): Server => ({
  id,
  name: "Chrome DevTools",
  transport: "stdio",
  config_fingerprint: "1".repeat(64),
  enabled: true,
  state: "ready",
  tools: [
    tool("list_pages", { read_only_hint: true }),
    tool("fill_form", { destructive_hint: true }),
    tool("evaluate_script"),
    tool("navigate_page", { open_world_hint: true }),
  ],
  ...fields,
});
const summary = (fields: Partial<McpAuthSummary>): McpAuthSummary => ({
  auth_phase: "required",
  tools_status: "unknown",
  phase_version: 1,
  ...fields,
});
const oauth = (auth: McpAuthSummary, fields: Partial<Server> = {}) => {
  const value = server({ transport: "http", auth, state: "unavailable", tools: [], ...fields });
  return mcpServerView(value, { summary: auth, view: mcpAuthPresentation(auth) });
};

test("risk hints: one effect per tool plus 可連外; missing hints never read as 唯讀", () => {
  expect(mcpToolRisks(tool("a", { read_only_hint: true }))).toEqual(["read_only"]);
  expect(mcpToolRisks(tool("b", { read_only_hint: true, destructive_hint: true }))).toEqual([
    "modify",
  ]);
  expect(mcpToolRisks(tool("c"))).toEqual(["action"]);
  expect(mcpToolRisks(tool("d", { read_only_hint: true, open_world_hint: true }))).toEqual([
    "read_only",
    "network",
  ]);
  expect(
    mcpRiskCounts(server().tools).map(({ kind, count, label, tone }) => [kind, count, label, tone]),
  ).toEqual([
    ["read_only", 1, "唯讀", "neutral"],
    ["modify", 1, "可能修改資料", "warning"],
    ["action", 2, "可執行動作", "warning"],
    ["network", 1, "可連外", "warning"],
  ]);
  expect(mcpRiskCounts([])).toEqual([]);
});

test("a connected server shows one switch, its transport and tool count", () => {
  const view = mcpServerView(server());
  expect(view).toMatchObject({
    mode: "ready",
    switchVisible: true,
    on: true,
    attention: false,
    refreshVisible: true,
    forgetVisible: false,
    toolsCurrent: true,
  });
  expect(view.status).toEqual({ tone: "success", icon: "Dot", label: "已連線", spin: false });
  expect(view.meta).toEqual(["stdio", "4 個工具"]);
  expect(view.notice).toBeUndefined();
  const partial = server();
  if (partial.tools[0]) partial.tools[0].enabled = false;
  expect(mcpServerView(partial).meta).toEqual(["stdio", "3／4 個工具已開啟"]);
  expect(mcpServerView(server({ state: "connecting" })).status.label).toBe("連線中");
  expect(mcpServerView(server({ tools: [] })).meta).toEqual(["stdio", "沒有公開工具"]);
  expect(mcpServerView(server({ tools: [], state: "connecting" })).meta).toEqual(["stdio"]);
});

test("an off server keeps its switch and is neither 已開啟 nor 需處理", () => {
  const view = mcpServerView(server({ enabled: false, state: "unavailable" }));
  expect(view).toMatchObject({ mode: "off", switchVisible: true, on: false, attention: false });
  expect(view.status.label).toBe("已關閉");
  expect(view.notice).toBeUndefined();
});

test("a start failure shows the Host's reason and 重試, not the refresh icon", () => {
  const view = mcpServerView(server({ state: "unavailable", message: "找不到啟動程式。" }));
  // The switch stays (a failing server can still be turned off), so 已開啟 counts it as well
  // as 需處理: the summary never disagrees with the switches on screen.
  expect(view).toMatchObject({
    mode: "failed",
    switchVisible: true,
    attention: true,
    on: true,
    refreshVisible: false,
  });
  expect(view.status).toMatchObject({ tone: "danger", icon: "WarningCircle", label: "啟動失敗" });
  expect(view.notice).toEqual({
    tone: "danger",
    icon: "WarningCircle",
    text: "找不到啟動程式。",
    action: { kind: "refresh", label: "重試", primary: false },
  });
  expect(mcpServerView(server({ state: "unavailable" })).notice?.text).toBe(
    "無法連線；請檢查這個 MCP 的設定與執行狀態。",
  );
  expect(mcpFailureReason("a\u0000b\nc")).toBe("a b c");
  expect(mcpFailureReason("x".repeat(400))).toHaveLength(160);
});

test("a server that needs login has no switch and one primary 登入 with its consequence", () => {
  const view = oauth(summary({ login_domain: "login.example.test" }));
  expect(view).toMatchObject({ mode: "login", switchVisible: false, attention: true, on: false });
  expect(view.status).toMatchObject({ tone: "warning", icon: "SignIn", label: "需要登入" });
  expect(view.meta).toEqual(["HTTP", "OAuth"]);
  expect(view.notice).toEqual({
    tone: "warning",
    icon: "SignIn",
    text: "登入後會開啟這個伺服器的全部工具。",
    detail: "登入網站：login.example.test",
    action: { kind: "start", label: "登入", primary: true },
  });
  // Known tools preview what will open, including tools the user switched off earlier.
  const stale = summary({ tools_status: "stale", error_code: "auth_required" });
  const relogin = oauth(stale, { tools: server().tools });
  expect(relogin.status.label).toBe("需重新登入");
  expect(relogin.notice?.text).toBe("登入後會開啟全部 4 個工具。");
  expect(relogin.meta).toEqual(["HTTP", "OAuth"]);
  expect(relogin.toolsCurrent).toBe(false);
  const tools = server().tools.map((item, index) => ({ ...item, enabled: index > 0 }));
  expect(mcpLoginConsequence({ tools })).toBe("登入後會開啟其中 3 個工具。");
});

test("login failures stay a single danger notice with the fixed-map reason", () => {
  const expired = oauth(summary({ auth_phase: "error", error_code: "auth_expired" }));
  expect(expired.status).toMatchObject({ tone: "danger", label: "登入逾時" });
  expect(expired.notice).toMatchObject({
    tone: "danger",
    text: "登入逾時。登入後會開啟這個伺服器的全部工具。",
    action: { kind: "start", label: "重新登入", primary: true },
  });
  const unsupported = oauth(summary({ auth_phase: "error", error_code: "auth_unsupported" }));
  expect(unsupported).toMatchObject({ mode: "unsupported", switchVisible: false });
  expect(unsupported.notice?.action).toBeUndefined();
  expect(unsupported.notice?.text).toBe("服務未提供支援的註冊方式。");
});

test("login in progress, unknown results and authenticated states", () => {
  const waiting = oauth(summary({ auth_phase: "waiting", login_domain: "login.example.test" }));
  expect(waiting).toMatchObject({ mode: "auth_busy", attention: false, switchVisible: false });
  expect(waiting.notice).toMatchObject({
    tone: "running",
    text: "請在瀏覽器完成登入。",
    action: { kind: "cancel", label: "取消登入", primary: false },
  });
  const verifying = oauth(summary({ auth_phase: "verifying" }));
  expect(verifying.status).toMatchObject({ label: "確認登入中…", spin: true });
  expect(verifying.notice).toBeUndefined();

  const auth = summary({ auth_phase: "required" });
  const unknown = mcpServerView(server({ transport: "http", auth, tools: [] }), {
    summary: auth,
    view: { label: "登入狀態待確認", action: "query", button: "查詢狀態" },
  });
  expect(unknown).toMatchObject({ mode: "auth_unknown", attention: true });
  expect(unknown.notice?.action).toEqual({ kind: "query", label: "查詢狀態", primary: false });
  const forgetting = mcpServerView(server({ transport: "http", auth, tools: [] }), {
    summary: auth,
    view: { label: "清除登入中…", action: "query", button: "查詢狀態" },
  });
  expect(forgetting.mode).toBe("auth_busy");
  expect(forgetting.notice).toBeUndefined();

  const current = summary({ auth_phase: "authenticated", tools_status: "current" });
  const connected = oauth(current, { state: "ready", tools: server().tools });
  expect(connected).toMatchObject({
    mode: "ready",
    switchVisible: true,
    forgetVisible: true,
    refreshVisible: true,
    toolsCurrent: true,
  });
  // A catalog older than the login phase cannot drive tool switches yet.
  const lagging = mcpServerView(
    server({ transport: "http", auth: { ...current, phase_version: 0 }, tools: server().tools }),
    { summary: current, view: mcpAuthPresentation(current) },
  );
  expect(lagging).toMatchObject({ mode: "auth_busy", toolsCurrent: false });
  expect(lagging.status.label).toBe("取得工具中…");

  const listError = summary({
    auth_phase: "authenticated",
    tools_status: "error",
    error_code: "tools_list_timeout",
  });
  const failed = oauth(listError, { tools: server().tools });
  expect(failed).toMatchObject({ mode: "failed", switchVisible: true, forgetVisible: true });
  expect(failed.notice).toMatchObject({
    text: "工具清單請求逾時。",
    action: { kind: "refresh", label: "重試" },
  });

  const loadFailed = mcpServerView(server({ transport: "http", auth, tools: [] }), {
    summary: auth,
    view: mcpAuthPresentation(auth),
    loadFailed: true,
  });
  expect(loadFailed).toMatchObject({ mode: "auth_unknown", forgetVisible: true });
  expect(loadFailed.notice?.action).toBeUndefined();
  // Before the panel has read the saved login operation nothing is actionable.
  expect(mcpServerView(server({ transport: "http", auth, tools: [] }))).toMatchObject({
    mode: "auth_busy",
    switchVisible: false,
  });
});

test("summary counts exactly the switches shown on", () => {
  const views = [
    mcpServerView(server()),
    mcpServerView(server({ state: "unavailable" })),
    oauth(summary({})),
    mcpServerView(server({ enabled: false })),
  ];
  // Ready and failed-to-start show an on switch; the login card has none; off is off.
  expect(views.filter((view) => view.switchVisible && view.on)).toHaveLength(2);
  expect(views.every((view) => !view.on || view.switchVisible)).toBe(true);
  expect(mcpSummary(views)).toBe("4 個伺服器 · 2 個已開啟");
  expect(views.filter((view) => view.attention)).toHaveLength(2);
  // The chips count the same sets: 全部 4, 已開啟 2, 需處理 2.
  expect(mcpChipCounts(views)).toEqual({ all: 4, on: 2, attention: 2 });
  expect(mcpChipCounts([])).toEqual({ all: 0, on: 0, attention: 0 });
});

test("/ focuses search only outside text entry and without modifiers", () => {
  const key = { key: "/", ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false };
  expect(isSearchShortcut(key, { tagName: "BUTTON" })).toBe(true);
  expect(isSearchShortcut(key, null)).toBe(true);
  for (const tagName of ["INPUT", "textarea", "SELECT"])
    expect(isSearchShortcut(key, { tagName })).toBe(false);
  expect(isSearchShortcut(key, { tagName: "DIV", isContentEditable: true })).toBe(false);
  expect(isSearchShortcut({ ...key, ctrlKey: true }, null)).toBe(false);
  expect(isSearchShortcut({ ...key, isComposing: true }, null)).toBe(false);
  expect(isSearchShortcut({ ...key, key: "?" }, null)).toBe(false);
});

test("templates only prefill; placeholders must be replaced before saving", () => {
  expect(MCP_TEMPLATES.map((item) => item.label)).toEqual([
    "遠端 HTTPS（OAuth）",
    "Layer",
    "mcp-remote 橋接",
    "npx 套件",
  ]);
  const bridge = MCP_TEMPLATES.find((item) => item.id === "mcp-remote");
  expect(bridge).toMatchObject({ transport: "stdio", target: "npx.cmd" });
  expect(bridge?.args).toEqual(["-y", "mcp-remote@latest", "<url>", "--auth-timeout", "120"]);
  expect(MCP_TEMPLATES.find((item) => item.id === "layer")?.target).toBe(
    "https://mcp.app.layer.ai/mcp",
  );
  expect(mcpArgPlaceholder(bridge?.args ?? [])).toBe("<url>");
  expect(mcpArgPlaceholder(["-y", "pkg", "a<b>"])).toBeUndefined();
  expect(parseMcpArgs(" -y \r\n\n mcp-remote@latest \n")).toEqual(["-y", "mcp-remote@latest"]);
});

test("a pasted path loses Windows Explorer's enclosing quotes and nothing else", () => {
  // 複製為路徑 (Ctrl+Shift+C) wraps the path in one pair of double quotes.
  expect(mcpPathInput(' "C:\\Users\\Me\\proj" ')).toBe("C:\\Users\\Me\\proj");
  expect(mcpPathInput('"C:\\Program Files\\nodejs\\node.exe"')).toBe(
    "C:\\Program Files\\nodejs\\node.exe",
  );
  expect(mcpPathInput("  /srv/work  ")).toBe("/srv/work");
  for (const kept of ['"', '"C:\\proj', 'C:\\proj"', "'/srv/work'", 'C:\\"a"'])
    expect(mcpPathInput(kept)).toBe(kept);
  expect(mcpPathInput('""')).toBe("");
});

test("the argv risk line names remote package runners and never claims isolation", () => {
  expect(mcpRemoteRunner("npx.cmd", [])).toBe("npx");
  expect(mcpRemoteRunner("C:\\Program Files\\nodejs\\NPX.CMD", [])).toBe("npx");
  expect(mcpRemoteRunner("/usr/bin/bunx", [])).toBe("bunx");
  expect(mcpRemoteRunner("pnpm", ["dlx", "x"])).toBe("pnpm dlx");
  expect(mcpRemoteRunner("pnpm", ["exec"])).toBeUndefined();
  expect(mcpRemoteRunner("node", [])).toBeUndefined();
  expect(mcpStdioRiskLine("npx.cmd", [])).toBe("npx 會下載並執行遠端套件，使用你的主機權限。");
  expect(mcpStdioRiskLine("node", [])).toBe("這個程式以你的主機權限執行，沒有隔離。");
  for (const line of [mcpStdioRiskLine("npx", []), mcpStdioRiskLine("x", []), MCP_ADD_CONSEQUENCE])
    expect(line).not.toMatch(/sandbox|沙箱|隔離環境|只限此聊天/);
  expect(MCP_ADD_CONSEQUENCE).toBe("加入後，ChatGPT 立即可以使用這個伺服器的所有工具。");
});
