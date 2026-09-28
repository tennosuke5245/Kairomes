import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

type GitResult = { ok: boolean; output: string };
function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 256 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout) => resolve({ ok: !error, output: error ? "" : stdout }),
    );
  });
}

export async function readHandoffWorkingTree(cwd: string) {
  const capturedAt = new Date().toISOString();
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root.ok)
    return {
      state: "unavailable" as const,
      capturedAt,
      reason: "Git 不可用或此資料夾不是儲存庫；不推測版本狀態。",
    };
  const canonicalRoot = await realpath(root.output.trim()).catch(() => null);
  if (!canonicalRoot || path.relative(cwd, canonicalRoot) !== "")
    return {
      state: "unavailable" as const,
      capturedAt,
      reason: "Git 根目錄與交接工作區不同，未讀取外部專案的狀態。",
    };
  const [status, branch, head] = await Promise.all([
    git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(cwd, ["rev-parse", "--verify", "HEAD"]),
  ]);
  if (!status.ok)
    return {
      state: "unavailable" as const,
      capturedAt,
      reason: "Git 狀態逾時、輸出過大或讀取失敗。",
    };
  const records = status.output.split("\0");
  const files: { status: string; path: string; previousPath?: string }[] = [];
  let truncated = false;
  for (let i = 0; i < records.length; i++) {
    const entry = records[i];
    if (!entry) continue;
    if (files.length >= 200) {
      truncated = true;
      break;
    }
    const code = entry.slice(0, 2);
    files.push({
      status: code,
      path: entry.slice(3),
      ...(/[RC]/.test(code) ? { previousPath: records[++i] } : {}),
    });
  }
  return {
    state: "available" as const,
    capturedAt,
    branch: branch.ok ? branch.output.trim() : null,
    head: head.ok ? head.output.trim() : null,
    files,
    truncated,
    note: "目前檔案狀態不是來源 Agent 的修改清單；未追蹤資料夾可被彙整。沒有 commit 是有效狀態，不能據此宣稱工作已保存。",
  };
}
