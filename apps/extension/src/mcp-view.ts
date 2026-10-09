import type { McpAuthSummary, McpCatalogTool, McpPanelState } from "@kairomes/protocol";
import { toneFor, type UiDataTone, type UiStateIcon } from "@kairomes/protocol/ui-state";
import type { PanelIcon } from "./icons.ts";
import { mcpAuthDiagnostic } from "./mcp-auth-diagnostic.ts";

// Pure presentation for the MCP 整合 settings tab: no DOM, so every branch is unit tested.
// Copy follows spec §5.2 / §7: one status, one action, each fact stated once.

type Server = McpPanelState["servers"][number];

/** Server-provided hints. They are labelled as hints, never as guarantees. */
export type McpRiskKind = "read_only" | "modify" | "action" | "network";
export const MCP_RISKS: Record<
  McpRiskKind,
  { tone: "neutral" | "warning"; icon: PanelIcon; label: string }
> = {
  read_only: { tone: "neutral", icon: "Eye", label: "唯讀" },
  modify: { tone: "warning", icon: "PencilSimple", label: "可能修改資料" },
  action: { tone: "warning", icon: "Lightning", label: "可執行動作" },
  network: { tone: "warning", icon: "Globe", label: "可連外" },
};
const riskOrder: McpRiskKind[] = ["read_only", "modify", "action", "network"];

/**
 * One effect kind per tool plus 可連外 when the server says so. A tool without hints is an
 * action: missing metadata never reads as 唯讀.
 */
export function mcpToolRisks(tool: McpCatalogTool): McpRiskKind[] {
  const kinds: McpRiskKind[] = [
    tool.destructive_hint === true
      ? "modify"
      : tool.read_only_hint === true
        ? "read_only"
        : "action",
  ];
  if (tool.open_world_hint === true) kinds.push("network");
  return kinds;
}

