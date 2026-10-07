import type { McpCatalogTool, McpPanelState } from "@kairomes/protocol";

type Server = McpPanelState["servers"][number];

/** 全部 / 已開啟 / 需處理 */
export type McpServerChip = "all" | "on" | "attention";
export interface McpFilter {
  query: string;
  chip: McpServerChip;
}
export interface McpFilterMatch {
  server: Server;
  /**
   * Present when the query matched individual tools rather than the server name: the card
   * then lists exactly these tools. Absent means the whole server matched.
   */
  tools?: McpCatalogTool[];
}

const fold = (text: string) => text.normalize("NFKC").toLocaleLowerCase();

export function mcpQueryWords(query: string) {
  return fold(query).trim().split(/\s+/).filter(Boolean);
}

/**
 * Chip first, then the query. Search covers the server name and each tool's name, title and
 * description (without putting descriptions in every row); every word must match.
 */
export function filterMcpServers(
  state: McpPanelState,
  filter: McpFilter,
  classify: (server: Server) => { on: boolean; attention: boolean },
): McpFilterMatch[] {
  const words = mcpQueryWords(filter.query);
  return state.servers.flatMap((server) => {
    const kind = classify(server);
    if (filter.chip === "on" && !kind.on) return [];
    if (filter.chip === "attention" && !kind.attention) return [];
    if (!words.length) return [{ server }];
    const name = fold(server.name);
    if (words.every((word) => name.includes(word))) return [{ server }];
    const tools = server.tools.filter((tool) => {
      const text = fold(
        [server.name, tool.name, tool.title, tool.description].filter(Boolean).join(" "),
      );
      return words.every((word) => text.includes(word));
    });
    return tools.length ? [{ server, tools }] : [];
  });
}
