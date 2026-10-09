import { expect, test } from "bun:test";
import {
  hostTabForView,
  hostTabs,
  hostTheme,
  moveTab,
  workbenchTabForView,
  workbenchTabs,
} from "./host-model.ts";

const all = { write: true, command: true, terminal: true };
const reasons = (input: Parameters<typeof hostTabs>[0]) =>
  Object.fromEntries(hostTabs(input).map((tab) => [tab.id, tab.disabledReason]));

test("host tabs keep a fixed order and 檔案 is always available", () => {
  const tabs = hostTabs({ projects: 2, selected: true, status: all });
  expect(tabs.map((tab) => tab.label)).toEqual(["檔案", "變更", "命令", "終端機"]);
  expect(tabs.every((tab) => !tab.disabledReason)).toBe(true);
  for (const status of ["loading", "failed", { write: false, command: false, terminal: false }])
    expect(
      hostTabs({ projects: 0, selected: false, status: status as never })[0]?.disabledReason,
    ).toBeUndefined();
});

test("a muted tab gives exactly one reason, most basic cause first", () => {
  expect(reasons({ projects: 0, selected: false, status: all })).toEqual({
    files: undefined,
    changes: "還沒有專案",
    commands: "還沒有專案",
    terminal: "還沒有專案",
  });
  expect(reasons({ projects: 1, selected: false, status: all }).commands).toBe("請先選擇專案");
  expect(reasons({ projects: 1, selected: true, status: "loading" }).terminal).toBe(
    "正在讀取本機工作台狀態",
  );
  expect(reasons({ projects: 1, selected: true, status: "failed" }).changes).toBe(
    "無法取得本機工作台狀態",
  );
  expect(
    reasons({
      projects: 1,
      selected: true,
      status: { write: true, command: true, terminal: false },
    }),
  ).toEqual({
    files: undefined,
    changes: undefined,
    commands: undefined,
    terminal: "這台電腦目前無法開啟終端機",
  });
  expect(
    reasons({
      projects: 1,
      selected: true,
      status: { write: false, command: false, terminal: true },
    }),
  ).toMatchObject({ changes: "本機工作台沒有開啟檔案變更", commands: "本機工作台沒有開啟命令" });
});

test("images and the unused overview live under 檔案", () => {
  expect(hostTabForView("files")).toBe("files");
  expect(hostTabForView("artifact")).toBe("files");
  expect(hostTabForView("overview")).toBe("files");
  expect(hostTabForView("changes")).toBe("changes");
  expect(hostTabForView("commands")).toBe("commands");
  expect(hostTabForView("terminal")).toBe("terminal");
});

test("arrow keys wrap around the tab list; Home and End jump to the ends", () => {
  expect(moveTab("ArrowRight", 0, 4)).toBe(1);
  expect(moveTab("ArrowRight", 3, 4)).toBe(0);
  expect(moveTab("ArrowLeft", 0, 4)).toBe(3);
  expect(moveTab("Home", 2, 4)).toBe(0);
  expect(moveTab("End", 0, 4)).toBe(3);
  expect(moveTab("ArrowDown", 0, 4)).toBeUndefined();
  expect(moveTab("ArrowRight", 0, 0)).toBeUndefined();
});

test("only light and dark host themes reach data-theme", () => {
  expect(hostTheme("light")).toBe("light");
  expect(hostTheme("dark")).toBe("dark");
  for (const value of ["", "Dark", "high-contrast", 'dark" onload="x', null, undefined, 1, {}])
    expect(hostTheme(value)).toBeUndefined();
});

test("the wide workbench toolbar: five tabs; 終端機 waits for one project", () => {
  const ready = { projects: 2, filtered: true, terminal: "ready" as const };
  const tabs = workbenchTabs(ready);
  expect(tabs.map((tab) => tab.label)).toEqual(["動態", "檔案", "變更", "命令", "終端機"]);
  expect(tabs.every((tab) => !tab.disabledReason)).toBe(true);
  const reason = (input: Parameters<typeof workbenchTabs>[0]) =>
    workbenchTabs(input).find((tab) => tab.id === "terminal")?.disabledReason;
  expect(reason({ ...ready, filtered: false })).toBe("請先在專案切換器選擇專案");
  expect(reason({ ...ready, terminal: "loading" })).toBe("正在讀取本機工作台狀態");
  expect(reason({ ...ready, terminal: "unavailable" })).toBe("這台電腦目前無法開啟終端機");
  // Lists of changes and commands cover every project, so they never wait for one.
  const all = workbenchTabs({ ...ready, filtered: false });
  expect(all.filter((tab) => tab.disabledReason).map((tab) => tab.id)).toEqual(["terminal"]);
  // A terminal opened from 動態 in 全部專案 is on screen: its tab is not muted.
  expect(reason({ ...ready, filtered: false, current: "terminal" })).toBeUndefined();
  const none = workbenchTabs({ ...ready, projects: 0 });
  expect(none.find((tab) => tab.id === "files")?.disabledReason).toBe("還沒有專案");
  expect(workbenchTabForView("artifact")).toBe("files");
  expect(workbenchTabForView("overview")).toBe("overview");
  expect(workbenchTabForView("commands")).toBe("commands");
});
