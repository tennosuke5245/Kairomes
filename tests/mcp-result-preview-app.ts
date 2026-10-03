import { type McpCall, McpCallSchema } from "../packages/protocol/src/index.ts";

type Theme = "light" | "dark";
type Result = {
  structuredContent: McpCall;
  isError: boolean;
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" }
  >;
};

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";

/** Preview-only SDK boundary: no transport, host, timers, credentials or external resources. */
export class App {
  ontoolresult: ((result: Result) => void) | undefined;
  onhostcontextchanged: ((context: { theme?: Theme }) => void) | undefined;

  // biome-ignore lint/complexity/noUselessConstructor: Preserve the SDK constructor shape for the preview replacement.
  constructor(_info: { name: string; version: string }, _capabilities: Record<string, unknown>) {}

  async connect(_transport?: unknown, _options?: unknown) {
    const query = new URLSearchParams(location.search);
    const error = query.get("case") === "error" || query.get("error") === "1";
    const text = error ? "合成工具回報錯誤。" : "合成工具結果。";
    const call = McpCallSchema.parse({
      kind: "mcp_call",
      request_id: "00000005-0000-4000-8000-000000000010",
      catalog_revision: "synthetic-preview",
      tool: {
        ref: "synthetic:preview",
        server_id: "00000006-0000-4000-8000-000000000010",
        server_name: "合成 MCP",
        name: "synthetic_preview",
        title: "合成成果",
      },
      is_error: error,
      arguments_preview: { input: "合成資料" },
      duration_ms: 23,
      content: [
        { type: "text", text },
        {
          type: "image",
          media_id: "00000007-0000-4000-8000-000000000010",
          mime_type: "image/png",
          byte_length: atob(png).length,
          width: 1,
          height: 1,
        },
      ],
      truncated: error || query.get("truncated") === "1",
    });
    this.ontoolresult?.({
      structuredContent: call,
      isError: error,
      content: [
        { type: "text", text },
        { type: "image", data: png, mimeType: "image/png" },
      ],
    });
  }

  getHostContext(): { theme?: Theme } {
    return {};
  }
}

export function applyDocumentTheme(_theme: Theme) {
  // CSS branch selection belongs to the preview page; this adapter supplies no host theme.
}
