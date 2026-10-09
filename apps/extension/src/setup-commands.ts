/** The commands the setup page and 一般 show for this browser's extension ID. */
export function setupCommands(extensionId: string) {
  return {
    start: `bun.cmd run app --port 0 --extension-id ${extensionId}`,
    pair: `bun.cmd run kairomes pair --extension-id ${extensionId}`,
    tunnel: "tunnel-client run --profile kairomes",
  };
}

/**
 * A command split at its spaces. Each argument is drawn as one unit that wraps whole, so a
 * narrow panel never breaks `--extension-id` after its `--` (which would read as the
 * end-of-options marker). Joining the tokens with single spaces gives the command back.
 */
export function commandTokens(command: string) {
  return command.split(" ").filter(Boolean);
}
