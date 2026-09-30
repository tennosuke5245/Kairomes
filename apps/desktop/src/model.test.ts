import { expect, test } from "bun:test";
import { type DesktopSnapshot, deriveDesktopView } from "./model.ts";

function snapshot(overrides: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return {
    credentialConfigured: true,
    tunnelClientInstalled: true,
    runtime: { state: "running", owned: true, message: "本機服務正在執行。" },
    companion: {
      version: "0.1.2",
      overall: { tone: "good", label: "已連線" },
      workspaces: [
        {
          id: "2ff7f6d9-a7ee-46e6-b4c4-2e21602056e4",
          name: "Athori",
          capabilities: ["read", "write_request"],
        },
      ],
      workbench: { state: "running", label: "執行中", message: "就緒", meta: "1 個專案" },
      tunnel: {
        state: "running",
        label: "執行中",
        message: "安全通道已連線。",
        meta: "Profile · kairomes",
        logs: [],
      },
      connector: {
        state: "connected",
        label: "最近有連線",
        message: "收到 MCP 請求。",
        meta: "剛剛",
      },
      extension: { configured: true },
    },
    ...overrides,
  };
}

test("desktop view makes the missing credential the single next action", () => {
  const view = deriveDesktopView(snapshot({ credentialConfigured: false }));
  expect(view.action).toBe("configure_key");
  expect(view.tunnelState).toBe("current");
  expect(view.chatgptState).toBe("pending");
});

test("desktop view waits for a real connector request", () => {
  const current = snapshot();
  if (!current.companion) throw new Error("fixture companion missing");
  current.companion.connector.state = "waiting";
  const view = deriveDesktopView(current);
  expect(view.action).toBe("open_connectors");
  expect(view.chatgptState).toBe("current");
});

test("desktop view reports ready only after the connector has been observed", () => {
  const view = deriveDesktopView(snapshot());
  expect(view.tone).toBe("ready");
  expect(view.action).toBe("open_workbench");
  expect(view.chatgptState).toBe("done");
});

test("desktop view makes the first project the next action when none are mounted", () => {
  const current = snapshot();
  if (!current.companion) throw new Error("fixture companion missing");
  current.companion.workspaces = [];
  const view = deriveDesktopView(current);
  expect(view.tone).toBe("focus");
  expect(view.action).toBe("add_workspace");
  expect(view.localState).toBe("current");
});
