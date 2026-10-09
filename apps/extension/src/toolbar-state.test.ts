import { expect, test } from "bun:test";
import { actionBadgeText, activeIndicator, connectionView, needButton } from "./toolbar-state.ts";

test("需確認 stays present at zero and only shows a badge for waiting requests", () => {
  expect(needButton(0)).toEqual({ count: "0", badge: "", ariaLabel: "需確認，目前沒有請求" });
  expect(needButton(3)).toEqual({ count: "3", badge: "3", ariaLabel: "需確認 3 件" });
  expect(needButton(140).badge).toBe("99+");
  expect(needButton(-1).count).toBe("0");
});

test("執行中 appears only while work runs", () => {
  expect(activeIndicator(0).hidden).toBe(true);
  expect(activeIndicator(2)).toEqual({ hidden: false, badge: "2", ariaLabel: "執行中 2 項" });
});

test("the browser toolbar badge counts only decisions the panel can act on", () => {
  expect(actionBadgeText(3, true)).toBe("3");
  expect(actionBadgeText(3, false)).toBe("");
  expect(actionBadgeText(0, true)).toBe("");
  expect(actionBadgeText(120, true)).toBe("99+");
});

test("every connection state has a tone and a text label, never colour alone", () => {
  expect(connectionView("connected")).toEqual({ tone: "success", label: "已連線", pulse: false });
  expect(connectionView("reconnecting")).toEqual({
    tone: "running",
    label: "重新連線中",
    pulse: true,
  });
  expect(connectionView("connecting")).toEqual({ tone: "running", label: "連線中", pulse: true });
  expect(connectionView("invalid")).toMatchObject({ tone: "danger", label: "配對已失效" });
  expect(connectionView("unpaired")).toMatchObject({ tone: "neutral", label: "未配對" });
  expect(connectionView("browse")).toMatchObject({ tone: "neutral", label: "僅可瀏覽" });
});
