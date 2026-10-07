import { expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "../../../tests/fixtures.ts";

const entry = fileURLToPath(new URL("./main.ts", import.meta.url));

test("mcp add-stdio saves a relative --cwd resolved from the shell's folder", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.directory, "relative-folder"));
    const command = path.join(f.directory, "never-created-synthetic-mcp");
    const child = Bun.spawn(
      [
        process.execPath,
        entry,
        "mcp",
        "add-stdio",
        "相對資料夾",
        "--command",
        command,
        "--cwd",
        "relative-folder",
        "--data-dir",
        f.state,
      ],
      { cwd: f.directory, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const saved = JSON.parse(await readFile(path.join(f.state, "mcp-servers.json"), "utf8"));
    expect(saved.servers[0].transport.cwd).toBe(path.join(f.directory, "relative-folder"));
    // The folder exists, so the only failure left is the missing synthetic program.
    expect(JSON.parse(stdout)).toMatchObject({ state: "unavailable", message: "找不到啟動程式。" });
  } finally {
    await f.dispose();
  }
}, 20_000);
