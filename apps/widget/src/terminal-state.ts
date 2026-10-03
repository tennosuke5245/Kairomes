import type { TerminalSession } from "@kairomes/protocol";

export function terminalActive(session: TerminalSession) {
  return ["pending", "starting", "running"].includes(session.state);
}

export function terminalSelection(sessions: TerminalSession[], selected: string) {
  // An unavailable historical shell must never silently select another shell.
  return selected || sessions.at(-1)?.id || "";
}

export function currentTerminalSession(selected?: TerminalSession, polled?: TerminalSession) {
  if (!selected || !terminalActive(selected) || polled?.id !== selected.id) return selected;
  const phase = (session: TerminalSession) =>
    session.state === "pending"
      ? 0
      : session.state === "starting"
        ? 1
        : session.state === "running"
          ? 2
          : 3;
  // A late pending/running poll cannot supersede a newer live snapshot.
  return phase(polled) < phase(selected) ? selected : polled;
}
