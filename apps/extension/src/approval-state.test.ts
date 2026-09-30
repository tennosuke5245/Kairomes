import { expect, test } from "bun:test";
import { canStopOngoing, splitApprovalItems } from "./approval-state.ts";

test("only requests awaiting a decision float over the workbench", () => {
  const items = [
    { id: "pending", state: "pending" },
    { id: "applying", state: "applying" },
    { id: "starting", state: "starting" },
    { id: "running", state: "running" },
    { id: "exited", state: "exited" },
    { id: "stopped", state: "stopped" },
  ];
  const { pending, ongoing } = splitApprovalItems(items);
  expect(pending.map((item) => item.id)).toEqual(["pending"]);
  expect(ongoing.map((item) => item.id)).toEqual(["applying", "starting", "running"]);
});

test("only starting or running commands and terminals offer a stop action", () => {
  expect(canStopOngoing({ state: "starting", shell: "cmd" })).toBe(true);
  expect(canStopOngoing({ state: "running", argv: ["bun", "test"] })).toBe(true);
  expect(canStopOngoing({ state: "applying" })).toBe(false);
  expect(canStopOngoing({ state: "pending", shell: "cmd" })).toBe(false);
  expect(canStopOngoing({ state: "exited", shell: "cmd" })).toBe(false);
});
