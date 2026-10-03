import { expect, test } from "bun:test";
import { mcpAuthDiagnostic } from "./mcp-auth-diagnostic.ts";

test("only fixed diagnostic codes distinguish initialization from tool discovery", () => {
  expect(mcpAuthDiagnostic("connection_timeout")).toEqual({
    category: "connection",
    message: "MCP 初始化逾時。",
  });
  for (const code of [
    "failed",
    "timeout",
    "response_invalid",
    "response_limit",
    "network_blocked",
    "network_failed",
    "rejected",
  ]) {
    expect(mcpAuthDiagnostic(`connection_${code}`)?.category).toBe("connection");
    expect(mcpAuthDiagnostic(`tools_list_${code}`)?.category).toBe("tools");
  }
  expect(mcpAuthDiagnostic("tools_limit")?.message).toBe("工具數量超過 128 個上限。");
  expect(mcpAuthDiagnostic("schema_limit")?.message).toBe("工具定義超過 64 KiB 上限。");
  expect(mcpAuthDiagnostic("tools_invalid")?.message).toBe("工具名稱無效或重複。");
});

test("HTTP diagnostics accept only the fixed status set and do not guess authentication", () => {
  for (const status of [400, 401, 403, 404, 405, 429, 500, 502, 503, 504]) {
    expect(mcpAuthDiagnostic(`connection_http_${status}`)).toEqual({
      category: "connection",
      message: `初始化回覆 HTTP ${status}。`,
    });
    expect(mcpAuthDiagnostic(`tools_list_http_${status}`)).toEqual({
      category: "tools",
      message: `工具清單回覆 HTTP ${status}。`,
    });
  }
});

test("unknown classifications and remote text remain absent from rendered diagnostics", () => {
  for (const code of [
    undefined,
    "unknown_safe_code",
    "connection_http_200",
    "tools_list_http_999",
    "connection_http_403_private",
    "https://synthetic.example.test/?code=synthetic-private",
    "Authorization: synthetic-not-a-token",
    "constructor",
    "__proto__",
  ])
    expect(mcpAuthDiagnostic(code)).toBeUndefined();
});
