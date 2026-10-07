import type { McpAuthIdentity } from "../apps/extension/src/mcp-auth-tracker.ts";
import { McpPanel } from "../apps/extension/src/mcp-panel.ts";
import { importHydrationText } from "../apps/extension/src/panel-view.ts";
import type {
  McpAuthInput,
  McpAuthResult,
  McpAuthSummary,
  McpCatalogTool,
  McpPanelState,
} from "../packages/protocol/src/index.ts";
import {
  markConnected,
  syntheticAccess,
  syntheticGrants,
  syntheticSwitcher,
} from "./panel-chrome-fixture.ts";

// Visual fixture for 設定 → MCP 整合: three synthetic servers (connected, needs login, failed
// to start) in memory. No MCP server, OAuth provider, browser or credential is involved.
const fixtureOptions = new URLSearchParams(location.search);

const devtoolsId = "11111111-1111-4111-8111-111111111111";
const githubId = "22222222-2222-4222-8222-222222222222";
const filesId = "33333333-3333-4333-8333-333333333333";
const instanceId = "00000000-0000-4000-8000-0000000000aa";

const devtoolsNames = [
  "click",
  "close_page",
  "drag",
  "emulate",
  "evaluate_script",
  "fill",
  "fill_form",
  "get_console_message",
  "get_network_request",
  "handle_dialog",
  "hover",
  "list_console_messages",
  "list_network_requests",
  "list_pages",
  "navigate_page",
  "new_page",
  "performance_analyze_insight",
  "performance_start_trace",
  "performance_stop_trace",
  "press_key",
  "resize_page",
  "select_page",
  "take_screenshot",
  "take_snapshot",
  "type_text",
  "upload_file",
  "wait_for",
];
if (fixtureOptions.get("count") === "100") {
  while (devtoolsNames.length < 100) devtoolsNames.push(`fixture_tool_${devtoolsNames.length}`);
}

function tool(serverId: string, serverName: string, name: string, index: number): McpCatalogTool {
  const readOnly = /^(get_|list_|take_|wait_|search_|read_)/.test(name);
  const modifies = /^(fill|upload_|create_|update_|delete_|type_)/.test(name);
  return {
    ref: `preview-${serverId.slice(0, 4)}-${index}`,
    server_id: serverId,
    server_name: serverName,
    name,
    title: name
      .split("_")
      .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
      .join(" "),
    description: `${serverName} action: ${name.replaceAll("_", " ")}.`,
    // A couple of tools start off so the count and an off switch are visible.
    enabled: !["fill_form", "upload_file", "delete_branch"].includes(name),
    availability: fixtureOptions.has("unavailable") && index === 42 ? "unavailable" : "ready",
    read_only_hint: readOnly,
    destructive_hint: modifies ? true : readOnly ? false : null,
    open_world_hint: /navigate|new_page|network|search_item_[1-6]$|request_review/.test(name),
    schema_fingerprint: `preview-${serverId.slice(0, 4)}-${index}`,
  };
}

const githubNames = [
  ...Array.from({ length: 30 }, (_, index) => `search_item_${index + 1}`),
  "create_issue",
  "update_issue",
  "create_branch",
  "delete_branch",
  "create_pull_request",
  "read_file",
  "merge_pull_request",
  "add_comment",
  "request_review",
  "rerun_job",
  "dispatch_workflow",
];
let githubAuth: McpAuthSummary = {
  auth_phase: "required",
  tools_status: "stale",
  phase_version: 1,
  error_code: "auth_required",
  login_domain: "github.com",
};

let state: McpPanelState = {
  catalog_revision: "visual-fixture",
  servers: fixtureOptions.has("empty")
    ? []
    : [
        {
          id: devtoolsId,
          name: "Chrome DevTools",
          transport: "stdio",
          config_fingerprint: "1".repeat(64),
          enabled: true,
          state: "ready",
          tools: devtoolsNames.map((name, index) =>
            tool(devtoolsId, "Chrome DevTools", name, index),
          ),
        },
        {
          id: githubId,
          name: "GitHub",
          transport: "http",
          config_fingerprint: "2".repeat(64),
          enabled: true,
          state: "unavailable",
          tools: githubNames.map((name, index) => tool(githubId, "GitHub", name, index)),
          auth: githubAuth,
        },
        {
          id: filesId,
          name: "Filesystem",
          transport: "stdio",
          config_fingerprint: "3".repeat(64),
          enabled: true,
          state: "unavailable",
          message: "找不到啟動程式或工作目錄。",
          tools: [],
        },
      ],
};

function bump() {
  state = { ...state, catalog_revision: crypto.randomUUID() };
  return structuredClone(state);
}

function setGithubAuth(next: Partial<McpAuthSummary>) {
  const { error_code: _, ...rest } = githubAuth;
  githubAuth = { ...rest, ...next, phase_version: githubAuth.phase_version + 1 };
  state = {
    ...state,
    servers: state.servers.map((server) =>
      server.id === githubId ? { ...server, auth: githubAuth } : server,
    ),
  };
}

