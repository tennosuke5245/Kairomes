type Diagnostic = { category: "connection" | "tools" | "auth"; message: string };

const reasons: Record<string, Diagnostic> = {
  connection_failed: { category: "connection", message: "MCP 初始化未完成。" },
  connection_timeout: { category: "connection", message: "MCP 初始化逾時。" },
  connection_response_invalid: { category: "connection", message: "初始化回覆格式無效。" },
  connection_response_limit: { category: "connection", message: "初始化回覆超過大小限制。" },
  connection_network_blocked: {
    category: "connection",
    message: "初始化位址不符合網路安全限制。",
  },
  connection_network_failed: { category: "connection", message: "初始化網路請求失敗。" },
  connection_rejected: { category: "connection", message: "服務未接受初始化要求。" },
  tools_list_failed: { category: "tools", message: "主機未取得有效工具清單。" },
  tools_list_timeout: { category: "tools", message: "工具清單請求逾時。" },
  tools_list_response_invalid: { category: "tools", message: "工具清單回覆格式無效。" },
  tools_list_response_limit: { category: "tools", message: "工具清單回覆超過大小限制。" },
  tools_list_network_blocked: {
    category: "tools",
    message: "工具清單位址不符合網路安全限制。",
  },
  tools_list_network_failed: { category: "tools", message: "工具清單網路請求失敗。" },
  tools_list_rejected: { category: "tools", message: "服務未接受工具清單要求。" },
  tools_limit: { category: "tools", message: "工具數量超過 128 個上限。" },
  schema_limit: { category: "tools", message: "工具定義超過 64 KiB 上限。" },
  tools_invalid: { category: "tools", message: "工具名稱無效或重複。" },
  invalid_callback: { category: "auth", message: "回呼未通過驗證。" },
  network_blocked: { category: "auth", message: "服務位址不符合網路安全限制。" },
  auth_unsupported: { category: "auth", message: "服務未提供支援的註冊方式。" },
};
const httpStatuses = new Set([
  "400",
  "401",
  "403",
  "404",
  "405",
  "429",
  "500",
  "502",
  "503",
  "504",
]);

/** Only fixed Host classifications are rendered; arbitrary remote errors never become copy. */
export function mcpAuthDiagnostic(code?: string): Diagnostic | undefined {
  if (!code) return;
  if (Object.hasOwn(reasons, code)) return reasons[code];
  const http = /^(connection|tools_list)_http_(\d{3})$/.exec(code);
  const status = http?.[2];
  if (!status || !httpStatuses.has(status)) return;
  return http?.[1] === "connection"
    ? { category: "connection", message: `初始化回覆 HTTP ${status}。` }
    : { category: "tools", message: `工具清單回覆 HTTP ${status}。` };
}
