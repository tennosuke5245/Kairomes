import { expect, test } from "bun:test";
import { ImageUploadTracker } from "./image-upload.ts";

const ids = () => {
  let next = 0;
  return () => `0000000${++next}-0000-4000-8000-000000000000`;
};
const source = "http://127.0.0.1:1:instance";
const observation = (
  patch: Partial<{ state: string; upload_id: string | null; error_code: string | null }>,
) => ({
  id: "import-1",
  state: "awaiting_file",
  upload_id: null,
  error_code: null,
  ...patch,
});

test("each attempt gets an ID; a second send waits for the first", () => {
  const tracker = new ImageUploadTracker(ids());
  tracker.bind(source);
  const first = tracker.begin(source, "import-1", "a");
  expect(first).toBe("00000001-0000-4000-8000-000000000000");
  expect(tracker.begin(source, "import-1", "a")).toBeUndefined();
  expect(tracker.begin(source, "import-2", "a")).toBe("00000002-0000-4000-8000-000000000000");
  // Another paired instance can never start or settle anything here.
  expect(tracker.begin("other", "import-3", "a")).toBeUndefined();
});

test("after an unknown result the same bytes reuse the same upload ID; new bytes get a new one", () => {
  const tracker = new ImageUploadTracker(ids());
  tracker.bind(source);
  const first = tracker.begin(source, "import-1", "a") as string;
  tracker.settle(source, "import-1", first, "unknown");
  expect(tracker.hasUnknown).toBe(true);
  expect(tracker.begin(source, "import-1", "a")).toBe(first);
  tracker.settle(source, "import-1", first, "unknown");
  const other = tracker.begin(source, "import-1", "b");
  expect(other).not.toBe(first);
  tracker.settle(source, "import-1", other as string, "unknown");
  // The first bytes still map to their own unconfirmed ID.
  expect(tracker.begin(source, "import-1", "a")).toBe(first);
});

test("a refused upload burns its ID: the daemon would replay the refusal", () => {
  const tracker = new ImageUploadTracker(ids());
  tracker.bind(source);
  const first = tracker.begin(source, "import-1", "a") as string;
  tracker.settle(source, "import-1", first, { rejected: "UPLOAD_INTERRUPTED" });
  expect(tracker.status(source, "import-1")).toMatchObject({
    status: "rejected",
    code: "UPLOAD_INTERRUPTED",
  });
  expect(tracker.begin(source, "import-1", "a")).not.toBe(first);
});

test("only the import's own upload_id settles an unknown attempt", () => {
  const tracker = new ImageUploadTracker(ids());
  tracker.bind(source);
  const id = tracker.begin(source, "import-1", "a") as string;
  tracker.settle(source, "import-1", id, "unknown");
  // Still waiting, or another upload: proves nothing.
  tracker.observe(source, [observation({})]);
  tracker.observe(source, [observation({ upload_id: "someone-else" })]);
  tracker.observe(source, [observation({ state: "preparing", upload_id: id })]);
  expect(tracker.status(source, "import-1")?.status).toBe("unknown");
  tracker.observe(source, [observation({ state: "pending", upload_id: id })]);
  expect(tracker.status(source, "import-1")?.status).toBe("accepted");
  expect(tracker.hasUnknown).toBe(false);
});

test("a refusal recorded on the import settles the attempt as refused", () => {
  const tracker = new ImageUploadTracker(ids());
  tracker.bind(source);
  const id = tracker.begin(source, "import-1", "a") as string;
  tracker.settle(source, "import-1", id, "unknown");
  tracker.observe(source, [observation({ upload_id: id, error_code: "INVALID_IMAGE" })]);
  expect(tracker.status(source, "import-1")).toMatchObject({
    status: "rejected",
    code: "INVALID_IMAGE",
  });
  expect(tracker.begin(source, "import-1", "a")).not.toBe(id);
});

test("an import that ended without these bytes drops the attempt; a new pairing starts empty", () => {
  const tracker = new ImageUploadTracker(ids());
  tracker.bind(source);
  const id = tracker.begin(source, "import-1", "a") as string;
  tracker.settle(source, "import-1", id, "unknown");
  tracker.observe(source, [observation({ state: "expired" })]);
  expect(tracker.status(source, "import-1")).toBeUndefined();
  const again = tracker.begin(source, "import-2", "a") as string;
  tracker.settle(source, "import-2", again, "unknown");
  tracker.bind("another-instance");
  expect(tracker.hasUnknown).toBe(false);
  expect(tracker.status("another-instance", "import-2")).toBeUndefined();
});

test("an attempt that never left the panel restores the one it replaced", () => {
  const tracker = new ImageUploadTracker(ids());
  tracker.bind(source);
  const first = tracker.begin(source, "import-1", "a") as string;
  tracker.settle(source, "import-1", first, "unknown");
  // Same bytes, refused before sending: still unconfirmed under the same ID.
  const retry = tracker.begin(source, "import-1", "a") as string;
  expect(retry).toBe(first);
  tracker.unsent(source, "import-1", retry);
  expect(tracker.status(source, "import-1")).toMatchObject({ status: "unknown", uploadId: first });
  // Other bytes, refused before sending: the unconfirmed attempt is shown again.
  const other = tracker.begin(source, "import-1", "b") as string;
  tracker.unsent(source, "import-1", other);
  expect(tracker.status(source, "import-1")).toMatchObject({ status: "unknown", uploadId: first });
  expect(tracker.begin(source, "import-1", "a")).toBe(first);
  // A settled attempt is never rolled back by a late unsent.
  tracker.settle(source, "import-1", first, "accepted");
  tracker.unsent(source, "import-1", first);
  expect(tracker.status(source, "import-1")?.status).toBe("accepted");
  // A first attempt that never left leaves nothing behind.
  const fresh = tracker.begin(source, "import-2", "a") as string;
  tracker.unsent(source, "import-2", fresh);
  expect(tracker.status(source, "import-2")).toBeUndefined();
});
