import { expect, test } from "bun:test";
import manifest from "../manifest.json";
import { parsePairingUrl, parseWorkbenchUrl } from "./pairing.ts";

test("extension pairs only a literal loopback workspace URL, never admin/remote/javascript", () => {
  const token = "a".repeat(64);
  expect(parseWorkbenchUrl(` http://127.0.0.1:4318/#session=${token} `)).toBe(
    `http://127.0.0.1:4318/#session=${token}`,
  );
  for (const invalid of [
    `http://localhost:4318/#session=${token}`,
    `http://127.0.0.1:4318/approvals#session=${token}`,
    `http://2130706433:4318/#session=${token}`,
    `http://127.0.0.1.evil:4318/#session=${token}`,
    `https://chatgpt.com/#session=${token}`,
    `http://127.0.0.1:65536/#session=${token}`,
    `http://127.0.0.1:4318/?next=https://evil/#session=${token}`,
    `http://user@127.0.0.1:4318/#session=${token}`,
    "javascript:alert(1)",
    "http://127.0.0.1:4318/",
    `http://127.0.0.1:0/#session=${token}`,
  ])
    expect(() => parseWorkbenchUrl(invalid)).toThrow();
});

test("extension requests session storage and optional loopback only, never chat injection or cookies", () => {
  expect(manifest.permissions).toEqual(["sidePanel", "storage"]);
  expect(manifest.optional_host_permissions).toEqual(["http://127.0.0.1/*"]);
  expect(manifest).not.toHaveProperty("host_permissions");
  expect(manifest).not.toHaveProperty("content_scripts");
  expect(manifest.content_security_policy.extension_pages).toContain("script-src 'self'");
  expect(manifest.content_security_policy.extension_pages).toContain(
    "frame-src http://127.0.0.1:*",
  );
});

test("approval pairing accepts only literal local one-time links", () => {
  const id = crypto.randomUUID();
  const value = `http://127.0.0.1:4318/pair#code=${"a".repeat(64)}&instance=${id}`;
  expect(parsePairingUrl(value)).toEqual({
    origin: "http://127.0.0.1:4318",
    code: "a".repeat(64),
    instanceId: id,
  });
  for (const invalid of [
    value.replace("127.0.0.1", "localhost"),
    value.replace("4318", "65536"),
    value.replace("/pair#", "/approvals#"),
    `${value}&admin=1`,
    value.replace("http:", "https:"),
    value.replace("127.0.0.1", "2130706433"),
    value.replace("code=", "session="),
  ])
    expect(() => parsePairingUrl(invalid)).toThrow();
});
