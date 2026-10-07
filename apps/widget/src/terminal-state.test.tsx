import { expect, test } from "bun:test";
import type { TerminalResult, TerminalSession } from "@kairomes/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { appendTerminalText, TerminalOutput, terminalOutputEvidence } from "./terminal-output.tsx";
import { currentTerminalSession, terminalSelection } from "./terminal-state.ts";

const running: TerminalSession = {
  id: "10000000-0000-4000-8000-000000000001",
  workspace_id: "10000000-0000-4000-8000-000000000002",
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
const result: TerminalResult = {
  kind: "terminal",
  session: { ...running, state: "exited", exit_code: 0 },
  output: "first",
  text: "first",
  cursor: 5,
  truncated: false,
  has_more: false,
};

test("removing a selected historical shell does not select or enable input for another shell", () => {
  const another = { ...running, id: "10000000-0000-4000-8000-000000000003" };
  const id = terminalSelection([another], running.id);
  expect(id).toBe(running.id);
  expect(
    currentTerminalSession(
      [another].find((item) => item.id === id),
      running,
    ),
  ).toBeUndefined();
  expect(terminalSelection([another], "")).toBe(another.id);
  expect(currentTerminalSession(running, another)).toBe(running);
});

test("a late pending/running poll cannot undo authoritative progress or a stopped shell", () => {
  expect(currentTerminalSession(running, { ...running, state: "pending" })).toBe(running);
  for (const state of ["stopped", "exited", "denied", "expired", "failed"] as const) {
    const final = { ...running, state };
    expect(currentTerminalSession(final, running)).toBe(final);
  }
  expect(currentTerminalSession(running, result.session)?.state).toBe("exited");
});

test("clipping keeps whole lines: the first retained row is never half a line", () => {
  const text = Array.from({ length: 400 }, (_, index) => `第 ${index + 1} 行：純合成終端輸出`).join(
    "\n",
  );
  const kept = appendTerminalText({ text: "", clipped: false }, { ...result, text }, 4000);
  expect(kept.clipped).toBe(true);
  expect(kept.text.length).toBeLessThanOrEqual(4000);
  expect(kept.text.startsWith("第 ")).toBe(true);
  expect(text.endsWith(kept.text)).toBe(true);
  expect(text.split("\n")).toContain(kept.text.split("\n")[0] ?? "");
  // A cut that lands on a line start keeps that line; one long line is cut inside it.
  expect(
    appendTerminalText({ text: "ab\n", clipped: false }, { ...result, text: "cd\nef" }, 5).text,
  ).toBe("cd\nef");
  expect(
    appendTerminalText({ text: "", clipped: false }, { ...result, text: "abcdefgh" }, 3).text,
  ).toBe("fgh");
});

test("terminal preview reports server omissions and local clipping even after later complete pages", () => {
  const clipped = appendTerminalText(
    { text: "older", clipped: false },
    { ...result, truncated: true },
  );
  expect(clipped).toEqual({ text: "first", clipped: true });
  const later = appendTerminalText(clipped, { ...result, text: " last" });
  expect(later.text).toBe("first last");
  expect(terminalOutputEvidence(result, later.clipped)).toBe("輸出部分保留");
  const unicode = appendTerminalText({ text: "a", clipped: false }, { ...result, text: "🐱bc" }, 3);
  expect(unicode.text).toBe("bc");
  expect(unicode.clipped).toBe(true);
  expect(terminalOutputEvidence({ ...result, has_more: true })).toBe("輸出尚未讀完");
  expect(terminalOutputEvidence({ ...result, session: running })).toBe("輸出持續更新");
  expect(terminalOutputEvidence({ ...result, session: { ...running, state: "pending" } })).toBe(
    "尚未執行",
  );
  expect(terminalOutputEvidence(result)).toBe("輸出已讀完");
  expect(terminalOutputEvidence(result, false, true)).toBe("輸出待確認");
  const html = renderToStaticMarkup(<TerminalOutput result={result} clipped />);
  expect(html.match(/輸出部分保留/g)?.length).toBe(1);
  // Numbers counted from a cut would be false, so a clipped tail shows none.
  expect(html).toContain('data-numbers="off"');
  expect(html).not.toMatch(/class="k-output__ln">\d/);
  expect(renderToStaticMarkup(<TerminalOutput result={result} />)).toMatch(
    /class="k-output__ln">1</,
  );
  expect(html).not.toContain("輸出已讀完");
  expect(html).not.toContain("目前版本通過");
});
