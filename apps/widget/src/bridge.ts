import {
  type ActivityConnection,
  type ActivitySnapshot,
  type Artifact,
  readSnapshots,
  type ToolData,
  ToolDataSchema,
  type ToolName,
  VERSION,
} from "@kairomes/protocol";
import { App } from "@modelcontextprotocol/ext-apps";
import { decodeResult } from "./tool-result.ts";

export interface WorkbenchBridge {
  mode: "preview" | "host" | "workbench";
  activity?: ActivityConnection;
  loadArtifact?(artifact: Artifact): Promise<string>;
  loadMcpMedia?(mediaId: string): Promise<string>;
  connect(onResult: (data: ToolData) => void): Promise<void>;
  call(name: ToolName, args?: Record<string, unknown>): Promise<ToolData>;
  fullscreen(): Promise<void>;
  sendMessage(message: string): Promise<void>;
  updateModelContext?(text: string, structuredContent?: Record<string, unknown>): Promise<boolean>;
  askAbout(workspaceId: string, filePath: string): Promise<void>;
  close(): Promise<void>;
}

export function createBridge(): WorkbenchBridge {
  const mode = document.querySelector('meta[name="kairomes-mode"]')?.getAttribute("content");
  if (mode === "preview" || mode === "workbench") {
    const session = new URLSearchParams(location.hash.slice(1)).get("session") ?? "";
    if (session) history.replaceState(null, "", location.pathname);
    return {
      mode,
      activity:
        mode === "workbench"
          ? {
              async watch(receive, signal) {
                const response = await fetch("/api/activity/stream", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${session}`,
                  },
                  body: "{}",
                  signal,
                });
                await readSnapshots<ActivitySnapshot>(response, receive, signal);
              },
              async result(id) {
                const response = await fetch("/api/activity/result", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${session}`,
                  },
                  body: JSON.stringify({ id }),
                  signal: AbortSignal.timeout(5000),
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.message ?? "操作內容已無法取得。");
                return ToolDataSchema.parse(data);
              },
            }
          : undefined,
      async connect() {
        if (!session) throw new Error("請使用終端機輸出的完整預覽網址開啟本頁。");
      },
      async call(name, args = {}) {
        const response = await fetch("/api/tools", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
          body: JSON.stringify({ name, arguments: args }),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? "預覽工作階段已失效，請重新開啟終端機中的網址。"
              : "無法連線至本機服務。",
          );
        return decodeResult(await response.json());
      },
      async loadArtifact(artifact) {
        const response = await fetch("/api/artifacts/content", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
          body: JSON.stringify({
            workspace_id: artifact.workspace_id,
            path: artifact.path,
            version: artifact.version,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          let message = "無法載入圖片預覽。";
          try {
            message = (await response.json()).message ?? message;
          } catch {
            /* Keep the safe fallback. */
          }
          throw new Error(message);
        }
        return URL.createObjectURL(await response.blob());
      },
      async loadMcpMedia(mediaId) {
        const response = await fetch("/api/mcp/media", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
          body: JSON.stringify({ media_id: mediaId }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          let message = "無法載入 MCP 圖片。";
          try {
            message = (await response.json()).message ?? message;
          } catch {
            /* Keep the safe fallback. */
          }
          throw new Error(message);
        }
        return URL.createObjectURL(await response.blob());
      },
      async fullscreen() {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      },
      async sendMessage() {
        throw new Error("本機預覽不會連線到 ChatGPT；請在 ChatGPT 中開啟工作台後再送出訊息。");
      },
      async updateModelContext() {
        return false;
      },
      async askAbout() {
        throw new Error("請在 ChatGPT 中開啟工作台後使用此功能。");
      },
      async close() {},
    };
  }
  const app = new App({ name: "Kairomes Workbench", version: VERSION }, {});
  const setTheme = (theme?: string) => {
    if (theme) document.documentElement.dataset.theme = theme;
  };
  const sendMessage = async (message: string) => {
    const text = message.trim();
    if (!text) throw new Error("請先輸入要交給 ChatGPT 的訊息。");
    if (!app.getHostCapabilities()?.message?.text)
      throw new Error("此宿主不支援從工作台傳送文字，請使用原生對話輸入框。");
    const result = await app.sendMessage(
      {
        role: "user",
        content: [{ type: "text", text }],
      },
      { timeout: 10000 },
    );
    if (result.isError) throw new Error("宿主未接受訊息，草稿已保留。");
  };
  return {
    mode: "host",
    async connect(onResult) {
      app.ontoolresult = (result) => {
        if (result.isError) return;
        const parsed = ToolDataSchema.safeParse(result.structuredContent);
        if (parsed.success) onResult(parsed.data);
      };
      app.onhostcontextchanged = (context) => setTheme(context.theme);
      await app.connect(undefined, { timeout: 10000 });
      setTheme(app.getHostContext()?.theme);
    },
    async call(name, args = {}) {
      return decodeResult(await app.callServerTool({ name, arguments: args }, { timeout: 10000 }));
    },
    async fullscreen() {
      await app.requestDisplayMode({ mode: "fullscreen" });
    },
    sendMessage,
    async updateModelContext(text, structuredContent) {
      if (!app.getHostCapabilities()?.updateModelContext?.text) return false;
      await app.updateModelContext(
        {
          content: [{ type: "text", text }],
          ...(structuredContent ? { structuredContent } : {}),
        },
        { timeout: 10000 },
      );
      return true;
    },
    async askAbout(workspaceId, filePath) {
      await sendMessage(
        `請使用 Kairomes file_read 閱讀並說明這個檔案。workspace_id=${JSON.stringify(workspaceId)}，path=${JSON.stringify(filePath)}。`,
      );
    },
    async close() {
      await app.close();
    },
  };
}
