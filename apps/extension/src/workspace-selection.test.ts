import { expect, test } from "bun:test";
import { reconcileWorkspaceSelection } from "./workspace-selection.ts";

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
