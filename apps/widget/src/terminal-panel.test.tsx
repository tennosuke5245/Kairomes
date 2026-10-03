import { expect, test } from "bun:test";
import type { TerminalSession } from "@kairomes/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkbenchBridge } from "./bridge.ts";
import { TerminalPanel } from "./terminal-panel.tsx";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const session: TerminalSession = {
  id: "10000000-0000-4000-8000-000000000002",
  workspace_id: workspaceId,
  cwd: "",
  shell: "powershell",
  mode: "host-pty",
  state: "running",
  created_at: 0,
  expires_at: 100,
  cols: 100,
  rows: 28,
  exit_code: null,
};

test("missing history remains selected and readonly even while another shell exists", () => {
  const html = renderToStaticMarkup(
    <TerminalPanel
      bridge={{ mode: "workbench" } as WorkbenchBridge}
      workspaceId={workspaceId}
      cwd=""
      platform="win32"
      visible
      liveSessions={[{ ...session, id: "10000000-0000-4000-8000-000000000003" }]}
      focus={{ id: session.id, seq: 1 }}
    />,
  );
  expect(html).toContain(`value="${session.id}" selected=""`);
  expect(html).toContain("詳情已無法取得");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>新增終端機<\/button>/);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>停止<\/button>/);
  expect(html).not.toContain("terminal-footer");
  expect(html).not.toContain("起始位置");
});

test("an unmounted workspace cannot offer input operations for a still listed running shell", () => {
  const html = renderToStaticMarkup(
    <TerminalPanel
      bridge={{ mode: "workbench" } as WorkbenchBridge}
      workspaceId={workspaceId}
      cwd=""
      platform="win32"
      visible
      liveSessions={[session]}
      focus={{ id: session.id, seq: 1 }}
      readOnly
    />,
  );
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>新增終端機<\/button>/);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>停止<\/button>/);
  expect(html).toContain("唯讀");
  expect(html).not.toContain("授權至");
});
