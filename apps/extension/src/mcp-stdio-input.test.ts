import { expect, test } from "bun:test";
import { MCP_COMMAND_RELATIVE_MESSAGE, MCP_CWD_INVALID_MESSAGE } from "@kairomes/protocol";
import { mcpPathInput, mcpStdioLaunchInput } from "./mcp-stdio-input.ts";

test("a pasted path loses Windows Explorer's enclosing quotes and nothing else", () => {
  // 複製為路徑 (Ctrl+Shift+C) wraps the path in one pair of double quotes.
  expect(mcpPathInput(' "C:\\Users\\Me\\proj" ')).toBe("C:\\Users\\Me\\proj");
  expect(mcpPathInput('"C:\\Program Files\\nodejs\\node.exe"')).toBe(
    "C:\\Program Files\\nodejs\\node.exe",
  );
  expect(mcpPathInput("  /srv/work  ")).toBe("/srv/work");
  for (const kept of ['"', '"C:\\proj', 'C:\\proj"', "'/srv/work'", 'C:\\"a"'])
    expect(mcpPathInput(kept)).toBe(kept);
  expect(mcpPathInput('""')).toBe("");
});

test("the add form sends unquoted paths and accepts absolute or empty working directories", () => {
  expect(
    mcpStdioLaunchInput('"C:\\Program Files\\nodejs\\npx.cmd"', ' "C:\\Users\\Me\\proj" '),
  ).toEqual({
    command: "C:\\Program Files\\nodejs\\npx.cmd",
    cwd: "C:\\Users\\Me\\proj",
    problem: undefined,
  });
  for (const cwd of ["/srv/work", "\\\\server\\share\\proj", "c:/work"])
    expect(mcpStdioLaunchInput("npx", cwd).problem).toBeUndefined();
  // Left empty (or as an empty quoted paste), the Host starts it in its own MCP folder.
  for (const cwd of ["", "   ", '""'])
    expect(mcpStdioLaunchInput(" npx ", cwd)).toEqual({
      command: "npx",
      cwd: undefined,
      problem: undefined,
    });
});

test("the add form marks the working directory before the Host would refuse it", () => {
  for (const cwd of ["project", "./project", "~/project", '"project"', "C:project"])
    expect(mcpStdioLaunchInput("npx", cwd).problem).toBe(MCP_CWD_INVALID_MESSAGE);
  // A relative command path depends on the folder it starts in, so it needs a working directory.
  for (const command of ["./start-mcp.sh", '"bin\\server.exe"'])
    expect(mcpStdioLaunchInput(command, "").problem).toBe(MCP_COMMAND_RELATIVE_MESSAGE);
  expect(mcpStdioLaunchInput("./start-mcp.sh", '"C:\\work"').problem).toBeUndefined();
  expect(mcpStdioLaunchInput("./start-mcp.sh", "work").problem).toBe(MCP_CWD_INVALID_MESSAGE);
});
