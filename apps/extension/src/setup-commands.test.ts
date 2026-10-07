import { expect, test } from "bun:test";
import { commandTokens, setupCommands } from "./setup-commands.ts";

test("setup commands keep every flag whole and copy back unchanged", () => {
  const commands = setupCommands("abcdefghijklmnopabcdefghijklmnop");
  expect(commandTokens(commands.start)).toEqual([
    "bun.cmd",
    "run",
    "app",
    "--port",
    "0",
    "--extension-id",
    "abcdefghijklmnopabcdefghijklmnop",
  ]);
  expect(commandTokens(commands.tunnel)).toEqual(["tunnel-client", "run", "--profile", "kairomes"]);
  for (const command of Object.values(commands)) {
    const tokens = commandTokens(command);
    expect(tokens.join(" ")).toBe(command);
    // No token is a bare `--`: a flag is never split from its name.
    expect(tokens).not.toContain("--");
  }
});
