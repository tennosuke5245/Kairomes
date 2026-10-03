import { expect, test } from "bun:test";
import { StudyWidgetController, type StudyWidgetState } from "./study-widget-state.ts";

const baseline: StudyWidgetState = {
  revision: 0,
  fileChanged: false,
  imageChanged: false,
  eventCount: 0,
  readFailure: 0,
  unmounted: false,
};

test("malformed, extra-field, stale and partial rollback replies cannot change the study", () => {
  const controller = new StudyWidgetController();
  controller.receive(baseline);
  controller.receive({
    ...baseline,
    revision: 2,
    fileChanged: true,
    imageChanged: true,
    eventCount: 1,
  });
  for (const input of [
    null,
    [],
    { ...baseline, revision: 3, tool: "shell" },
    { ...baseline, revision: 3, readFailure: -1 },
    { ...baseline, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...baseline, revision: 3, imageChanged: "true" },
    { ...baseline, revision: 1, fileChanged: true },
    { ...baseline, revision: 3, imageChanged: true, eventCount: 1 },
    { ...baseline, revision: 3, fileChanged: true, imageChanged: true, eventCount: 0 },
  ])
    expect(controller.receive(input)).toBeUndefined();
  const next = controller.receive({
    ...baseline,
    revision: 3,
    fileChanged: true,
    imageChanged: true,
    eventCount: 2,
  });
  expect(next?.events).toBe(1);
  expect(next?.reset).toBe(false);
});

test("each new failure generation is consumed once, and reset discards pending answers", () => {
  const controller = new StudyWidgetController();
  controller.receive(baseline);
  controller.receive({ ...baseline, revision: 1, readFailure: 2, eventCount: 2 });
  expect(controller.consumeFailure()).toBe(true);
  const reset = controller.receive({ ...baseline, revision: 2 });
  expect(reset?.reset).toBe(true);
  expect(reset?.events).toBe(0);
  expect(controller.consumeFailure()).toBe(false);
  controller.receive({ ...baseline, revision: 3, readFailure: 1 });
  expect(controller.consumeFailure()).toBe(true);
  expect(controller.consumeFailure()).toBe(false);
});

test("reload establishes the current generation baseline instead of replaying old controls", () => {
  const controller = new StudyWidgetController();
  const input = { ...baseline, revision: 8, eventCount: 5, readFailure: 3, fileChanged: true };
  expect(controller.receive(input)?.events).toBe(0);
  expect(controller.consumeFailure()).toBe(false);
  input.readFailure = 0;
  const next = controller.receive({
    ...baseline,
    revision: 9,
    eventCount: 6,
    readFailure: 4,
    fileChanged: true,
  });
  expect(next?.events).toBe(1);
  expect(controller.consumeFailure()).toBe(true);
  expect(controller.consumeFailure()).toBe(false);
});
