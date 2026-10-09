import { expect, test } from "bun:test";
import { PROFILE_ACK_KEY, readFlag, writeFlag } from "./prefs.ts";

const OTHER_KEY = "kairomes.desktop.synthetic";

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}
const broken = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

test("a flag reads unset until written, and only the value 1 counts", () => {
  const store = memory();
  expect(readFlag(OTHER_KEY, store)).toBe(false);
  writeFlag(OTHER_KEY, store);
  expect(readFlag(OTHER_KEY, store)).toBe(true);
  expect(readFlag(PROFILE_ACK_KEY, store)).toBe(false);
  store.setItem(PROFILE_ACK_KEY, "true");
  expect(readFlag(PROFILE_ACK_KEY, store)).toBe(false);
});

test("missing or throwing storage reads as unset and never throws", () => {
  expect(readFlag(OTHER_KEY, null)).toBe(false);
  expect(readFlag(OTHER_KEY, broken)).toBe(false);
  expect(() => writeFlag(OTHER_KEY, broken)).not.toThrow();
  expect(() => writeFlag(OTHER_KEY, null)).not.toThrow();
});
