import { expect, test } from "bun:test";
import { reconcileWorkspaceSelection, workspaceLabel } from "./workspace-selection.ts";

test("an unmounted selection clears native browsing without sending a navigation message", () => {
  expect(reconcileWorkspaceSelection("removed", [{ id: "other" }])).toEqual({
    id: null,
    notifyWorkbench: false,
  });
  expect(reconcileWorkspaceSelection("kept", [{ id: "kept" }])).toEqual({
    id: "kept",
    notifyWorkbench: true,
  });
  expect(reconcileWorkspaceSelection(null, [])).toEqual({ id: null, notifyWorkbench: true });
});

test("the switcher names one project or all projects, never a removed one", () => {
  const workspaces = [{ id: "one", name: "Kairomes" }];
  expect(workspaceLabel("one", workspaces)).toEqual({ label: "Kairomes", icon: "Folder" });
  expect(workspaceLabel(null, workspaces)).toEqual({ label: "全部專案", icon: "Stack" });
  expect(workspaceLabel("gone", workspaces)).toEqual({ label: "全部專案", icon: "Stack" });
});
