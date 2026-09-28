import { expect, test } from "bun:test";
import { publicError } from "./index.ts";

test("normalizes common local failures without exposing raw paths", () => {
  expect(publicError(Object.assign(new Error("C:\\private\\file"), { code: "ENOENT" }))).toEqual({
    code: "PATH_NOT_FOUND",
    message: "找不到指定的檔案或資料夾，請確認路徑後再試。",
  });
  expect(publicError(Object.assign(new Error(), { code: "EADDRINUSE" }))).toMatchObject({
    code: "PORT_UNAVAILABLE",
  });
  expect(publicError(Object.assign(new Error(), { code: "SQLITE_BUSY" }))).toMatchObject({
    code: "STATE_BUSY",
  });
});
