import type { McpCatalogTool, McpPanelState } from "@kairomes/protocol";

export type McpToolFilter = "all" | "enabled" | "disabled" | "read_only";
export interface McpFilter {
  query: string;
  serverId: string;
  tools: McpToolFilter;
}

// Search includes descriptions without putting them in every visible row.
export function filterMcpCatalog(state: McpPanelState, filter: McpFilter) {
  const words = filter.query
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return state.servers.flatMap((server) => {
    if (filter.serverId && server.id !== filter.serverId) return [];
    const matches = (tool?: McpCatalogTool) => {
      const text = [server.name, tool?.name, tool?.title, tool?.description]
        .filter(Boolean)
        .join(" ")
        .normalize("NFKC")
        .toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    };
    const tools = server.tools.filter((tool) => {
      if (filter.tools === "enabled" && !tool.enabled) return false;
      if (filter.tools === "disabled" && tool.enabled) return false;
      if (filter.tools === "read_only" && tool.read_only_hint !== true) return false;
      return matches(tool);
    });
    if (!tools.length && (filter.tools !== "all" || !matches())) return [];
    return [{ server, tools }];
  });
}
