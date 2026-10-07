// ChatGPT host viewer and wide workbench toolbar (design spec §5.3 G6, e2): pure tab and
// theme rules for bun:test. Neither surface ever approves, mounts or grants anything.

export type HostTab = "files" | "changes" | "commands" | "terminal";
export type WorkbenchTab = "overview" | HostTab;
export type HostView = "files" | "artifact" | "terminal" | "overview" | "commands" | "changes";

export interface HostCapabilities {
  write: boolean;
  command: boolean;
  terminal: boolean;
}

/** kairomes_status: still loading, failed, or the runtime capabilities it reported. */
export type HostStatus = "loading" | "failed" | HostCapabilities;

export interface ViewTabState<T extends string> {
  id: T;
  label: string;
  /** Present when the tab is visible but muted; shown as its title and read by screen readers. */
  disabledReason?: string;
}
export type HostTabState = ViewTabState<HostTab>;

/**
 * The four host tabs. 檔案 is always available (it explains an empty project list itself);
 * the others stay visible but muted with one reason when they cannot open.
 */
export function hostTabs({
  projects,
  selected,
  status,
}: {
  projects: number;
  selected: boolean;
  status: HostStatus;
}): HostTabState[] {
  const gate = (allowed: (capabilities: HostCapabilities) => boolean, missing: string) => {
    if (!projects) return "還沒有專案";
    if (!selected) return "請先選擇專案";
    if (status === "loading") return "正在讀取本機工作台狀態";
    if (status === "failed") return "無法取得本機工作台狀態";
    return allowed(status) ? undefined : missing;
  };
  return [
    { id: "files", label: "檔案" },
    {
      id: "changes",
      label: "變更",
      disabledReason: gate((value) => value.write, "本機工作台沒有開啟檔案變更"),
    },
    {
      id: "commands",
      label: "命令",
      disabledReason: gate((value) => value.command, "本機工作台沒有開啟命令"),
    },
    {
      id: "terminal",
      label: "終端機",
      disabledReason: gate((value) => value.terminal, "這台電腦目前無法開啟終端機"),
    },
  ];
}

/**
 * The wide workbench toolbar (≥760px): 動態／檔案／變更／命令／終端機. Lists of changes and
 * commands cover every project in 全部專案; 終端機 opens a shell in one project, so it stays
 * muted until the switcher holds one, unless a terminal opened from 動態 is already shown.
 */
export function workbenchTabs({
  projects,
  filtered,
  terminal,
  current,
}: {
  projects: number;
  /** The switcher holds one project (not 全部專案). */
  filtered: boolean;
  terminal: "ready" | "loading" | "unavailable";
  /** The tab on screen is never muted. */
  current?: WorkbenchTab;
}): ViewTabState<WorkbenchTab>[] {
  const none = projects ? undefined : "還沒有專案";
  const shell =
    current === "terminal"
      ? undefined
      : (none ??
        (!filtered
          ? "請先在專案切換器選擇專案"
          : terminal === "loading"
            ? "正在讀取本機工作台狀態"
            : terminal === "unavailable"
              ? "這台電腦目前無法開啟終端機"
              : undefined));
  return [
    { id: "overview", label: "動態" },
    { id: "files", label: "檔案", disabledReason: none },
    { id: "changes", label: "變更" },
    { id: "commands", label: "命令" },
    { id: "terminal", label: "終端機", disabledReason: shell },
  ];
}

/** The workbench tab a view belongs to: images open under 檔案. */
export function workbenchTabForView(view: HostView): WorkbenchTab {
  return view === "artifact" ? "files" : view;
}

/** Images and the (host-unused) overview belong to the 檔案 tab. */
export function hostTabForView(view: HostView): HostTab {
  return view === "changes" || view === "commands" || view === "terminal" ? view : "files";
}

/** Arrow keys move focus along the tab list (wrapping); Home and End jump to the ends. */
export function moveTab(key: string, index: number, count: number) {
  if (count <= 0) return undefined;
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}

/** Only the two documented host themes reach data-theme; anything else keeps the OS theme. */
export function hostTheme(value: unknown): "light" | "dark" | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}
