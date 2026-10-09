// Workspace switcher listbox behaviour (WAI-ARIA listbox): pure index math for bun:test.

export interface SwitcherOption {
  /** null is 全部專案. Ids are opaque workspace UUIDs. */
  id: string | null;
  label: string;
}

export const ALL_PROJECTS = "全部專案";

/**
 * 全部專案 first, then each project. The ChatGPT host viewer browses one project at a time, so
 * it leaves 全部專案 out (`includeAll: false`).
 */
export function switcherOptions(
  workspaces: readonly { id: string; name: string }[],
  includeAll = true,
): SwitcherOption[] {
  const projects = workspaces.map(({ id, name }) => ({ id, label: name }));
  return includeAll ? [{ id: null, label: ALL_PROJECTS }, ...projects] : projects;
}

/**
 * The trigger label: the selected project's name, else 全部專案; without 全部專案 it asks for a
 * project instead (or says there is none yet).
 */
export function switcherLabel(
  selected: string | null,
  workspaces: readonly { id: string; name: string }[],
  fallbackName?: string,
  includeAll = true,
) {
  const none = includeAll ? ALL_PROJECTS : workspaces.length ? "選擇專案" : "還沒有專案";
  if (!selected) return none;
  return workspaces.find((item) => item.id === selected)?.name ?? fallbackName ?? none;
}

/** Arrow, Home and End movement. No wrap-around, matching native single-select lists. */
export function moveActive(key: string, active: number, count: number) {
  if (count <= 0) return -1;
  const last = count - 1;
  if (key === "ArrowDown") return Math.min(last, Math.max(-1, active) + 1);
  if (key === "ArrowUp") return Math.max(0, (active < 0 ? count : active) - 1);
  if (key === "Home" || key === "PageUp") return 0;
  if (key === "End" || key === "PageDown") return last;
  return undefined;
}

/**
 * Type-ahead: the next option after `active` whose label starts with `query` (case-folded).
 * Repeating one character cycles through the options that start with it.
 */
export function typeAhead(options: readonly SwitcherOption[], query: string, active: number) {
  const needle = query.toLocaleLowerCase();
  if (!needle || !options.length) return undefined;
  const cycling = [...needle].every((character) => character === needle[0]);
  const prefix = cycling ? (needle[0] ?? "") : needle;
  const start = cycling || needle.length === 1 ? active + 1 : Math.max(active, 0);
  for (let step = 0; step < options.length; step++) {
    const index = (((start + step) % options.length) + options.length) % options.length;
    if (options[index]?.label.toLocaleLowerCase().startsWith(prefix)) return index;
  }
  return undefined;
}

/** Printable single characters feed type-ahead; modifiers and named keys do not. */
export function typeAheadCharacter(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}) {
  return event.key.length === 1 &&
    event.key !== " " &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
    ? event.key
    : undefined;
}
