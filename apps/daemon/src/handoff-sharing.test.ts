import { expect, test } from "bun:test";
import { hasPrivateHandoffText } from "./handoff-sharing.ts";

test("handoff permits public documentation references instead of matching a URL scheme as a Windows drive", () => {
  for (const text of [
    "下一步參考 https://developers.openai.com/codex/app/",
    "公開決策來源：http://example.com/spec",
    "公開網址 https://127.0.0.1.example.com/docs",
    "公開網址 https://localhost.example.com/docs",
    "相對檔案 src/main.ts",
  ])
    expect(hasPrivateHandoffText(text)).toBe(false);
});

test("handoff still rejects equivalent loopback addresses after URL and drive parsing are separated", () => {
  for (const text of [
    "http://127.0.0.1:12345/pair",
    "http://127.1:12345/pair",
    "http://2130706433:12345/pair",
    "http://0x7f000001:12345/pair",
    "http://127.0.0.2:12345/pair",
    "http://localhost:12345/pair",
    "http://LOCALHOST.:12345/pair",
    "http://fixture.localhost:12345/pair",
    "http://[::1]:12345/pair",
    "http://[0:0:0:0:0:0:0:1]:12345/pair",
    "http://[::ffff:127.0.0.1]:12345/pair",
    "http://[::ffff:7f00:2]:12345/pair",
    "http://localhost:invalid/pair",
  ])
    expect(hasPrivateHandoffText(text)).toBe(true);
});

test("handoff keeps known credentials and private absolute path rejection", () => {
  for (const text of [
    `合成憑證 sk-proj-${"a".repeat(30)}`,
    "C:/synthetic-private/source.txt",
    "C:\\synthetic-private\\source.txt",
    "路徑 \\\\synthetic-host\\private\\source.txt",
    "來源 /home/synthetic-private/source.txt",
    "來源 /Users/synthetic-private/source.txt",
  ])
    expect(hasPrivateHandoffText(text)).toBe(true);
});
