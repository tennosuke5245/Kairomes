import { redactKnownSecrets } from "@kairomes/workspace-core";

/** Pure validation of human-edited sharing text; never reads source or host data. */
export function hasPrivateHandoffText(value: string) {
  if (
    redactKnownSecrets(value) !== value ||
    /(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\|(?:^|\s)\/(?:Users|home|tmp|private|var)\//im.test(value)
  )
    return true;
  for (const match of value.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const candidate = match[0].replace(/[).,;!?。；，）]+$/u, "");
    try {
      const hostname = new URL(candidate).hostname.toLowerCase().replace(/\.+$/, "");
      if (
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        /^127(?:\.\d{1,3}){3}$/.test(hostname) ||
        hostname === "[::1]" ||
        /^\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\]$/.test(hostname)
      )
        return true;
    } catch {
      // Retain the existing rejection for recognizable but malformed local URLs.
      if (/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])/i.test(candidate)) return true;
    }
  }
  return false;
}
