import { expect, test } from "bun:test";
import type { McpCatalogTool, McpPanelState } from "@kairomes/protocol";
import { filterMcpServers, mcpQueryWords } from "./mcp-filter.ts";

const tool = (index: number): McpCatalogTool => ({
  ref: `ref-${index}`,
  server_id: "00000000-0000-4000-8000-000000000001",
  server_name: "瀏覽器",
  name: `browser_action_${index}`,
  title: index === 73 ? "Take Screenshot" : `動作 ${index}`,
  description: index === 73 ? "擷取頁面 screenshot" : "檢視資料",
  enabled: index % 2 === 0,
  availability: "unavailable",
  read_only_hint: index % 3 === 0,
  destructive_hint: null,
  open_world_hint: null,
  schema_fingerprint: `schema-${index}`,
});
const state = (): McpPanelState => ({
  catalog_revision: "revision-one",
  servers: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      name: "瀏覽器",
      transport: "stdio",
      enabled: false,
      state: "unavailable",
      tools: Array.from({ length: 100 }, (_, index) => tool(index)),
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      name: "資料庫",
      transport: "http",
      enabled: true,
      state: "ready",
      tools: [
        { ...tool(101), server_id: "00000000-0000-4000-8000-000000000002", server_name: "資料庫" },
      ],
    },
  ],
});
// The view decides 已開啟 / 需處理; here the second server is on and the first needs action.
const classify = (server: McpPanelState["servers"][number]) => ({
  on: server.enabled,
  attention: !server.enabled,
});
const names = (result: ReturnType<typeof filterMcpServers>) =>
  result.map((item) => [item.server.name, item.tools?.map((entry) => entry.name)]);

test("finds a tool among 100 by name, title, description and mixed server tokens", () => {
  const catalog = state();
  for (const query of [
    "browser_action_73",
    " SCREENSHOT ",
    "擷取頁面",
    "瀏覽器 screenshot",
    "Ｓｃｒｅｅｎｓｈｏｔ",
  ]) {
    const result = filterMcpServers(catalog, { query, chip: "all" }, classify);
    expect(names(result)).toEqual([["瀏覽器", ["browser_action_73"]]]);
  }
  expect(filterMcpServers(catalog, { query: "no match", chip: "all" }, classify)).toEqual([]);
  expect(mcpQueryWords("  Ａ  b ")).toEqual(["a", "b"]);
});

test("a server-name match keeps the whole server instead of narrowing its tools", () => {
  const catalog = state();
  const result = filterMcpServers(catalog, { query: "資料", chip: "all" }, classify);
  // 資料庫 matches by name; 瀏覽器 matches only through descriptions (檢視資料).
  expect(result.map((item) => item.server.name)).toEqual(["瀏覽器", "資料庫"]);
  expect(result[1]?.tools).toBeUndefined();
  expect(result[0]?.tools).toHaveLength(99);
  expect(filterMcpServers(catalog, { query: "", chip: "all" }, classify)).toHaveLength(2);
});

test("chips filter servers by the view's classification before the query", () => {
  const catalog = state();
  const untouched = structuredClone(catalog);
  expect(names(filterMcpServers(catalog, { query: "", chip: "on" }, classify))).toEqual([
    ["資料庫", undefined],
  ]);
  expect(names(filterMcpServers(catalog, { query: "", chip: "attention" }, classify))).toEqual([
    ["瀏覽器", undefined],
  ]);
  expect(filterMcpServers(catalog, { query: "screenshot", chip: "on" }, classify)).toEqual([]);
  expect(catalog).toEqual(untouched);
});

test("a fresh catalog drops old matches; an empty server still matches by name", () => {
  const catalog = state();
  catalog.catalog_revision = "revision-two";
  catalog.servers[0]?.tools.splice(73, 1);
  expect(filterMcpServers(catalog, { query: "screenshot", chip: "all" }, classify)).toEqual([]);
  const first = catalog.servers[0];
  if (!first) throw new Error("Missing fixture server");
  first.tools = [];
  expect(names(filterMcpServers(catalog, { query: "瀏覽器", chip: "all" }, classify))).toEqual([
    ["瀏覽器", undefined],
  ]);
});
