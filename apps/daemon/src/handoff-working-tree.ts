import { type GitOutcome, openGitRepository } from "./git.ts";

function text(outcome: GitOutcome) {
  return outcome.kind === "ok" ? outcome.stdout.toString("utf8") : "";
}

export async function readHandoffWorkingTree(cwd: string) {
  const capturedAt = new Date().toISOString();
  const opened = await openGitRepository(cwd);
  if (opened.state === "unavailable")
    return {
      state: "unavailable" as const,
      capturedAt,
      reason:
        opened.reason === "root_mismatch"
          ? "Git 根目錄與交接工作區不同，未讀取外部專案的狀態。"
          : "Git 不可用或此資料夾不是儲存庫；不推測版本狀態。",
    };
  const git = opened.repository;
  const [status, branch, head] = await Promise.all([
    git.run([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
      "--ignore-submodules=dirty",
    ]),
    git.run(["symbolic-ref", "--short", "-q", "HEAD"]),
    git.run(["rev-parse", "--verify", "HEAD"]),
  ]);
  if (status.kind !== "ok")
    return {
      state: "unavailable" as const,
      capturedAt,
      reason: "Git 狀態逾時、輸出過大或讀取失敗。",
    };
  const records = text(status).split("\0");
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
    branch: branch.kind === "ok" ? text(branch).trim() : null,
    head: head.kind === "ok" ? text(head).trim() : null,
    files,
    truncated,
    note: "目前檔案狀態不是來源 Agent 的修改清單；未追蹤資料夾可被彙整。沒有 commit 是有效狀態，不能據此宣稱工作已保存。",
  };
}
