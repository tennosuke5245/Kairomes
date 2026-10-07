import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "../../../tests/fixtures.ts";
import { McpHostManager } from "./mcp-host.ts";
import {
  isAbsoluteLaunchPath,
  launchPathProblem,
  MCP_RUNTIME_DIRECTORY,
  sanitizeLaunchPath,
} from "./mcp-launch.ts";

const fixturePath = fileURLToPath(new URL("./__fixtures__/read-mcp.ts", import.meta.url));
type LaunchReport = { cwd: string; path: string | null };

/** Launch-context variables a test may set; `bun run check` itself sets the runner ones. */
const launchKeys = [
  "PATH",
  "TMPDIR",
  "npm_lifecycle_event",
  "INIT_CWD",
  "npm_config_local_prefix",
  "npm_package_json",
] as const;
const runnerKeys = launchKeys.slice(2);

let f: Awaited<ReturnType<typeof fixture>>;
let managers: McpHostManager[];
let originalCwd: string;
let originalEnv: Record<string, string | undefined>;
let originalPath: string | undefined;

beforeEach(async () => {
  f = await fixture();
  managers = [];
  originalCwd = process.cwd();
  originalEnv = Object.fromEntries(launchKeys.map((key) => [key, process.env[key]]));
  originalPath = process.env.PATH;
});

