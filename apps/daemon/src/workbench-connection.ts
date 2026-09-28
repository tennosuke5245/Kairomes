import { lstat, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { KairomesError, z } from "@kairomes/protocol";

const ConnectionSchema = z
  .object({
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
    origin: z
      .string()
      .refine(
        (value) =>
          /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(value) &&
          Number(new URL(value).port) <= 65535,
      ),
    uiToken: z.string().regex(/^[a-f0-9]{64}$/),
    mcpToken: z.string().regex(/^[a-f0-9]{64}$/),
    adminToken: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type WorkbenchConnection = z.infer<typeof ConnectionSchema>;
const filename = (directory: string) => path.join(directory, "workbench-connection.json");

export async function readWorkbenchConnection(directory: string): Promise<WorkbenchConnection> {
  try {
    const file = filename(directory);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 4096)
      throw new Error("unsafe descriptor");
    return ConnectionSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    throw new KairomesError(
      "WORKBENCH_UNAVAILABLE",
      "找不到有效的本機工作台連線；請先執行 bun run app，並使用相同的 --data-dir。",
    );
  }
}

export async function verifyWorkbenchConnection(connection: WorkbenchConnection) {
  try {
    const response = await fetch(`${connection.origin}/healthz`, {
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    });
    const status = await response.json();
    if (!response.ok || status.instanceId !== connection.instanceId)
      throw new Error("instance mismatch");
  } catch {
    throw new KairomesError(
      "WORKBENCH_UNAVAILABLE",
      "本機工作台已離線或更換實例；請重新啟動 app 與 Tunnel relay。",
    );
  }
}

export async function publishWorkbenchConnection(
  directory: string,
  connection: WorkbenchConnection,
) {
  const file = filename(directory);
  // Exclusive creation prevents silently replacing a running workspace's authority.
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
      throw error;
    const previous = await readWorkbenchConnection(directory);
    // A PID alone is not authority on Windows: PIDs can be recycled after an
    // unclean shutdown. Keep the descriptor only when its loopback server
    // proves it still owns the recorded instance ID.
    let alive = false;
    try {
      await verifyWorkbenchConnection(previous);
      alive = true;
    } catch {
      // The bounded, validated descriptor is stale and can be safely replaced.
    }
    if (alive)
      throw new KairomesError(
        "WORKBENCH_RUNNING",
        "相同狀態目錄已有工作台；用 bun run kairomes open 取得網址，或先停止原程序。",
      );
    // Only remove our bounded, validated stale descriptor, never a directory.
    await unlink(file);
    handle = await open(file, "wx", 0o600);
  }
  try {
    await handle.writeFile(JSON.stringify(ConnectionSchema.parse(connection)));
  } finally {
    await handle.close();
  }
  return async () => {
    try {
      if ((await readWorkbenchConnection(directory)).instanceId === connection.instanceId)
        await unlink(file);
    } catch {
      /* The descriptor may already have been removed by the local user. */
    }
  };
}
