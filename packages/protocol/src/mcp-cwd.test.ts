import { expect, test } from "bun:test";
import {
  isAbsoluteMcpCwd,
  isRelativeMcpCommand,
  MCP_COMMAND_RELATIVE_MESSAGE,
  MCP_CWD_INVALID_MESSAGE,
  McpMountConfigSchema,
  McpPanelInputSchema,
  mcpStdioCwdProblem,
} from "./mcp-host.ts";

test("a stdio working directory must be absolute in a Windows, UNC or POSIX form", () => {
  for (const value of [
    "C:\\Users\\me\\project",
    "c:/Users/me/project",
    "\\\\server\\share\\project",
    "/home/me/project",
    "/",
  ])
    expect(isAbsoluteMcpCwd(value)).toBe(true);
  for (const value of [
    "",
    "project",
    "./project",
    "../project",
    "~/project",
    "C:project",
    "\\project",
    "\\\\",
    " /home/me/project",
  ])
    expect(isAbsoluteMcpCwd(value)).toBe(false);
});

test("a new stdio mount refuses a relative working directory while stored ones stay readable", () => {
  const add = { action: "add_stdio", name: "服務", command: "npx" };
  const relative = McpPanelInputSchema.safeParse({ ...add, cwd: "project" });
  expect(relative.success).toBe(false);
  expect(relative.error?.issues).toEqual([
    expect.objectContaining({ path: ["cwd"], message: MCP_CWD_INVALID_MESSAGE }),
  ]);
  for (const cwd of ["C:\\work", "/srv/work", "\\\\server\\share"])
    expect(McpPanelInputSchema.safeParse({ ...add, cwd }).success).toBe(true);
  expect(McpPanelInputSchema.safeParse(add).success).toBe(true);
  // A legacy configuration still loads; the Host marks only that mount unavailable.
  expect(
    McpMountConfigSchema.safeParse({
      id: "00000000-0000-4000-8000-000000000001",
      name: "舊設定",
      transport: { kind: "stdio", command: "npx", cwd: "project" },
    }).success,
  ).toBe(true);
});

test("a relative command path needs an absolute working directory; a bare name does not", () => {
  for (const command of ["./start-mcp.sh", "bin/server", "..\\server.exe", "bin\\server.cmd"])
    expect(isRelativeMcpCommand(command)).toBe(true);
  for (const command of ["npx", "npx.cmd", "/usr/bin/node", "C:\\nodejs\\node.exe", "\\\\srv\\x"])
    expect(isRelativeMcpCommand(command)).toBe(false);
  expect(mcpStdioCwdProblem("./start-mcp.sh", undefined)).toBe(MCP_COMMAND_RELATIVE_MESSAGE);
  expect(mcpStdioCwdProblem("./start-mcp.sh", "/srv/work")).toBeUndefined();
  expect(mcpStdioCwdProblem("./start-mcp.sh", "project")).toBe(MCP_CWD_INVALID_MESSAGE);
  expect(mcpStdioCwdProblem("npx", undefined)).toBeUndefined();
  const add = { action: "add_stdio", name: "服務", command: "./start-mcp.sh" };
  const relative = McpPanelInputSchema.safeParse(add);
  expect(relative.success).toBe(false);
  expect(relative.error?.issues).toEqual([
    expect.objectContaining({ path: ["cwd"], message: MCP_COMMAND_RELATIVE_MESSAGE }),
  ]);
  expect(McpPanelInputSchema.safeParse({ ...add, cwd: "C:\\work" }).success).toBe(true);
  // Stored configurations stay readable; the Host marks only that mount unavailable.
  expect(
    McpMountConfigSchema.safeParse({
      id: "00000000-0000-4000-8000-000000000001",
      name: "舊設定",
      transport: { kind: "stdio", command: "./start-mcp.sh" },
    }).success,
  ).toBe(true);
});
