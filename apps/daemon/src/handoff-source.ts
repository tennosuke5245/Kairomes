import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KairomesError } from "@kairomes/protocol";
import { CodexSessionSource } from "./agent-sessions.ts";
import { CodexRpc } from "./codex-rpc.ts";

/** A local user request chooses the workspace; source home never crosses into model APIs. */
export async function openHandoffSource(
  workspace: string,
  sourceHome?: string,
  signal?: AbortSignal,
) {
  const directory = await realpath(
    sourceHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
  );
  if (!(await stat(directory)).isDirectory())
    throw new KairomesError("SESSION_HOME", "來源 Codex home 必須是已存在的資料夾。");
  const rpc = new CodexRpc(
    directory,
    Bun.which("codex.exe") ?? Bun.which("codex"),
    20000,
    ["app-server", "--stdio", "-c", "analytics.enabled=false"],
    { experimentalApi: true },
  );
  const cancel = () => void rpc.close();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) throw new KairomesError("HANDOFF_CANCELLED", "已取消來源讀取。");
    return await CodexSessionSource.open(rpc, workspace, signal);
  } catch (error) {
    await rpc.close();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
