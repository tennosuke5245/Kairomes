import { expect, test } from "bun:test";
import { validExtensionId } from "./extension-id.ts";

test("accepts only Chrome-style extension ids", () => {
  expect(validExtensionId("abcdefghijklmnopabcdefghijklmnop")).toBe(true);
  expect(validExtensionId("chrome-extension-id")).toBe(false);
  expect(validExtensionId(undefined)).toBe(false);
});
