import { expect, test } from "bun:test";
import {
  addProjectsNotice,
  clearNotice,
  errorText,
  type Notice,
  nextNotice,
  noticeRole,
  STATUS_ERROR_TEXT,
} from "./notice.ts";

const statusError: Notice = { tone: "warning", text: STATUS_ERROR_TEXT, source: "status" };

test("a repeated status error keeps the same message instead of raising it again", () => {
  const first = nextNotice(null, statusError);
  // Every poll fails with the same text; the slot keeps the original object (X10).
  expect(nextNotice(first, { ...statusError })).toBe(first);
  const other: Notice = { tone: "danger", text: "無法啟動安全通道。", source: "action" };
  expect(nextNotice(first, other)).toBe(other);
  expect(nextNotice(other, null)).toBeNull();
});

test("recovery clears only the message of its own source", () => {
  expect(clearNotice(statusError, "status")).toBeNull();
  const action: Notice = { tone: "success", text: "已掛載「Athori」。", source: "action" };
  expect(clearNotice(action, "status")).toBe(action);
  expect(clearNotice(null, "status")).toBeNull();
});

test("only danger interrupts; success is never announced as an alert", () => {
  expect(noticeRole("danger")).toBe("alert");
  expect(noticeRole("success")).toBe("status");
  expect(noticeRole("warning")).toBe("status");
  expect(noticeRole("neutral")).toBe("status");
});

test("action failures use the host's text or a fixed fallback", () => {
  expect(errorText(new Error("找不到這個專案。"), "操作沒有完成。")).toBe("找不到這個專案。");
  expect(errorText("金鑰格式不正確。", "操作沒有完成。")).toBe("金鑰格式不正確。");
  expect(errorText({ code: 1 }, "操作沒有完成。")).toBe("操作沒有完成。");
  expect(errorText(new Error(""), "操作沒有完成。")).toBe("操作沒有完成。");
});

test("adding several folders reports one message with the first host error", () => {
  expect(addProjectsNotice(["Athori"], [])).toEqual({
    tone: "success",
    text: "已加入「Athori」。",
    source: "action",
  });
  expect(addProjectsNotice(["Athori", "Lumen Notes", "Docs"], []).text).toBe("已加入 3 個專案。");
  expect(addProjectsNotice(["Athori"], ["這個資料夾已經加入。"])).toEqual({
    tone: "warning",
    text: "已加入 1 個專案；1 個資料夾沒有加入：這個資料夾已經加入。",
    source: "action",
  });
  expect(addProjectsNotice([], ["請選擇資料夾。"])).toEqual({
    tone: "danger",
    text: "請選擇資料夾。",
    source: "action",
  });
  expect(addProjectsNotice([], ["請選擇資料夾。", "請選擇資料夾。"]).text).toBe(
    "2 個資料夾都沒有加入：請選擇資料夾。",
  );
});
