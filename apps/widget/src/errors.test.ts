import { expect, test } from "bun:test";
import { friendlyError } from "./errors.ts";
import { ResultError } from "./tool-result.ts";

const fallback = "無法讀取命令結果。";

test("class names and String(cause) never reach the UI", () => {
  const cause = new ResultError("合成命令不存在。", "SOMETHING_ELSE");
  expect(String(cause)).toStartWith("ResultError:");
  expect(friendlyError(cause, fallback)).toBe("合成命令不存在。");
  expect(friendlyError("ResultError: 終端機回應格式不符。", fallback)).toBe("終端機回應格式不符。");
  expect(friendlyError(new TypeError("TypeError: 讀取失敗"), fallback)).toBe("讀取失敗");
  for (const value of [
    friendlyError(cause, fallback),
    friendlyError(String(cause), fallback),
    friendlyError(new Error(String(new Error("內部錯誤"))), fallback),
  ])
    expect(value).not.toMatch(/Error:/);
});

test("known codes map to fixed sentences", () => {
  expect(friendlyError(new ResultError("raw", "RESULT_EXPIRED"), fallback)).toBe("詳情已到期。");
  expect(friendlyError(new ResultError("x", "TERMINAL_NOT_FOUND"), fallback)).toContain("終端機");
});

test("technical, English, multi-line, URL and path messages fall back", () => {
  expect(friendlyError(new TypeError("Failed to fetch"), fallback)).toBe(fallback);
  expect(friendlyError(new Error("連線失敗：https://127.0.0.1:4318/api"), fallback)).toBe(fallback);
  expect(friendlyError(new Error("找不到 C:\\Users\\mei\\project"), fallback)).toBe(fallback);
  expect(friendlyError(new Error("找不到 /home/mei/project/src"), fallback)).toBe(fallback);
  expect(friendlyError(new Error("第一行\n第二行"), fallback)).toBe(fallback);
  expect(friendlyError(new Error("錯".repeat(200)), fallback)).toBe(fallback);
  expect(friendlyError(undefined, fallback)).toBe(fallback);
  expect(friendlyError({ message: "物件" }, fallback)).toBe(fallback);
  expect(friendlyError(new Error(""), fallback)).toBe(fallback);
});

test("short Traditional Chinese daemon copy with relative paths passes through", () => {
  expect(friendlyError(new Error("最多同時保留 4 個等待或執行中的命令。"), fallback)).toBe(
    "最多同時保留 4 個等待或執行中的命令。",
  );
  expect(friendlyError(new Error("找不到 src/main.ts"), fallback)).toBe("找不到 src/main.ts");
});