afterEach(async () => {
  process.chdir(originalCwd);
  for (const key of launchKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(managers.map((manager) => manager.close()));
  await f.dispose();
});

/** Bun's node shim lives in a fixed /tmp on POSIX; on Windows in the temp folder. */
const bunShim = () =>
  process.platform === "win32"
    ? path.join(tmpdir(), "bun-node-0123abcd")
    : "/tmp/bun-node-0123abcd";

function manager() {
  const created = new McpHostManager(f.state);
  managers.push(created);
  return created;
}

/** Mounts the read fixture, which writes the cwd and PATH it was started with to a report file. */
async function launch(cwd?: string) {
  const host = manager();
  const reportFile = path.join(f.directory, `launch-${crypto.randomUUID()}.json`);
  const config = await host.addStdio({
    name: "啟動位置",
    command: process.execPath,
    args: [fixturePath, "--report", reportFile],
    ...(cwd ? { cwd } : {}),
  });
  await host.refresh(config.id);
  const server = (await host.panelState()).servers.find((item) => item.id === config.id);
  const catalog = await host.catalog({
    query: "",
    server_id: config.id,
    limit: 30,
    refresh: false,
  });
  const report = await readFile(reportFile, "utf8").then(
    (text) => JSON.parse(text) as LaunchReport,
    () => undefined,
  );
  return { host, config, server, catalog, report, reportFile };
}

const linux = { tmpdir: "/tmp", platform: "linux" as const };
/** What `bun run start` leaves behind when typed in /home/me/project/sub. */
const bunRun = {
  npm_lifecycle_event: "start",
  npm_config_local_prefix: "/home/me/project/sub",
  npm_package_json: "/home/me/project/package.json",
};

describe("launch PATH", () => {
  test("after a package runner, drops its node_modules/.bin chain and Bun's node shim, keeping order", () => {
    const context = { ...linux, cwd: "/home/me/project", env: bunRun };
    const removed = [
      "/home/me/project/sub/node_modules/.bin",
      "/home/me/project/node_modules/.bin/",
      "/home/me/node_modules/.bin",
      "/node_modules/.bin",
      "/home/me/project//node_modules/.bin",
      "/tmp/bun-node-744846f84",
      "/tmp/bun-node",
      // Bun also puts the package root itself first when started from a subfolder.
      "/home/me/project/",
    ];
    const kept = [
      "/usr/local/bin",
      "/home/me/tools/node_modules/.bin",
      "/home/me/project/sub/child/node_modules/.bin",
      "/home/me/proj/node_modules/.bin",
      "/home/me/project/node_modules/.bin/extra",
      "/tmp/nested/bun-node-744846f84",
      "/var/tmp/bun-node-744846f84",
      "/tmp/bun-nodes",
      "node_modules/.bin",
      "",
      "/home/me/project/sub",
      "/opt/node22/bin",
    ];
    const value = [
      removed[7],
      removed[0],
      kept[0],
      kept[1],
      removed[1],
      kept[2],
      removed[2],
      kept[3],
      kept[4],
      removed[3],
      kept[5],
      removed[4],
      kept[6],
      removed[5],
      kept[7],
      removed[6],
      kept[8],
      kept[9],
      kept[10],
      kept[11],
    ].join(":");
    expect(sanitizeLaunchPath(value, context)).toBe(kept.join(":"));
    expect(sanitizeLaunchPath("", context)).toBe("");
    expect(sanitizeLaunchPath("/usr/bin", { ...context, cwd: "/" })).toBe("/usr/bin");
    expect(
      sanitizeLaunchPath("/node_modules/.bin:/usr/bin", {
        ...context,
        cwd: "/",
        env: { npm_lifecycle_event: "start" },
      }),
    ).toBe("/usr/bin");
    // A removed Host folder still leaves the runner's own folders to go by.
    expect(
      sanitizeLaunchPath(
        "/home/me/project/node_modules/.bin:/tmp/bun-node-744846f84:/srv/node_modules/.bin",
        { ...context, cwd: undefined },
      ),
    ).toBe("/srv/node_modules/.bin");
  });

  test("npm scripts name the shell's folder in INIT_CWD and keep their node-gyp folder", () => {
    const context = {
      ...linux,
      cwd: "/r",
      env: {
        npm_lifecycle_event: "start",
        INIT_CWD: "/r/docs",
        npm_config_local_prefix: "/r",
        npm_package_json: "/r/package.json",
      },
    };
    const gyp = "/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin";
    expect(
      sanitizeLaunchPath(
        [
          "/r/node_modules/.bin",
          "/node_modules/.bin",
          gyp,
          "/home/me/node_modules/.bin",
          "/usr/bin",
        ].join(":"),
        context,
      ),
    ).toBe([gyp, "/home/me/node_modules/.bin", "/usr/bin"].join(":"));
  });

  test("without a package runner, a node_modules/.bin on PATH is the user's and stays", () => {
    // A desktop launcher or service often starts the Host in the home folder.
    const value = "/home/me/node_modules/.bin:/home/me/project:/tmp/bun-node-744846f84:/usr/bin";
    for (const env of [
      {},
      { npm_lifecycle_event: "" },
      { npm_package_json: "/home/me/project/package.json" },
    ])
      expect(sanitizeLaunchPath(value, { ...linux, cwd: "/home/me", env })).toBe(
        "/home/me/node_modules/.bin:/home/me/project:/usr/bin",
      );
  });

  test("Bun's node shim is found in its fixed folder whatever TMPDIR says", () => {
    // Bun writes /tmp/bun-node-<sha> on Linux and /private/tmp on macOS; os.tmpdir() follows TMPDIR.
    expect(
      sanitizeLaunchPath("/tmp/bun-node-744846f84:/home/me/tmpy/bun-node-1:/usr/bin", {
        cwd: "/home/me",
        env: {},
        tmpdir: "/home/me/tmpy",
        platform: "linux",
      }),
    ).toBe("/usr/bin");
    expect(
      sanitizeLaunchPath(
        "/private/tmp/bun-node-744846f84:/tmp/bun-node-744846f84:/var/folders/ab/xyz/T/bun-node-1:/private/var/tmp/bun-node-1:/usr/bin",
        { cwd: "/Users/me/Kairomes", env: {}, tmpdir: "/var/folders/ab/xyz/T", platform: "darwin" },
      ),
    ).toBe("/private/var/tmp/bun-node-1:/usr/bin");
    // /private/tmp is only Bun's folder on macOS.
    expect(
      sanitizeLaunchPath("/private/tmp/bun-node-744846f84:/usr/bin", {
        cwd: "/srv",
        env: {},
        tmpdir: "/tmp",
        platform: "linux",
      }),
    ).toBe("/private/tmp/bun-node-744846f84:/usr/bin");
  });

  test("handles Windows Path casing, separators, quotes and drives", () => {
    const context = {
      cwd: "C:\\Users\\Me\\Project",
      env: {
        npm_lifecycle_event: "start",
        npm_config_local_prefix: "C:\\Users\\Me\\Project\\src",
        npm_package_json: "C:\\Users\\Me\\Project\\package.json",
      },
      tmpdir: "C:\\Users\\Me\\AppData\\Local\\Temp",
      platform: "win32" as const,
    };
    const value = [
      "c:\\users\\me\\project\\",
      "C:\\Users\\Me\\Project\\src\\node_modules\\.bin",
      "C:\\Windows\\System32",
      "c:\\users\\me\\project\\NODE_MODULES\\.BIN",
      "C:/Users/Me/node_modules/.bin/",
      "C:\\Program Files\\nodejs\\",
      '"C:\\node_modules\\.bin"',
      "D:\\Users\\Me\\Project\\node_modules\\.bin",
      "C:\\Users\\Me\\AppData\\Local\\Temp\\bun-node-744846f84",
      "c:\\users\\me\\appdata\\local\\temp\\BUN-NODE-744846F84\\",
      "C:\\tmp\\bun-node-744846f84",
      "C:\\Users\\Me\\AppData\\Roaming\\npm",
      "C:\\Users\\Me\\Projects\\node_modules\\.bin",
      "%USERPROFILE%\\bin",
    ].join(";");
    const kept = [
      "C:\\Windows\\System32",
      "C:\\Program Files\\nodejs\\",
      "D:\\Users\\Me\\Project\\node_modules\\.bin",
      "C:\\tmp\\bun-node-744846f84",
      "C:\\Users\\Me\\AppData\\Roaming\\npm",
      "C:\\Users\\Me\\Projects\\node_modules\\.bin",
      "%USERPROFILE%\\bin",
    ];
    expect(sanitizeLaunchPath(value, context)).toBe(kept.join(";"));
    expect(
      sanitizeLaunchPath("C:\\Users\\Me\\node_modules\\.bin;C:\\Windows", {
        ...context,
        cwd: "C:\\Users\\Me",
        env: {},
      }),
    ).toBe("C:\\Users\\Me\\node_modules\\.bin;C:\\Windows");
  });
});

test("the Host accepts only its own platform's absolute working directories", () => {
  for (const value of ["/srv/project", "/"])
    expect(isAbsoluteLaunchPath(value, "linux")).toBe(true);
  for (const value of ["project", "./project", "~/project", "C:\\project", "\\\\server\\share"])
    expect(isAbsoluteLaunchPath(value, "linux")).toBe(false);
  for (const value of ["C:\\project", "c:/project", "\\\\server\\share\\project", "//server/share"])
    expect(isAbsoluteLaunchPath(value, "win32")).toBe(true);
  // `\project` and `/project` follow the Host's current drive; `C:project` its drive's folder.
  for (const value of ["project", "\\project", "/project", "C:project", "..\\project"])
    expect(isAbsoluteLaunchPath(value, "win32")).toBe(false);
});

test("a launch never depends on the Host's folder through a relative command path", () => {
  for (const command of ["./start-mcp.sh", "bin/server", "../server"])
    expect(launchPathProblem({ command }, "linux")).toBe("MCP_COMMAND_RELATIVE");
  // A bare name is looked up on PATH; backslashes are ordinary characters on POSIX.
  for (const command of ["npx", "/usr/bin/node", "bin\\server"])
    expect(launchPathProblem({ command }, "linux")).toBeUndefined();
  for (const command of [".\\start.cmd", "bin\\server.exe", "bin/server.exe", "\\nodejs\\node.exe"])
    expect(launchPathProblem({ command }, "win32")).toBe("MCP_COMMAND_RELATIVE");
  for (const command of ["npx.cmd", "C:\\nodejs\\node.exe", "\\\\server\\share\\x.exe"])
    expect(launchPathProblem({ command }, "win32")).toBeUndefined();
  // With an absolute working directory the relative command resolves there.
  expect(
    launchPathProblem({ command: "./start-mcp.sh", cwd: "/srv/work" }, "linux"),
  ).toBeUndefined();
  expect(launchPathProblem({ command: "npx", cwd: "project" }, "linux")).toBe("MCP_CWD_INVALID");
});

describe("stdio launch directory", () => {
  test("a mount without a working directory starts in the data folder, not the Host's project folder", async () => {
    // The field failure: the Host ran in a project subdirectory below a Bun workspace.
    await writeFile(
      path.join(f.directory, "package.json"),
      JSON.stringify({ name: "outer-workspace", private: true, workspaces: ["*"] }),
    );
    await mkdir(path.join(f.directory, "node_modules"));
    process.chdir(path.join(f.root, "src"));
    // `bun run` typed in that subdirectory: it names the shell's folder and the package root.
    for (const key of runnerKeys) delete process.env[key];
    process.env.npm_lifecycle_event = "start";
    process.env.npm_config_local_prefix = path.join(f.root, "src");
    process.env.npm_package_json = path.join(f.directory, "package.json");
    // Bun ignores TMPDIR for its shim; a different temp folder must not hide it.
    if (process.platform !== "win32") process.env.TMPDIR = path.join(f.directory, "other-tmp");
    const kept = [
      path.join(f.directory, "tools", "node_modules", ".bin"),
      path.dirname(process.execPath),
    ];
    process.env.PATH = [
      f.directory,
      path.join(f.root, "src", "node_modules", ".bin"),
      kept[0],
      path.join(f.directory, "node_modules", ".bin"),
      bunShim(),
      kept[1],
    ].join(path.delimiter);
    const { server, report } = await launch();
    const runtime = path.join(f.state, MCP_RUNTIME_DIRECTORY);
    expect(server).toMatchObject({ state: "ready" });
    expect(report).toEqual({ cwd: runtime, path: kept.join(path.delimiter) });
    expect(JSON.parse(await readFile(path.join(runtime, "package.json"), "utf8"))).toEqual({
      name: "kairomes-mcp-runtime",
      private: true,
    });
    if (process.platform !== "win32") expect((await stat(runtime)).mode & 0o777).toBe(0o700);
    const npm = Bun.which("npm", { PATH: originalPath ?? "" });
    if (npm) {
      // npm's upward project search stops at the marker instead of adopting the outer workspace.
      const prefix = Bun.spawnSync([npm, "prefix"], {
        cwd: runtime,
        env: {
          PATH: originalPath ?? "",
          HOME: f.directory,
          npm_config_offline: "true",
          npm_config_update_notifier: "false",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(prefix.stdout.toString().trim()).toBe(runtime);
    }
  }, 20_000);

  test("without a package runner the user's own node_modules/.bin reaches the MCP", async () => {
    // A desktop launcher or service starting the Host in the home folder.
    const home = path.join(f.directory, "home");
    await mkdir(home);
    process.chdir(home);
    for (const key of runnerKeys) delete process.env[key];
    const kept = [path.join(home, "node_modules", ".bin"), path.dirname(process.execPath)];
    process.env.PATH = [kept[0], bunShim(), kept[1]].join(path.delimiter);
    const { server, report } = await launch();
    expect(server).toMatchObject({ state: "ready" });
    expect(report?.path).toBe(kept.join(path.delimiter));
  }, 20_000);

  test("a removed Host folder no longer prevents a stdio MCP from starting", async () => {
    // Windows cannot remove a process's current folder.
    if (process.platform === "win32") return;
    const gone = path.join(f.directory, "removed-launch-folder");
    await mkdir(gone);
    process.chdir(gone);
    await rm(gone, { recursive: true });
    const { server, report } = await launch();
    expect(server).toMatchObject({ state: "ready" });
    expect(report?.cwd).toBe(path.join(f.state, MCP_RUNTIME_DIRECTORY));
  }, 20_000);

  test("an existing package.json in the MCP folder is kept and the folder becomes owner-only", async () => {
    const runtime = path.join(f.state, MCP_RUNTIME_DIRECTORY);
    await mkdir(runtime, { mode: 0o755 });
    const own = '{"name":"user-owned","private":true,"dependencies":{}}\n';
    await writeFile(path.join(runtime, "package.json"), own);
    const { server, report } = await launch();
    expect(server).toMatchObject({ state: "ready" });
    expect(report?.cwd).toBe(runtime);
    expect(await readFile(path.join(runtime, "package.json"), "utf8")).toBe(own);
    if (process.platform !== "win32") expect((await stat(runtime)).mode & 0o777).toBe(0o700);
  }, 20_000);

  test("an absolute working directory is used as given", async () => {
    process.chdir(f.directory);
    const { server, report } = await launch(f.root);
    expect(server).toMatchObject({ state: "ready" });
    expect(report?.cwd).toBe(f.root);
    await expect(access(path.join(f.state, MCP_RUNTIME_DIRECTORY))).rejects.toThrow();
  }, 20_000);

  test("a new mount refuses a relative working directory before saving", async () => {
    const host = manager();
    const relative = ["project", "./project", "../project", "~/project"];
    relative.push(process.platform === "win32" ? "/project" : "C:\\project");
    for (const cwd of relative)
      await expect(
        host.addStdio({ name: "相對路徑", command: "synthetic-program", cwd }),
      ).rejects.toMatchObject({ code: "MCP_CWD_INVALID", message: "工作目錄須為絕對路徑。" });
    expect((await host.panelState()).servers).toEqual([]);
    await expect(access(path.join(f.state, "mcp-servers.json"))).rejects.toThrow();
  });

  test("a new mount refuses a relative command path unless it has a working directory", async () => {
    const host = manager();
    const relative = process.platform === "win32" ? ".\\start-mcp.cmd" : "./start-mcp.sh";
    for (const command of [relative, "bin/server"])
      await expect(host.addStdio({ name: "相對程式", command })).rejects.toMatchObject({
        code: "MCP_COMMAND_RELATIVE",
        message: "啟動程式為相對路徑時，須填寫絕對路徑的工作目錄。",
      });
    expect((await host.panelState()).servers).toEqual([]);
    await expect(access(path.join(f.state, "mcp-servers.json"))).rejects.toThrow();
  });

  test("a stored relative command path is not started from the Host's folder or the MCP folder", async () => {
    // Under the old behaviour ./start-mcp.sh ran from wherever the Host happened to start.
    process.chdir(f.directory);
    const marker = path.join(f.directory, "relative-command-ran");
    const script = path.join(f.directory, "start-mcp.sh");
    await writeFile(script, `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
    const legacy = {
      id: crypto.randomUUID(),
      name: "舊設定",
      enabled: true,
      transport: { kind: "stdio", command: "./start-mcp.sh", args: [], env: [] },
      allowed_read_tools: [],
      disabled_tools: [],
    };
    await writeFile(
      path.join(f.state, "mcp-servers.json"),
      JSON.stringify({ version: 1, servers: [legacy] }),
    );
    const catalog = await manager().catalog({ query: "", limit: 30, refresh: true });
    expect(catalog.servers).toEqual([
      expect.objectContaining({
        id: legacy.id,
        state: "unavailable",
        message: "啟動程式為相對路徑時，須填寫絕對路徑的工作目錄。",
        tool_count: 0,
      }),
    ]);
    expect(JSON.stringify(catalog)).not.toContain(f.directory);
    await expect(access(marker)).rejects.toThrow();
    await expect(access(path.join(f.state, MCP_RUNTIME_DIRECTORY))).rejects.toThrow();
  });

  test("a stored relative working directory is never resolved against the Host's folder", async () => {
    // Under the old behaviour "project" resolved from here to the mounted workspace and started.
    process.chdir(f.directory);
    const reportFile = path.join(f.directory, "legacy-launch.json");
    const legacy = {
      id: crypto.randomUUID(),
      name: "舊設定",
      enabled: true,
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: [fixturePath, "--report", reportFile],
        cwd: "project",
        env: [],
      },
      allowed_read_tools: [],
      disabled_tools: [],
    };
    await writeFile(
      path.join(f.state, "mcp-servers.json"),
      JSON.stringify({ version: 1, servers: [legacy] }),
    );
    const catalog = await manager().catalog({ query: "", limit: 30, refresh: true });
    expect(catalog.servers).toEqual([
      expect.objectContaining({
        id: legacy.id,
        state: "unavailable",
        message: "工作目錄設定需改為絕對路徑。",
        tool_count: 0,
      }),
    ]);
    expect(JSON.stringify(catalog)).not.toContain(f.directory);
    await expect(access(reportFile)).rejects.toThrow();
    await expect(access(path.join(f.state, MCP_RUNTIME_DIRECTORY))).rejects.toThrow();
  });

  test("a missing or non-folder working directory is reported as such, not as a missing program", async () => {
    for (const cwd of [path.join(f.directory, "missing-folder"), path.join(f.root, "README.md")]) {
      const { server, catalog, report } = await launch(cwd);
      expect(server).toMatchObject({
        state: "unavailable",
        message: "工作目錄不存在或不是資料夾。",
        tools: [],
      });
      expect(catalog.servers[0]?.message).toBe("工作目錄不存在或不是資料夾。");
      expect(JSON.stringify(catalog)).not.toContain(f.directory);
      expect(report).toBeUndefined();
    }
  }, 20_000);

  test("an MCP folder that is a file or a link is refused without writing through it", async () => {
    const runtime = path.join(f.state, MCP_RUNTIME_DIRECTORY);
    await writeFile(runtime, "not a folder");
    const file = await launch();
    expect(file.server).toMatchObject({ state: "unavailable", message: "無法準備 MCP 工作目錄。" });
    expect(JSON.stringify(file.catalog)).not.toContain(f.directory);
    expect(file.report).toBeUndefined();
    if (process.platform === "win32") return;
    await rm(runtime);
    await symlink(f.root, runtime);
    const link = await launch();
    expect(link.server).toMatchObject({ state: "unavailable", message: "無法準備 MCP 工作目錄。" });
    expect(link.report).toBeUndefined();
    await expect(access(path.join(f.root, "package.json"))).rejects.toThrow();
  }, 20_000);
});
