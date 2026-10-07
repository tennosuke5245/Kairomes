import { chmod, lstat, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isAbsoluteMcpCwd, KairomesError, MCP_COMMAND_RELATIVE_MESSAGE } from "@kairomes/protocol";

/** Folder in the data directory where a stdio MCP without its own working directory starts. */
export const MCP_RUNTIME_DIRECTORY = "mcp-runtime";
const RUNTIME_MARKER = `${JSON.stringify({ name: "kairomes-mcp-runtime", private: true }, null, 2)}\n`;

export type LaunchContext = {
  /** The Host's own working directory; undefined if it no longer exists. */
  cwd: string | undefined;
  /** The Host's environment, where `bun run` and npm scripts leave their markers and folders. */
  env: Readonly<Record<string, string | undefined>>;
  tmpdir: string;
  platform: NodeJS.Platform;
};

/**
 * Host-side absolute check for a stdio working directory or command. On Windows only a drive
 * (`C:\`) or UNC (`\\server\share`) path qualifies; `\dir` would still depend on the Host's current drive.
 */
export function isAbsoluteLaunchPath(value: string, platform = process.platform) {
  if (!isAbsoluteMcpCwd(value)) return false;
  return platform === "win32"
    ? path.win32.isAbsolute(value) && /^(?:[A-Za-z]:|[\\/]{2})/.test(value)
    : path.posix.isAbsolute(value);
}

/**
 * Why a stdio launch would depend on the folder it happens to start in, if it would: a relative
 * working directory, or a relative command path (`./start.sh`) without a working directory. Such a
 * mount is neither saved nor started; a bare program name is still looked up on PATH.
 */
export function launchPathProblem(
  transport: { command: string; cwd?: string | undefined },
  platform = process.platform,
): "MCP_CWD_INVALID" | "MCP_COMMAND_RELATIVE" | undefined {
  if (transport.cwd !== undefined)
    return isAbsoluteLaunchPath(transport.cwd, platform) ? undefined : "MCP_CWD_INVALID";
  const separator = platform === "win32" ? /[\\/]/ : /\//;
  return separator.test(transport.command) && !isAbsoluteLaunchPath(transport.command, platform)
    ? "MCP_COMMAND_RELATIVE"
    : undefined;
}

/** Where Bun writes its `bun-node-*` shim: a fixed /tmp (/private/tmp on macOS) that ignores TMPDIR. */
function shimParents(context: LaunchContext, key: (input: string) => string) {
  const parents = [key(context.tmpdir)];
  if (context.platform !== "win32") parents.push("/tmp");
  if (context.platform === "darwin") parents.push("/private/tmp");
  return parents;
}

/**
 * Removes the PATH entries that exist only because of how the Host was started. When `bun run`
 * or an npm script started it (`npm_lifecycle_event` is set), that runner added `node_modules/.bin`
 * for its folders (the shell's folder, the package root and the Host's folder) and each of their
 * ancestors, and Bun also adds the package root itself when run from a subfolder. Bun's
 * `bun-node-*` shim is always removed. Without a runner a `node_modules/.bin` the user put on PATH
 * stays. Every other entry keeps its exact text and order, including relative and empty ones.
 */
export function sanitizeLaunchPath(value: string, context: LaunchContext): string {
  const windows = context.platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const separator = windows ? ";" : ":";
  const key = (input: string) => {
    let normalized = paths.normalize(input);
    const root = paths.parse(normalized).root.length;
    while (normalized.length > root && /[\\/]$/.test(normalized))
      normalized = normalized.slice(0, -1);
    return windows ? normalized.toLowerCase() : normalized;
  };
  const absolute = (input: string | undefined): input is string =>
    Boolean(input && paths.isAbsolute(input));
  const within = (parent: string, child: string) =>
    child === parent ||
    child.startsWith(parent.endsWith(paths.sep) ? parent : `${parent}${paths.sep}`);
  const { env } = context;
  const runner = Boolean(env.npm_lifecycle_event);
  const packageRoot =
    runner && absolute(env.npm_package_json) ? key(paths.dirname(env.npm_package_json)) : undefined;
  const folders = runner
    ? [context.cwd, env.INIT_CWD, env.npm_config_local_prefix].filter(absolute).map(key)
    : [];
  if (packageRoot) folders.push(packageRoot);
  const temporary = shimParents(context, key);
  return value
    .split(separator)
    .filter((entry) => {
      const candidate = windows ? entry.replace(/^"(.*)"$/, "$1") : entry;
      if (!candidate || !paths.isAbsolute(candidate)) return true;
      const normalized = key(candidate);
      const parent = paths.dirname(normalized);
      const name = paths.basename(normalized);
      if (name === ".bin" && paths.basename(parent) === "node_modules")
        return !folders.some((folder) => within(paths.dirname(parent), folder));
      if (normalized === packageRoot) return false;
      return !(temporary.includes(parent) && /^bun-node(?:-[0-9a-f]+)?$/i.test(name));
    })
    .join(separator);
}

/**
 * Prepares the default working directory for stdio MCP servers: `<data>/mcp-runtime`, owned by
 * Kairomes and never the Host's inherited directory. Package runners such as npm, npx and bunx
 * walk upward from their working directory to find a project; a minimal private package.json
 * makes this folder its own root, so they never adopt the Kairomes source tree, a user's project
 * or a stray package.json in a parent folder. An existing package.json is left untouched.
 */
export async function prepareRuntimeDirectory(dataDirectory: string): Promise<string> {
  const directory = path.join(dataDirectory, MCP_RUNTIME_DIRECTORY);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error("Not a directory");
    if (process.platform !== "win32") await chmod(directory, 0o700).catch(() => undefined);
    await writeFile(path.join(directory, "package.json"), RUNTIME_MARKER, {
      flag: "wx",
      mode: 0o600,
    }).catch((error: unknown) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
        throw error;
    });
  } catch {
    throw new KairomesError(
      "MCP_RUNTIME_UNAVAILABLE",
      "無法準備 MCP 工作目錄；請由本機使用者檢查 Kairomes 資料目錄。",
    );
  }
  return directory;
}

/** The directory a stdio MCP starts in; checked before spawning so a bad folder is not reported as a missing program. */
export async function launchDirectory(
  transport: { command: string; cwd?: string | undefined },
  dataDirectory: string,
) {
  // A stored relative value used to follow the Host's own working directory; it is never resolved now.
  const problem = launchPathProblem(transport);
  if (problem === "MCP_CWD_INVALID")
    throw new KairomesError("MCP_CWD_INVALID", "工作目錄設定需改為絕對路徑。");
  if (problem === "MCP_COMMAND_RELATIVE")
    throw new KairomesError("MCP_COMMAND_RELATIVE", MCP_COMMAND_RELATIVE_MESSAGE);
  const { cwd } = transport;
  if (cwd === undefined) return prepareRuntimeDirectory(dataDirectory);
  const directory = await stat(cwd).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!directory) throw new KairomesError("MCP_CWD_MISSING", "工作目錄不存在或不是資料夾。");
  return cwd;
}