/** Counts per hint in a fixed order; kinds without tools are omitted. */
export function mcpRiskCounts(tools: readonly McpCatalogTool[]) {
  const counts = new Map<McpRiskKind, number>();
  for (const tool of tools)
    for (const kind of mcpToolRisks(tool)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return riskOrder.flatMap((kind) => {
    const count = counts.get(kind) ?? 0;
    return count ? [{ kind, count, ...MCP_RISKS[kind] }] : [];
  });
}

/** Return value of mcpAuthPresentation (mcp-auth-tracker.ts). */
export interface McpAuthView {
  label: string;
  action: "query" | "none" | "cancel" | "refresh" | "start";
  button: string;
}

export interface McpServerAuth {
  summary: McpAuthSummary;
  view: McpAuthView;
  /** The saved login operation could not be read back; only 清除登入 stays available. */
  loadFailed?: boolean;
}

export type McpServerMode =
  | "off"
  | "ready"
  | "connecting"
  | "disconnected"
  | "failed"
  | "login"
  | "auth_busy"
  | "auth_unknown"
  | "unsupported";

export type McpNoticeAction = "refresh" | "start" | "cancel" | "query";
export interface McpNotice {
  tone: UiDataTone;
  icon: PanelIcon;
  text: string;
  /** A second, quieter fact such as the login site. */
  detail?: string;
  action?: { kind: McpNoticeAction; label: string; primary: boolean };
}

export interface McpServerView {
  mode: McpServerMode;
  status: { tone: UiDataTone; icon: UiStateIcon; label: string; spin: boolean };
  /**
   * The server switch appears while the server is usable, off, or failed: a failing server
   * can still be turned off. It is hidden while a login decides what the server can do.
   */
  switchVisible: boolean;
  /** Counted by 已開啟: exactly the cards whose switch shows on (a failed one included). */
  on: boolean;
  /** Counted by 需處理: on, but the user must act (login, failure, unknown result). */
  attention: boolean;
  /** Transport, OAuth and tool count, joined with · by the view. */
  meta: string[];
  notice?: McpNotice;
  /** The quiet 重新探索 icon; hidden when the notice already offers 重試. */
  refreshVisible: boolean;
  forgetVisible: boolean;
  /** Tool switches can change only against a current tool list. */
  toolsCurrent: boolean;
}

const fallbackFailure = "無法連線；請檢查這個 MCP 的設定與執行狀態。";

/** The Host's fixed-map sentence, bounded and stripped of control characters. */
export function mcpFailureReason(message?: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters.
  const clean = (message ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean ? clean.slice(0, 160) : fallbackFailure;
}

/** 「登入後會開啟全部 41 個工具。」, or the subset that stays on after a re-login. */
export function mcpLoginConsequence(server: Pick<Server, "tools">) {
  const total = server.tools.length;
  if (!total) return "登入後會開啟這個伺服器的全部工具。";
  const enabled = server.tools.filter((tool) => tool.enabled).length;
  return enabled === total
    ? `登入後會開啟全部 ${total} 個工具。`
    : `登入後會開啟其中 ${enabled} 個工具。`;
}

export function mcpToolCount(server: Pick<Server, "tools">) {
  const total = server.tools.length;
  const enabled = server.tools.filter((tool) => tool.enabled).length;
  return enabled === total ? `${total} 個工具` : `${enabled}／${total} 個工具已開啟`;
}

const status = (kind: "mcp_server" | "mcp_auth", state: string, label?: string) => {
  const { dataTone, icon, label: base, spin } = toneFor(kind, state);
  return { tone: dataTone, icon, label: label ?? base, spin };
};

/** Mode, status, notice and actions for one server card. */
export function mcpServerView(server: Server, auth?: McpServerAuth): McpServerView {
  const summary = auth?.summary ?? server.auth;
  // Tool switches need the list that the latest login phase produced (same rule as before).
  const toolsCurrent =
    !server.auth ||
    Boolean(
      summary?.tools_status === "current" &&
        server.auth.tools_status === "current" &&
        server.auth.phase_version >= summary.phase_version,
    );
  const meta = [server.transport === "http" ? "HTTP" : "stdio"];
  if (server.auth) meta.push("OAuth");
  const view = (
    mode: McpServerMode,
    fields: Omit<McpServerView, "mode" | "meta" | "on" | "attention" | "toolsCurrent">,
  ): McpServerView => {
    // In login mode the notice states what will open, so the count is not repeated here.
    if (server.tools.length && (toolsCurrent || mode === "off")) meta.push(mcpToolCount(server));
    else if (mode === "ready" && toolsCurrent) meta.push("沒有公開工具");
    const usable = ["ready", "connecting", "disconnected"].includes(mode);
    return {
      mode,
      meta,
      on: server.enabled && fields.switchVisible,
      attention: server.enabled && !usable && mode !== "auth_busy",
      ...fields,
      toolsCurrent,
    };
  };
  const authenticated = summary?.auth_phase === "authenticated";

  if (!server.enabled)
    return view("off", {
      status: status("mcp_server", "disabled"),
      switchVisible: true,
      refreshVisible: false,
      forgetVisible: Boolean(auth && authenticated),
    });

  if (server.auth && auth) {
    const presentation = auth.view;
    const diagnostic = mcpAuthDiagnostic(auth.summary.error_code)?.message;
    const domain = auth.summary.login_domain ? `登入網站：${auth.summary.login_domain}` : undefined;
    if (auth.loadFailed)
      return view("auth_unknown", {
        status: status("mcp_auth", "unknown"),
        switchVisible: false,
        notice: {
          tone: "warning",
          icon: "Question",
          text: "無法讀取這個伺服器的登入狀態。清除登入後可以重新登入。",
        },
        refreshVisible: false,
        forgetVisible: true,
      });
    if (presentation.action === "start") {
      const failed = !["需要登入", "需重新登入"].includes(presentation.label);
      return view("login", {
        status: failed
          ? status("mcp_auth", "error", presentation.label)
          : status("mcp_server", "needs_login", presentation.label),
        switchVisible: false,
        notice: {
          tone: failed ? "danger" : "warning",
          icon: failed ? "WarningCircle" : "SignIn",
          text: failed
            ? `${diagnostic ?? `${presentation.label}。`}${mcpLoginConsequence(server)}`
            : mcpLoginConsequence(server),
          ...(domain ? { detail: domain } : {}),
          action: { kind: "start", label: presentation.button, primary: true },
        },
        refreshVisible: false,
        forgetVisible: false,
      });
    }
    if (presentation.action === "cancel")
      return view("auth_busy", {
        status: status("mcp_auth", "waiting", presentation.label),
        switchVisible: false,
        notice: {
          tone: "running",
          icon: "SignIn",
          text: "請在瀏覽器完成登入。",
          ...(domain ? { detail: domain } : {}),
          action: { kind: "cancel", label: presentation.button, primary: false },
        },
        refreshVisible: false,
        forgetVisible: false,
      });
    if (presentation.action === "query" && presentation.label !== "登入狀態待確認")
      // 清除登入中… / 取消登入中…: the panel keeps querying on its own.
      return view("auth_busy", {
        status: status("mcp_auth", "verifying", presentation.label),
        switchVisible: false,
        refreshVisible: false,
        forgetVisible: false,
      });
    if (presentation.action === "query")
      return view("auth_unknown", {
        status: status("mcp_auth", "unknown", presentation.label),
        switchVisible: false,
        notice: {
          tone: "warning",
          icon: "Question",
          text: "還不確定登入操作是否完成；查詢後再決定下一步，或清除登入後重新登入。",
          action: { kind: "query", label: presentation.button, primary: false },
        },
        refreshVisible: false,
        forgetVisible: true,
      });
    if (presentation.action === "none" && auth.summary.error_code === "auth_unsupported")
      return view("unsupported", {
        status: status("mcp_auth", "error", presentation.label),
        switchVisible: false,
        notice: {
          tone: "danger",
          icon: "WarningCircle",
          text: diagnostic ?? `${presentation.label}。`,
        },
        refreshVisible: false,
        forgetVisible: false,
      });
    const listFailed = authenticated && ["error", "stale"].includes(auth.summary.tools_status);
    if (presentation.action === "refresh" && listFailed)
      return view("failed", {
        status: status("mcp_server", "unavailable", presentation.label),
        switchVisible: true,
        notice: {
          tone: "danger",
          icon: "WarningCircle",
          text: diagnostic ?? `${presentation.label}。`,
          action: { kind: "refresh", label: "重試", primary: false },
        },
        refreshVisible: false,
        forgetVisible: true,
      });
    // Starting, verifying, loading tools, or a catalog that lags the login phase.
    if (presentation.action === "none" || !toolsCurrent)
      return view("auth_busy", {
        status: status(
          "mcp_auth",
          "verifying",
          presentation.action === "none" ? presentation.label : "取得工具中…",
        ),
        switchVisible: false,
        refreshVisible: false,
        forgetVisible: false,
      });
    return view(server.state === "ready" ? "ready" : "connecting", {
      status: status("mcp_server", server.state === "ready" ? "ready" : "connecting"),
      switchVisible: true,
      refreshVisible: true,
      forgetVisible: true,
    });
  }

  if (server.auth)
    // The login state has not been read for this pairing yet.
    return view("auth_busy", {
      status: status("mcp_auth", "unknown", "登入狀態待確認"),
      switchVisible: false,
      refreshVisible: false,
      forgetVisible: false,
    });

  if (server.state === "unavailable")
    return view("failed", {
      status: status("mcp_server", "unavailable"),
      switchVisible: true,
      notice: {
        tone: "danger",
        icon: "WarningCircle",
        text: mcpFailureReason(server.message),
        action: { kind: "refresh", label: "重試", primary: false },
      },
      refreshVisible: false,
      forgetVisible: false,
    });
  return view(server.state, {
    status: status("mcp_server", server.state),
    switchVisible: true,
    refreshVisible: true,
    forgetVisible: false,
  });
}

/** Filter chip counts: 全部 N, 已開啟 N (switches shown on), 需處理 N (hidden at 0). */
export function mcpChipCounts(views: readonly Pick<McpServerView, "on" | "attention">[]) {
  return {
    all: views.length,
    on: views.filter((view) => view.on).length,
    attention: views.filter((view) => view.attention).length,
  };
}

/** 「3 個伺服器 · 1 個已開啟」, the same numbers as the 全部 and 已開啟 chips. */
export function mcpSummary(views: readonly Pick<McpServerView, "on" | "attention">[]) {
  const counts = mcpChipCounts(views);
  return `${counts.all} 個伺服器 · ${counts.on} 個已開啟`;
}

/** `/` focuses search unless the user is typing, composing or using a modifier. */
export function isSearchShortcut(
  event: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    isComposing?: boolean;
    defaultPrevented: boolean;
  },
  target: { tagName?: string; isContentEditable?: boolean } | null,
) {
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.isComposing || event.defaultPrevented) return false;
  const tag = target?.tagName?.toUpperCase();
  return !(target?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT");
}

/* ---------- Add dialog: prefill-only templates and the exact argv (E6) ---------- */

export interface McpTemplate {
  id: string;
  label: string;
  transport: "stdio" | "http";
  name: string;
  target: string;
  args: readonly string[];
}

/** Static, bundled presets. They only fill the form; nothing is fetched or saved. */
export const MCP_TEMPLATES: readonly McpTemplate[] = [
  {
    id: "oauth",
    label: "遠端 HTTPS（OAuth）",
    transport: "http",
    name: "",
    target: "https://",
    args: [],
  },
  {
    id: "layer",
    label: "Layer",
    transport: "http",
    name: "Layer",
    target: "https://mcp.app.layer.ai/mcp",
    args: [],
  },
  {
    id: "mcp-remote",
    label: "mcp-remote 橋接",
    transport: "stdio",
    name: "",
    target: "npx.cmd",
    args: ["-y", "mcp-remote@latest", "<url>", "--auth-timeout", "120"],
  },
  {
    id: "npx",
    label: "npx 套件",
    transport: "stdio",
    name: "",
    target: "npx.cmd",
    args: ["-y", "<套件名稱>"],
  },
];

/** One argument per line, trimmed; blank lines are dropped (the form's long-standing rule). */
export function parseMcpArgs(text: string) {
  return text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * A typed or pasted local path: trimmed, without the one pair of double quotes that Windows
 * Explorer's 複製為路徑 adds (`"C:\Users\Me\proj"`). No path ever starts and ends with a quote.
 */
export function mcpPathInput(text: string) {
  const value = text.trim();
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/** A template placeholder such as `<url>` that must be replaced before saving. */
export function mcpArgPlaceholder(args: readonly string[]) {
  return args.find((arg) => /^<[^<>]+>$/.test(arg));
}

const remoteRunners: Record<string, string> = { npx: "npx", bunx: "bunx", pnpx: "pnpx" };

/** Runners that download a package and execute it, by executable basename. */
export function mcpRemoteRunner(command: string, args: readonly string[]) {
  const base = (command.trim().split(/[\\/]/).pop() ?? "")
    .toLowerCase()
    .replace(/\.(cmd|exe|bat|ps1)$/, "");
  if (Object.hasOwn(remoteRunners, base)) return remoteRunners[base];
  if ((base === "pnpm" || base === "yarn") && args[0] === "dlx") return `${base} dlx`;
  return undefined;
}

/** The single host-privilege line under the argv preview. Never claims isolation. */
export function mcpStdioRiskLine(command: string, args: readonly string[]) {
  const runner = mcpRemoteRunner(command, args);
  return runner
    ? `${runner} 會下載並執行遠端套件，使用你的主機權限。`
    : "這個程式以你的主機權限執行，沒有隔離。";
}

/** Same for both transports (X11): every tool is on as soon as the server is added. */
export const MCP_ADD_CONSEQUENCE = "加入後，ChatGPT 立即可以使用這個伺服器的所有工具。";
