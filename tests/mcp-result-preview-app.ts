import { type McpCall, McpCallSchema } from "../packages/protocol/src/index.ts";

type Theme = "light" | "dark";
type Image = { type: "image"; data: string; mimeType: "image/png" };
type Result = {
  structuredContent: McpCall;
  isError: boolean;
  content: Array<{ type: "text"; text: string } | Image>;
};

// A 1 × 1 PNG: the card must enlarge it with crisp pixels, never stretch it to the card width.
const tinyPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==";

/** One crimson pixel, so the enlarged tiny image is visible in the preview. */
function syntheticPixel(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) return tinyPng;
  context.fillStyle = "#b5474b";
  context.fillRect(0, 0, 1, 1);
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

/** A synthetic page capture drawn in the preview itself: shapes only, no real content. */
function syntheticCapture(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext("2d");
  if (!context) return tinyPng;
  const box = (color: string, x: number, y: number, width: number, height: number) => {
    context.fillStyle = color;
    context.fillRect(x, y, width, height);
  };
  box("#f4f1ec", 0, 0, 1280, 720);
  box("#2d3a52", 0, 0, 1280, 100);
  for (const [index, y] of [190, 250, 310].entries())
    box(index ? "#ddd6cb" : "#c9c2b6", 100, y, 590, 36);
  box("#a8b9d8", 820, 190, 360, 316);
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

const structured = {
  title: "合成頁面",
  viewport: { width: 1280, height: 720, scale: 1 },
  cards: [
    { name: "合成專案 A", unread: 0 },
    { name: "合成專案 B", unread: 1, tags: ["合成", "預覽"] },
  ],
  captured: true,
  note: null,
};

/** ?case=error (tool error), ?case=tiny (1 × 1 image); anything else is a normal capture. */
function previewCase(query: URLSearchParams) {
  if (query.get("case") === "error" || query.get("error") === "1") return "error";
  return query.get("case") === "tiny" ? "tiny" : "ok";
}

/** Preview-only SDK boundary: no transport, host, timers, credentials or external resources. */
export class App {
  ontoolresult: ((result: Result) => void) | undefined;
  onhostcontextchanged: ((context: { theme?: Theme }) => void) | undefined;

  // biome-ignore lint/complexity/noUselessConstructor: Preserve the SDK constructor shape for the preview replacement.
  constructor(_info: { name: string; version: string }, _capabilities: Record<string, unknown>) {}

  async connect(_transport?: unknown, _options?: unknown) {
    const query = new URLSearchParams(location.search);
    const kind = previewCase(query);
    const error = kind === "error";
    const text = error
      ? "合成工具回報錯誤：找不到合成分頁 tab-7。\n請先開啟合成分頁，再重新呼叫一次。"
      : "已擷取合成分頁的可見區域。頁面標題為「合成頁面」，主內容包含 2 張合成卡片與 1 個未讀標記；截圖未包含瀏覽器外框。\n\n第二段是較長的合成說明，用來確認卡片會先收合文字、顯示淡出，並提供展開全部與複製文字。\n\n第三段：只含虛構內容。";
    const size = kind === "ok" ? { width: 1280, height: 720 } : { width: 1, height: 1 };
    const images: Image[] = error
      ? []
      : [
          {
            type: "image",
            data: kind === "ok" ? syntheticCapture() : syntheticPixel(),
            mimeType: "image/png",
          },
        ];
    const call = McpCallSchema.parse({
      kind: "mcp_call",
      request_id: "00000005-0000-4000-8000-000000000010",
      catalog_revision: "synthetic-preview",
      tool: {
        ref: "synthetic:preview",
        server_id: "00000006-0000-4000-8000-000000000010",
        server_name: "合成 MCP 伺服器",
        name: error ? "synthetic_select_tab" : "synthetic_capture",
      },
      is_error: error,
      arguments_preview: error
        ? { tab_id: "tab-7" }
        : { tab_id: "tab-1", options: { full_page: false, format: "png" } },
      duration_ms: error ? 23 : 812,
      content: [
        { type: "text", text },
        ...images.map((image) => ({
          type: "image",
          media_id: "00000007-0000-4000-8000-000000000010",
          mime_type: image.mimeType,
          byte_length: atob(image.data).length,
          ...size,
        })),
      ],
      structured_content: error ? { code: "TAB_NOT_FOUND", retryable: true } : structured,
      truncated: query.get("truncated") === "1",
    });
    this.ontoolresult?.({
      structuredContent: call,
      isError: error,
      content: [{ type: "text", text }, ...images],
    });
  }

  getHostContext(): { theme?: Theme } {
    return {};
  }
}

export function applyDocumentTheme(_theme: Theme) {
  // CSS branch selection belongs to the preview page; this adapter supplies no host theme.
}
