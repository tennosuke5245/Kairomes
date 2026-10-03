import { McpPanel } from "../apps/extension/src/mcp-panel.ts";
import type { McpCatalogTool, McpPanelState } from "../packages/protocol/src/index.ts";

const fixtureOptions = new URLSearchParams(location.search);

const names = [
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
  while (names.length < 100) names.push(`fixture_tool_${names.length}`);
}

function tool(name: string, index: number): McpCatalogTool {
  const readOnly = /^(get_|list_|take_|wait_)/.test(name);
  return {
    ref: `preview-${index}`,
    server_id: "11111111-1111-4111-8111-111111111111",
    server_name: "Chrome DevTools",
    name,
    title: name
      .split("_")
      .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
      .join(" "),
    description:
      name === "take_screenshot"
        ? "Capture a screenshot of the page or a selected element and return it to ChatGPT."
        : `Chrome DevTools action: ${name.replaceAll("_", " ")}.`,
    enabled: true,
    availability: fixtureOptions.has("unavailable") && index === 42 ? "unavailable" : "ready",
    read_only_hint: readOnly,
    destructive_hint: readOnly ? false : null,
    open_world_hint: !readOnly,
    schema_fingerprint: `preview-${index}`,
  };
}

let state: McpPanelState = {
  catalog_revision: "visual-fixture",
  servers: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Chrome DevTools",
      transport: "stdio",
      enabled: true,
      state: "ready",
      tools: names.map(tool),
    },
  ],
};

const panel = new McpPanel(
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
    if (input.action === "set_server_enabled") {
      state = {
        ...state,
        servers: state.servers.map((server) =>
          server.id === input.server_id ? { ...server, enabled: input.enabled === true } : server,
        ),
      };
    }
    if (input.action === "set_tool_enabled") {
      state = {
        ...state,
        servers: state.servers.map((server) => ({
          ...server,
          tools: server.tools.map((item) =>
            item.name === input.tool_name ? { ...item, enabled: input.enabled === true } : item,
          ),
        })),
      };
    }
    if (input.action === "remove") state = { ...state, servers: [] };
    state = { ...state, catalog_revision: crypto.randomUUID() };
    return structuredClone(state);
  },
  (message) => {
    const error = document.querySelector<HTMLElement>("#panel-error");
    if (error) {
      error.textContent = message;
      error.hidden = !message;
      const notice = document.querySelector<HTMLElement>("#panel-notice");
      const content = document.querySelector<HTMLElement>(".settings-content");
      if (notice && content) {
        if (notice.parentElement !== content) content.prepend(notice);
        notice.hidden = !message;
      }
    }
  },
);
panel.render(state, true);
