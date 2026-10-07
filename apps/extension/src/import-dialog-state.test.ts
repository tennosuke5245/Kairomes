import { expect, test } from "bun:test";
import { dialogCancelAction, pathEnterAction } from "./import-dialog-state.ts";

test("Enter that confirms an IME candidate never reaches the dialog", () => {
  // Chrome: the candidate-confirming keydown is still composing.
  expect(pathEnterAction({ key: "Enter", isComposing: true, keyCode: 229 })).toBe("none");
  // Safari: composition already ended, but the keydown still carries keyCode 229.
  expect(pathEnterAction({ key: "Enter", isComposing: false, keyCode: 229 })).toBe("none");
  // Between compositionstart and compositionend, whatever the event says.
  expect(pathEnterAction({ key: "Enter", isComposing: false, keyCode: 13 }, true)).toBe("none");
});

test("a plain Enter only checks the path; other keys do nothing", () => {
  expect(pathEnterAction({ key: "Enter", isComposing: false, keyCode: 13 })).toBe("check");
  expect(pathEnterAction({ key: "Enter" })).toBe("check");
  expect(pathEnterAction({ key: "a", keyCode: 65 })).toBe("none");
  expect(pathEnterAction({ key: "Process", keyCode: 229 })).toBe("none");
});

test("取消 and Esc abandon every step except the decision in flight", () => {
  expect(dialogCancelAction("edit")).toBe("close");
  expect(dialogCancelAction("creating")).toBe("abort");
  expect(dialogCancelAction("uploading")).toBe("abort");
  expect(dialogCancelAction("verifying")).toBe("abort");
  expect(dialogCancelAction("approving")).toBe("wait");
});
