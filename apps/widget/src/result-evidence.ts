import type { CommandResult } from "@kairomes/protocol";

export function outputEvidence(result?: CommandResult, failed = false) {
  if (failed) return "輸出待確認";
  if (!result) return "讀取輸出…";
  if (!result.output_complete || result.has_more) return "輸出尚未讀完";
  if (result.stdout_truncated || result.stderr_truncated) return "輸出部分保留";
  return "輸出完整";
}

export function commandEvidence(result?: CommandResult, failed = false) {
  return Boolean(
    !failed &&
      result?.command.state === "succeeded" &&
      result.command.exit_code === 0 &&
      result.output_complete &&
      !result.has_more &&
      !result.stdout_truncated &&
      !result.stderr_truncated,
  );
}
