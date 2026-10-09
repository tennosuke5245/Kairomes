import type { ITheme } from "@xterm/xterm";

// The xterm palette comes from the design tokens (design spec §5.3), so the terminal follows
// the light and dark themes like the rest of the workbench. Every ANSI colour maps to a
// token that keeps ≥4.5:1 on --k-code-bg in both themes.

const TOKENS = {
  background: "--k-code-bg",
  foreground: "--k-code-ink",
  cursor: "--k-ink-1",
  cursorAccent: "--k-code-bg",
  selectionBackground: "--k-selection",
  selectionForeground: "--k-ink-1",
  selectionInactiveBackground: "--k-selection",
  black: "--k-ink-3",
  red: "--k-danger-on",
  green: "--k-success-on",
  yellow: "--k-warning-on",
  blue: "--k-running-on",
  magenta: "--k-ws-2",
  cyan: "--k-ws-1",
  white: "--k-ink-2",
  brightBlack: "--k-ink-3",
  brightRed: "--k-danger",
  brightGreen: "--k-success",
  brightYellow: "--k-warning",
  brightBlue: "--k-running",
  brightMagenta: "--k-ws-2",
  brightCyan: "--k-ws-1",
  brightWhite: "--k-ink-1",
} as const satisfies Partial<Record<keyof ITheme, `--k-${string}`>>;

/** Builds an xterm theme from token values; unknown or empty tokens are left to xterm. */
export function terminalTheme(read: (token: string) => string): ITheme {
  const theme: Record<string, string> = {};
  for (const [key, token] of Object.entries(TOKENS)) {
    const value = read(token).trim();
    if (value) theme[key] = value;
  }
  return theme as ITheme;
}

/** Reads the computed tokens where the terminal is mounted (a [data-theme] subtree counts). */
export function tokenTerminalTheme(element: Element) {
  const style = getComputedStyle(element);
  return terminalTheme((token) => style.getPropertyValue(token));
}
