import { expect, test } from "bun:test";
import { copyAnnouncement, copyText } from "./copy.ts";
import { listMove, movedIndex, rovingIndex } from "./keyboard.ts";
import { terminalTheme } from "./terminal-theme.ts";

const key = (value: string, extra: Partial<Parameters<typeof listMove>[0]> = {}) => ({
  key: value,
  editable: false,
  ...extra,
});

test("↑/↓ and j/k move in lists; Home and End jump; typing and xterm are ignored", () => {
  expect(listMove(key("ArrowDown"))).toBe("next");
  expect(listMove(key("j"))).toBe("next");
  expect(listMove(key("ArrowUp"))).toBe("previous");
  expect(listMove(key("k"))).toBe("previous");
  expect(listMove(key("Home"))).toBe("first");
  expect(listMove(key("End"))).toBe("last");
  expect(listMove(key("Enter"))).toBeUndefined();
  expect(listMove(key("j", { editable: true }))).toBeUndefined();
  expect(listMove(key("ArrowDown", { editable: true }))).toBeUndefined();
  for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const)
    expect(listMove(key("ArrowDown", { [modifier]: true }))).toBeUndefined();
});

test("moves stop at the ends instead of wrapping", () => {
  expect(movedIndex("next", 0, 3)).toBe(1);
  expect(movedIndex("next", 2, 3)).toBe(2);
  expect(movedIndex("previous", 0, 3)).toBe(0);
  expect(movedIndex("first", 2, 3)).toBe(0);
  expect(movedIndex("last", 0, 3)).toBe(2);
  expect(movedIndex("next", 0, 0)).toBe(-1);
});

test("one tab stop: the last moved-to item, else the current row, else the first", () => {
  const item = (active = false, current = false) => ({ active, current });
  expect(rovingIndex([])).toBe(-1);
  expect(rovingIndex([item(), item()])).toBe(0);
  expect(rovingIndex([item(), item(false, true)])).toBe(1);
  expect(rovingIndex([item(true), item(false, true)])).toBe(0);
});

test("copy uses the clipboard first, then the selection fallback, and reports failure", async () => {
  const written: string[] = [];
  expect(
    await copyText("bun test", {
      clipboard: { writeText: async (text) => void written.push(text) },
      selectionCopy: () => {
        throw new Error("not reached");
      },
    }),
  ).toBe(true);
  expect(written).toEqual(["bun test"]);
  const selected: string[] = [];
  expect(
    await copyText("fallback", {
      clipboard: {
        writeText: async () => {
          throw new DOMException("blocked", "NotAllowedError");
        },
      },
      selectionCopy: (text) => {
        selected.push(text);
        return true;
      },
    }),
  ).toBe(true);
  expect(selected).toEqual(["fallback"]);
  expect(await copyText("x", { selectionCopy: () => false })).toBe(false);
  expect(
    await copyText("x", {
      selectionCopy: () => {
        throw new Error("no document");
      },
    }),
  ).toBe(false);
  expect(copyAnnouncement("copied")).toBe("已複製");
  expect(copyAnnouncement("failed")).toContain("無法複製");
  expect(copyAnnouncement("idle")).toBe("");
});

test("the terminal palette is built from tokens and follows whichever theme is computed", () => {
  const light: Record<string, string> = {
    "--k-code-bg": " #f4efe7",
    "--k-code-ink": "#262122",
    "--k-danger-on": "#942a12",
    "--k-selection": "#c9d7f5",
  };
  const theme = terminalTheme((token) => light[token] ?? "");
  expect(theme.background).toBe("#f4efe7");
  expect(theme.foreground).toBe("#262122");
  expect(theme.red).toBe("#942a12");
  expect(theme.selectionBackground).toBe("#c9d7f5");
  expect(theme.green).toBeUndefined();
  const dark = terminalTheme((token) => (token === "--k-code-bg" ? "#171413" : ""));
  expect(dark).toEqual({ background: "#171413", cursorAccent: "#171413" });
  expect(JSON.stringify(theme)).not.toContain("#111513");
});
