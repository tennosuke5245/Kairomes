import type { WorkbenchBridge } from "../apps/widget/src/bridge.ts";
import {
  type FileResult,
  type Snapshot,
  type ToolData,
  VERSION,
  type Workspace,
} from "../packages/protocol/src/index.ts";

// In-memory callback adapter only: no SDK connection, filesystem, process or credentials.
const workspace: Workspace = {
  id: "00000000-0000-4000-8000-000000000010",
  name: "宿主順序合成專案",
  capabilities: ["read"],
};
const snapshot: Snapshot = {
  kind: "snapshot",
  workspace,
  path: "",
  entries: [{ name: "A.txt", path: "A.txt", kind: "file" }],
  truncated: false,
};
const file = (path: string, content: string): FileResult => ({
  kind: "file",
  workspace_id: workspace.id,
  path,
  content,
  version: (path === "A.txt" ? "1" : "2").repeat(64),
  start_line: 1,
  total_lines: 1,
  next_line: null,
  truncated: false,
  redacted: false,
});

export function createBridge(): WorkbenchBridge {
  let closed = false;
  let receive: ((data: ToolData) => void) | undefined;
  let release: (() => void) | undefined;
  let cancel: (() => void) | undefined;
  const probe = document.querySelector<HTMLOutputElement>("#host-viewer-probe");
  const delayed = (data: ToolData) => {
    if (release) throw new Error("合成讀取已在等待。");
    if (probe) probe.textContent = `等待 ${data.kind}`;
    return new Promise<ToolData>((resolve, reject) => {
      const finish = (aborted: boolean) => {
        clearTimeout(timer);
        release = cancel = undefined;
        if (probe) probe.textContent = aborted ? "已結束" : `已回覆 ${data.kind}`;
        if (aborted) reject(new Error("合成讀取已結束。"));
        else resolve(data);
      };
      const timer = setTimeout(() => finish(true), 30000);
      release = () => finish(false);
      cancel = () => finish(true);
    });
  };
  const controls: Record<string, () => void> = {
    "host-viewer-file": () => receive?.(file("B.txt", "宿主結果 B")),
    "host-viewer-catalog": () =>
      receive?.({
        kind: "mcp_catalog",
        catalog_revision: "synthetic-catalog-update",
        servers: [],
        tools: [],
        truncated: false,
      }),
    "host-viewer-release": () => release?.(),
  };
  for (const [id, action] of Object.entries(controls)) {
    const button = document.getElementById(id);
    if (button) button.onclick = () => !closed && action();
  }
  const close = () => {
    closed = true;
    receive = undefined;
    cancel?.();
  };
  window.addEventListener("pagehide", close, { once: true });
  return {
    mode: "host",
    async connect(onResult) {
      receive = onResult;
    },
    async call(name, args = {}) {
      if (closed) throw new Error("合成測試已結束。");
      if (name === "workspace_list") return { kind: "workspaces", workspaces: [workspace] };
      if (name === "workspace_snapshot") return structuredClone(snapshot);
      if (name === "file_read") return delayed(file("A.txt", "舊讀取 A"));
      if (name === "file_search")
        return delayed({
          kind: "search",
          workspace_id: workspace.id,
          query: String(args.query ?? ""),
          matches: [{ path: "A.txt", line: 1, text: "舊搜尋 A" }],
          truncated: false,
          scanned_files: 1,
          skipped_files: 0,
        });
      if (name === "mcp_catalog_search")
        return {
          kind: "mcp_catalog",
          catalog_revision: "synthetic",
          servers: [],
          tools: [],
          truncated: false,
        };
      if (name === "kairomes_status")
        return {
          kind: "status",
          version: VERSION,
          runtime: "synthetic",
          platform: "win32",
          mounted_workspaces: 1,
          widget_available: true,
          capabilities: {
            read: true,
            write: false,
            terminal: false,
            command: false,
            mcp_mount: true,
            artifact: true,
          },
        };
      throw new Error("合成測試不提供此操作。");
    },
    async fullscreen() {},
    async updateModelContext() {
      return true;
    },
    async sendMessage() {
      throw new Error("合成測試沒有聊天宿主。");
    },
    async askAbout() {
      throw new Error("合成測試沒有聊天宿主。");
    },
    async close() {
      close();
      window.removeEventListener("pagehide", close);
    },
  };
}
