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
const bridge = { mode: "workbench" } as WorkbenchBridge;
/** A button with this label that is not disabled. */
const enabledButton = (label: string) =>
  new RegExp(`<button(?![^>]*disabled="")[^>]*>(?:<svg[\\s\\S]*?</svg>)?${label}</button>`);

test("missing history remains selected and readonly even while another shell exists", () => {
  const html = renderToStaticMarkup(
    <TerminalPanel
      bridge={bridge}
      workspaceId={workspaceId}
      cwd=""
      platform="win32"
      visible
      liveSessions={[{ ...session, id: "10000000-0000-4000-8000-000000000003" }]}
      focus={{ id: session.id, seq: 1 }}
    />,
  );
  expect(html).toContain("終端機詳情已無法取得");
  // The other shell is neither shown nor selected in its place.
  expect(html).not.toContain("data-record-id");
  expect(html).not.toContain("可接收輸入");
  expect(html).not.toMatch(enabledButton("新增終端機"));
  expect(html).not.toMatch(enabledButton("停止"));
  expect(html).not.toContain("wb-term-footer");
  expect(html).not.toContain("工作目錄 ·");
});

test("an unmounted workspace cannot offer input operations for a still listed running shell", () => {
  const html = renderToStaticMarkup(
    <TerminalPanel
      bridge={bridge}
      workspaceId={workspaceId}
      cwd=""
      platform="win32"
      visible
      liveSessions={[session]}
      focus={{ id: session.id, seq: 1 }}
      readOnly
    />,
  );
  expect(html).not.toMatch(enabledButton("新增終端機"));
  expect(html).not.toMatch(enabledButton("停止"));
  expect(html).toContain("唯讀");
  expect(html).not.toContain("授權至");
  expect(html).toContain("主機終端機 · 可接收輸入");
  expect(html).not.toContain("HOST PTY");
});

test("the session list replaces the select: shell, state pill and time, never an id", () => {
  const html = renderToStaticMarkup(
    <TerminalPanel
      bridge={bridge}
      workspaceId={workspaceId}
      cwd="packages/app"
      platform="win32"
      visible
      liveSessions={[session]}
    />,
  );
  expect(html).not.toContain('<select aria-label="選擇終端機"');
  expect(html).toContain(`data-record-id="${session.id}"`);
  expect(html).toContain('<span class="k-mono">powershell</span>');
  expect(html).toContain("可接收輸入");
  expect(html).not.toContain(`${session.id.slice(0, 8)}<`);
  // Requesting a shell states the host risk without softening it.
  for (const words of ["主機權限", "可操作工作區外", "可連網", "沒有隔離"])
    expect(html).toContain(words);
  expect(html).toContain("工作目錄 · packages/app");
  expect(html).toMatch(enabledButton("新增終端機"));
  const readOnly = renderToStaticMarkup(
    <TerminalPanel
      bridge={bridge}
      workspaceId={workspaceId}
      cwd=""
      platform="win32"
      visible
      liveSessions={[session]}
      readOnly
    />,
  );
  expect(readOnly).not.toContain("新增終端機");
});
