import { expect, test } from "bun:test";
import {
  isAbsoluteMcpCwd,
  MCP_CWD_INVALID_MESSAGE,
  McpMountConfigSchema,
  McpPanelInputSchema,
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
