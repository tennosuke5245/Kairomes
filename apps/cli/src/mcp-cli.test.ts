import { expect, test } from "bun:test";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "../../../tests/fixtures.ts";

const entry = fileURLToPath(new URL("./main.ts", import.meta.url));

async function addStdio(cwd: string, state: string, ...options: string[]) {
  const child = Bun.spawn(
    [process.execPath, entry, "mcp", "add-stdio", "合成服務", ...options, "--data-dir", state],
    { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("mcp add-stdio refuses relative paths instead of guessing the shell's folder", async () => {
  // Under `bun run kairomes` this process runs in the Kairomes folder, not the shell's.
  const f = await fixture();
  try {
    await mkdir(path.join(f.directory, "relative-folder"));
    const command = path.join(f.directory, "never-created-synthetic-mcp");
    const cwd = await addStdio(
      f.directory,
      f.state,
      "--command",
      command,
      "--cwd",
      "relative-folder",
    );
    expect(cwd.code).toBe(1);
    expect(cwd.stderr).toStartWith("MCP_CWD_INVALID: 工作目錄須為絕對路徑。");
    const relative = await addStdio(f.directory, f.state, "--command", "./start-mcp.sh");
    expect(relative.code).toBe(1);
    expect(relative.stderr).toStartWith(
      "MCP_COMMAND_RELATIVE: 啟動程式為相對路徑時，須填寫絕對路徑的工作目錄。",
    );
    for (const { stdout, stderr } of [cwd, relative]) {
      expect(stdout).toBe("");
      expect(stderr).not.toContain(f.directory);
    }
    await expect(access(path.join(f.state, "mcp-servers.json"))).rejects.toThrow();
  } finally {
    await f.dispose();
  }
}, 20_000);

test("mcp add-stdio saves an absolute --cwd as given", async () => {
  const f = await fixture();
  try {
    const folder = path.join(f.directory, "absolute-folder");
    await mkdir(folder);
    const command = path.join(f.directory, "never-created-synthetic-mcp");
    const { code, stdout, stderr } = await addStdio(
      f.root,
      f.state,
      "--command",
      command,
      "--cwd",
      folder,
    );
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const saved = JSON.parse(await readFile(path.join(f.state, "mcp-servers.json"), "utf8"));
    expect(saved.servers[0].transport.cwd).toBe(folder);
    // The folder exists, so the only failure left is the missing synthetic program, never the folder.
    const mount = JSON.parse(stdout) as { state: string; message: string };
    expect(mount.state).toBe("unavailable");
    expect(mount.message).not.toBe("工作目錄不存在或不是資料夾。");
    expect(mount.message).not.toBe("工作目錄設定需改為絕對路徑。");
    // Windows launches commands through cmd.exe, so a missing program exits instead of failing
    // to spawn and is reported as a generic connection failure there.
    if (process.platform !== "win32") expect(mount.message).toBe("找不到啟動程式。");
  } finally {
    await f.dispose();
  }
}, 20_000);
