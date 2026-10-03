import { expect, test } from "bun:test";
import type { McpCatalogTool, McpPanelState } from "@kairomes/protocol";
import { filterMcpCatalog } from "./mcp-filter.ts";

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

test("finds a tool among 100 by name, title, description and mixed server tokens", () => {
  const catalog = state();
  for (const query of [
    "browser_action_73",
    " SCREENSHOT ",
    "擷取頁面",
    "瀏覽器 screenshot",
    "Ｓｃｒｅｅｎｓｈｏｔ",
  ]) {
    const result = filterMcpCatalog(catalog, { query, serverId: "", tools: "all" });
    expect(result).toHaveLength(1);
    expect(result[0]?.tools.map((item) => item.name)).toEqual(["browser_action_73"]);
  }
  expect(filterMcpCatalog(catalog, { query: "no match", serverId: "", tools: "all" })).toEqual([]);
});

test("filters settings without mistaking disabled server or availability for tool settings", () => {
  const catalog = state();
  const untouched = structuredClone(catalog);
  const serverId = catalog.servers[0]?.id ?? "";
  const enabled = filterMcpCatalog(catalog, { query: "", serverId, tools: "enabled" });
  expect(enabled[0]?.tools).toHaveLength(50);
  expect(enabled[0]?.server.enabled).toBe(false);
  expect(enabled[0]?.tools.every((item) => item.availability === "unavailable")).toBe(true);
  expect(
    filterMcpCatalog(catalog, { query: "", serverId, tools: "disabled" })[0]?.tools,
  ).toHaveLength(50);
  expect(
    filterMcpCatalog(catalog, { query: "", serverId, tools: "read_only" })[0]?.tools,
  ).toHaveLength(34);
  expect(filterMcpCatalog(catalog, { query: "screenshot", serverId, tools: "enabled" })).toEqual(
    [],
  );
  expect(catalog).toEqual(untouched);
});

test("fresh catalog revision removes old matches; empty and unknown servers remain explicit", () => {
  const catalog = state();
  catalog.catalog_revision = "revision-two";
  catalog.servers[0]?.tools.splice(73, 1);
  expect(filterMcpCatalog(catalog, { query: "screenshot", serverId: "", tools: "all" })).toEqual(
    [],
  );
  expect(filterMcpCatalog(catalog, { query: "", serverId: "unknown", tools: "all" })).toEqual([]);
  const first = catalog.servers[0];
  if (!first) throw new Error("Missing fixture server");
  first.tools = [];
  expect(
    filterMcpCatalog(catalog, { query: "瀏覽器", serverId: "", tools: "all" })[0]?.tools,
  ).toEqual([]);
  expect(filterMcpCatalog(catalog, { query: "瀏覽器", serverId: "", tools: "enabled" })).toEqual(
    [],
  );
});
