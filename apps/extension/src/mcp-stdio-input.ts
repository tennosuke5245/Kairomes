import { mcpStdioCwdProblem } from "@kairomes/protocol";

/**
 * A typed or pasted local path: trimmed, without the one pair of double quotes that Windows
 * Explorer's 複製為路徑 adds (`"C:\Users\Me\proj"`). No path ever starts and ends with a quote.
 */
export function mcpPathInput(text: string) {
  const value = text.trim();
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/**
 * The stdio command and working directory exactly as the add form sends them, and the working
 * directory field's message when the Host would refuse them: a relative working directory, or a
 * relative command path (`./start.sh`) without one. The Host re-checks with its platform's rules.
 */
export function mcpStdioLaunchInput(commandText: string, cwdText: string) {
  const command = mcpPathInput(commandText);
  const cwd = mcpPathInput(cwdText) || undefined;
  return { command, cwd, problem: mcpStdioCwdProblem(command, cwd) };
}
