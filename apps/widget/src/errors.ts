import { ResultError } from "./tool-result.ts";

// User-facing errors (design spec §7 rule 8): one fixed sentence, never a class name,
// String(cause), a URL, a local path or raw tool output. Daemon messages are already short
// Traditional Chinese copy, so they pass through when they look like that; anything else
// falls back to the caller's sentence.

const codeMessages: Record<string, string> = {
  RESULT_EXPIRED: "詳情已到期。",
  COMMAND_NOT_FOUND: "找不到這個命令，可能已被清除。",
  FILE_CHANGE_NOT_FOUND: "找不到這批變更，可能已被清除。",
  CHANGE_NOT_FOUND: "找不到這批變更，可能已被清除。",
  TERMINAL_NOT_FOUND: "找不到這個終端機，可能已關閉。",
  TERMINAL_NOT_RUNNING: "終端機已結束，無法再輸入。",
  WORKSPACE_NOT_FOUND: "專案已解除掛載。",
  INSTANCE_CHANGED: "本機工作台已重新啟動，請重新整理。",
};

const ERROR_PREFIX = /^\s*[A-Za-z]*(?:Error|Exception)\s*:\s*/;
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\./i;
// Windows drive or UNC paths, and POSIX paths with at least two segments (/Users/mei/...).
const ABSOLUTE_PATH = /(?:^|[\s"'(（「])(?:[A-Za-z]:[\\/]|\\\\|\/(?:[^\s/]+\/)+)/;
const CJK = /[㐀-鿿豈-﫿]/;
const MAX_LENGTH = 160;

/** A single safe sentence for an error, or the fallback when the cause is not user copy. */
export function friendlyError(cause: unknown, fallback: string): string {
  if (cause instanceof ResultError && cause.code && Object.hasOwn(codeMessages, cause.code))
    return codeMessages[cause.code] ?? fallback;
  const raw =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;
  if (!raw) return fallback;
  const message = raw.replace(ERROR_PREFIX, "").trim();
  if (
    !message ||
    message.length > MAX_LENGTH ||
    message.includes("\n") ||
    !CJK.test(message) ||
    URL_LIKE.test(message) ||
    ABSOLUTE_PATH.test(message)
  )
    return fallback;
  return message;
}
