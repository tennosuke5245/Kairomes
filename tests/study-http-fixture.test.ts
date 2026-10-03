import { expect, test } from "bun:test";
import { createStudyHttpFixture } from "./study-http-fixture.ts";

const origin = "http://127.0.0.1:12345";
function post(path: string, body: unknown, requestOrigin = origin) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: requestOrigin },
    body: JSON.stringify(body),
  });
}

test("study controls reject foreign origins, extra fields and privileged destinations", async () => {
  const fixture = createStudyHttpFixture();
  expect(
    (
      await fixture.handle(
        post(
          "/synthetic-study/control",
          { material: "widget", action: "reset" },
          "https://invalid.example",
        ),
      )
    )?.status,
  ).toBe(403);
  expect(
    (
      await fixture.handle(
        post("/synthetic-study/control", {
          material: "widget",
          action: "edit-file",
          path: "private",
        }),
      )
    )?.status,
  ).toBe(400);
  expect(
    (
      await fixture.handle(
        post("/synthetic-study/control", { material: "widget", action: "mount" }),
      )
    )?.status,
  ).toBe(400);
  expect(
    (
      await fixture.handle(
        post("/synthetic-study/handoff", { material: "alpha", command: "shell", input: {} }),
      )
    )?.status,
  ).toBe(400);
  expect((await fixture.handle(post("/synthetic-study/mount", {})))?.status).toBe(404);
  expect(fixture.probe().widget.revision).toBe(0);
});

test("widget study reset preserves a monotonic revision and isolates handoff materials", async () => {
  const fixture = createStudyHttpFixture();
  await fixture.handle(
    post("/synthetic-study/control", { material: "widget", action: "edit-image" }),
  );
  await fixture.handle(
    post("/synthetic-study/control", { material: "widget", action: "fail-read" }),
  );
  expect(fixture.probe().widget).toMatchObject({ revision: 2, imageChanged: true, readFailure: 1 });
  await fixture.handle(post("/synthetic-study/control", { material: "widget", action: "reset" }));
  expect(fixture.probe().widget).toEqual({
    revision: 3,
    imageChanged: false,
    fileChanged: false,
    eventCount: 0,
    readFailure: 0,
    unmounted: false,
  });
  const before = fixture.probe().beta;
  await fixture.handle(
    post("/synthetic-study/control", { material: "alpha", action: "edit-file" }),
  );
  expect(fixture.probe().beta).toEqual(before);
});
