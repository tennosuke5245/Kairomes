import { expect, test } from "bun:test";
import type { ArtifactImportApproval } from "@kairomes/protocol";
import {
  decodedMatches,
  previewKey,
  previewNeeded,
  previewProblemText,
  previewReady,
  previewScale,
  verifyPreview,
} from "./image-preview.ts";

const pending = {
  id: "import-1",
  fingerprint: "f1",
  state: "pending",
  version: "a".repeat(64),
  byte_size: 100,
  mime_type: "image/png",
  width: 40,
  height: 30,
} satisfies Partial<ArtifactImportApproval>;
const header = { mime: "image/png" as const, width: 40, height: 30, animated: false };
const received = { size: 100, type: "image/png", sha256: "a".repeat(64), header };

test("匯入圖片 needs a verified preview of exactly the current pending content", () => {
  const key = previewKey(pending);
  expect(previewReady({ status: "ready", key }, pending)).toBe(true);
  expect(previewReady({ status: "loading", key }, pending)).toBe(false);
  expect(previewReady({ status: "idle" }, pending)).toBe(false);
  // New bytes or a new fingerprint is new content: the old preview no longer counts.
  for (const changed of [
    { ...pending, fingerprint: "f2" },
    { ...pending, version: "b".repeat(64) },
    { ...pending, byte_size: 101 },
  ])
    expect(previewReady({ status: "ready", key }, changed)).toBe(false);
  expect(previewReady({ status: "ready", key }, { ...pending, state: "awaiting_file" })).toBe(
    false,
  );
});

test("a preview loads once per content and never before the bytes are verified", () => {
  const key = previewKey(pending);
  expect(previewNeeded({ status: "idle" }, pending)).toBe(true);
  expect(previewNeeded({ status: "loading", key }, pending)).toBe(false);
  expect(previewNeeded({ status: "failed", key, problem: "hash" }, pending)).toBe(false);
  expect(previewNeeded({ status: "ready", key }, { ...pending, fingerprint: "f2" })).toBe(true);
  expect(
    previewNeeded({ status: "idle" }, { ...pending, state: "awaiting_file", version: null }),
  ).toBe(false);
});

test("received bytes must match size, format, full SHA-256 and pixel size", () => {
  expect(verifyPreview(pending, received)).toBeUndefined();
  expect(
    verifyPreview(pending, { ...received, type: "image/png; charset=binary" }),
  ).toBeUndefined();
  expect(verifyPreview(pending, { ...received, size: 99 })).toBe("size");
  expect(verifyPreview(pending, { ...received, type: "text/html" })).toBe("type");
  expect(verifyPreview(pending, { ...received, header: { ...header, mime: "image/jpeg" } })).toBe(
    "type",
  );
  expect(verifyPreview(pending, { ...received, header: undefined })).toBe("type");
  // Same 12-character prefix is not enough: the full hash is compared.
  expect(
    verifyPreview(pending, { ...received, sha256: `${"a".repeat(12)}${"b".repeat(52)}` }),
  ).toBe("hash");
  expect(verifyPreview(pending, { ...received, header: { ...header, width: 41 } })).toBe(
    "dimensions",
  );
  expect(verifyPreview({ ...pending, version: null }, received)).toBe("gone");
});

test("decode checks allow an EXIF quarter turn; large images decode scaled down", () => {
  expect(decodedMatches(pending, { width: 40, height: 30 })).toBe(true);
  expect(decodedMatches(pending, { width: 30, height: 40 })).toBe(true);
  expect(decodedMatches(pending, { width: 40, height: 31 })).toBe(false);
  expect(previewScale(1200, 750)).toBeUndefined();
  expect(previewScale(4096, 2048)).toEqual({ resizeWidth: 2048 });
  expect(previewScale(1000, 5000)).toEqual({ resizeHeight: 2048 });
  expect(previewProblemText("network")).toContain("重新載入");
  expect(previewProblemText("hash")).toContain("不能匯入");
});