// Synthetic login: start → waiting (until cancelled); status queries echo the summary.
function authResult(input: McpAuthInput, outcome: McpAuthResult["receipt_outcome"]) {
  const forget =
    input.action === "forget" || (input.action === "status" && input.operation === "forget");
  return {
    instance_id: input.instance_id,
    server_id: input.server_id,
    config_fingerprint: input.config_fingerprint,
    operation_id: input.operation_id,
    ...githubAuth,
    operation: forget ? "forget" : "login",
    receipt_outcome: outcome,
  } satisfies McpAuthResult;
}

const saved = new Map<string, unknown>();
const authKey = (identity: McpAuthIdentity) =>
  `${identity.server_id}:${identity.config_fingerprint}`;
const panel: McpPanel = new McpPanel(
  document.querySelector<HTMLElement>("#integrations") as HTMLElement,
  async (body) => {
    const input = body as {
      action: string;
      server_id?: string;
      tool_name?: string;
      enabled?: boolean;
      name?: string;
    };
    if (["add_stdio", "add_http"].includes(input.action) && fixtureOptions.has("add-failed"))
      throw new Error("合成測試：無法加入，請核對設定。");
    if (input.action === "set_server_enabled")
      state = {
        ...state,
        servers: state.servers.map((server) =>
          server.id === input.server_id ? { ...server, enabled: input.enabled === true } : server,
        ),
      };
    if (input.action === "set_tool_enabled")
      state = {
        ...state,
        servers: state.servers.map((server) =>
          server.id !== input.server_id
            ? server
            : {
                ...server,
                tools: server.tools.map((item) =>
                  item.name === input.tool_name
                    ? { ...item, enabled: input.enabled === true }
                    : item,
                ),
              },
        ),
      };
    if (input.action === "remove")
      state = {
        ...state,
        servers: state.servers.filter((server) => server.id !== input.server_id),
      };
    return bump();
  },
  (message) => {
    // The fixture shows reports in the same single notice slot as the coordinator.
    const error = document.querySelector<HTMLElement>("#panel-error");
    const notice = document.querySelector<HTMLElement>("#panel-notice");
    if (error && notice) {
      error.textContent = message;
      notice.hidden = !message;
    }
  },
  () => "fixture-source",
  {
    context: () => ({ source: "fixture-source", instanceId }),
    load: async (identity) => saved.get(authKey(identity)),
    save: async (identity, next) => {
      if (next) saved.set(authKey(identity), structuredClone(next));
      else saved.delete(authKey(identity));
    },
    request: async (input) => {
      if (input.action === "start") {
        setGithubAuth({ auth_phase: "waiting", tools_status: "stale" });
        return authResult(input, "pending");
      }
      if (input.action === "cancel" || input.action === "forget") {
        setGithubAuth({
          auth_phase: "required",
          tools_status: "stale",
          error_code: "auth_required",
        });
        return authResult(input, input.action === "cancel" ? "cancelled" : "completed");
      }
      return authResult(input, githubAuth.auth_phase === "waiting" ? "pending" : "completed");
    },
    refresh: () => panel.render(bump(), true),
  },
);
panel.render(state, true);
if (fixtureOptions.get("open") === "tools")
  document.querySelector<HTMLButtonElement>(".mcp-card__expand")?.click();
// ?refresh=1 replays the coordinator's 10 s catalog refresh every second.
if (fixtureOptions.has("refresh")) setInterval(() => panel.render(bump(), true), 1000);

// Toolbar and settings chrome in a paired-looking state; ?page=general shows the 一般 tab.
const workspaces = [
  { id: "fixture-a", name: "docs-site" },
  { id: "fixture-b", name: "Kairomes" },
];
markConnected();
syntheticAccess(
  {
    instanceId: "fixture",
    sessions: [],
    workspaces,
    accessGrants: syntheticGrants(workspaces, fixtureOptions),
  },
  workspaces[0]?.id ?? null,
);
syntheticSwitcher(workspaces, workspaces[0]?.id ?? null, () => {});
const page = fixtureOptions.get("page") === "general" ? "general" : "mcp";
for (const tab of document.querySelectorAll<HTMLElement>("[data-settings-page]")) {
  const active = tab.dataset.settingsPage === page;
  tab.setAttribute("aria-selected", String(active));
  tab.tabIndex = active ? 0 : -1;
}
for (const section of document.querySelectorAll<HTMLElement>("[data-settings-panel]"))
  section.hidden = section.dataset.settingsPanel !== page;
const gear = document.querySelector<HTMLElement>("#settings-open");
gear?.setAttribute("aria-pressed", "true");
const gearIcon = gear?.querySelector("use");
gearIcon?.setAttribute("href", "#ph-gear-six-fill");
const pairing = document.querySelector<HTMLElement>("#pairing-row");
if (pairing) pairing.hidden = false;
const channel = document.querySelector<HTMLElement>("#approval-channel");
if (channel) {
  channel.dataset.tone = "success";
  channel.querySelector(".k-dot")?.setAttribute("data-tone", "success");
  const label = channel.querySelector("span:last-child");
  if (label) label.textContent = "已連線";
}
// The trusted import diagnostic, as sidepanel.ts renders it from the panel snapshot.
const hydration = document.querySelector<HTMLElement>("#import-hydration");
const hydrationText = importHydrationText({ hydrated: 2, omitted: 1, rejected: 0 });
if (hydration && hydrationText) {
  hydration.hidden = false;
  hydration.textContent = hydrationText;
}
const version = document.querySelector<HTMLElement>("#extension-version");
if (version) version.textContent = "0.3.0";
