import type { WireDesktopSnapshot } from "../apps/desktop/src/model.ts";
import { HandoffInputSchema } from "../packages/protocol/src/handoff.ts";
import { VERSION } from "../packages/protocol/src/index.ts";
import { createHandoffStudyApi } from "./handoff-study-api.ts";
import { HANDOFF_STUDY_WORKSPACE } from "./handoff-study-materials.ts";

type Mode = "ready" | "unmounted" | "offline" | "poll-error";
type Probe = { mode: Mode; cancelCount: number; activeDrafts: number; statusReads: number };
const workspace = {
  ...HANDOFF_STUDY_WORKSPACE,
  capabilities: [...HANDOFF_STUDY_WORKSPACE.capabilities],
};

/** In-memory invoke replacement only. No fetch, file, process, reader or credential APIs. */
export function createDesktopHandoffApi() {
  const handoff = createHandoffStudyApi("alpha");
  let mode: Mode = "ready";
  let cancelCount = 0;
  let statusReads = 0;
  const listeners = new Set<(probe: Probe) => void>();
  const probe = (): Probe => ({
    mode,
    cancelCount,
    activeDrafts: handoff.getStudyState().activeDrafts,
    statusReads,
  });
  const report = () => {
    for (const listener of listeners) listener(probe());
  };
  // Shaped like an older Companion on purpose: the API layer fills the newer fields.
  const snapshot = (): WireDesktopSnapshot => ({
    credentialConfigured: false,
    tunnelClientInstalled: false,
    runtime: { state: "running", owned: false, message: "純合成本機狀態" },
    companion: {
      version: VERSION,
      overall: { tone: "warn", label: "合成測試" },
      workspaces: mode === "unmounted" ? [] : [workspace],
      workbench: {
        state: mode === "offline" ? "error" : "running",
        label: mode === "offline" ? "離線" : "執行中",
        message: "純合成工作台，沒有真實連線",
        meta: "",
      },
      tunnel: { state: "stopped", label: "未啟動", message: "", meta: "", logs: [] },
      connector: { state: "waiting", label: "未連線", message: "", meta: "" },
      extension: { configured: false },
    },
  });
  return {
    subscribe(listener: (probe: Probe) => void) {
      listeners.add(listener);
      listener(probe());
      return () => listeners.delete(listener);
    },
    setMode(next: Mode) {
      mode = next;
      report();
    },
    async invoke(command: string, args?: unknown): Promise<unknown> {
      if (command === "get_desktop_status") {
        statusReads++;
        report();
        if (mode === "poll-error") throw "合成本機狀態回應失敗。";
        return structuredClone(snapshot());
      }
      if (command !== "handoff_request") throw new Error("此合成頁未提供這項原生操作。");
      if (!args || typeof args !== "object" || Object.keys(args).join() !== "input")
        throw new Error("合成 IPC 格式不正確。");
      const parsed = HandoffInputSchema.safeParse((args as { input: unknown }).input);
      if (!parsed.success) throw new Error("合成 IPC 格式不正確。");
      const input = parsed.data;
      // Cleanup remains available after mode changes, just as the trusted route does.
      if (input.action === "cancel") cancelCount++;
      else if (mode !== "ready") throw new Error("合成工作台目前無法核對。");
      try {
        return await handoff.request("handoff_request", input);
      } finally {
        report();
      }
    },
  };
}
