import { expect, test } from "bun:test";
import { panelErrorMessage } from "./panel-error.ts";

test("late read failures and clear requests preserve the one offline recovery reason", () => {
  for (const message of ["", "結果待確認。", "無法讀取 MCP 狀態。"])
    expect(panelErrorMessage(message, { paired: true, stale: true, approvalUnknown: true })).toBe(
      "顯示上次快照。",
    );
});

test("unrelated catalog successes cannot hide an unknown approval; re-pairing remains primary", () => {
  for (const message of ["", "無法讀取 MCP 狀態。"])
    expect(panelErrorMessage(message, { paired: true, stale: false, approvalUnknown: true })).toBe(
      "結果待確認。",
    );
  expect(
    panelErrorMessage("配對已失效。", { paired: false, stale: true, approvalUnknown: true }),
  ).toBe("配對已失效。");
  expect(panelErrorMessage("", { paired: true, stale: false, approvalUnknown: false })).toBe("");
});
