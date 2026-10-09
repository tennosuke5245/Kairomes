import { expect, test } from "bun:test";
import {
  panelErrorMessage,
  panelRecoveryNotice,
  sameNotice,
  visibleNotice,
} from "./panel-error.ts";

test("late read failures and clear requests preserve the one offline recovery reason", () => {
  for (const message of ["", "結果待確認。", "無法讀取 MCP 狀態。"])
    expect(panelErrorMessage(message, { paired: true, stale: true, approvalUnknown: true })).toBe(
      "本機工作台沒有回應，顯示的是上次內容。",
    );
});

test("unrelated catalog successes cannot hide an unknown approval; re-pairing remains primary", () => {
  for (const message of ["", "無法讀取 MCP 狀態。"])
    expect(panelErrorMessage(message, { paired: true, stale: false, approvalUnknown: true })).toBe(
      "結果待確認。",
    );
  expect(
    panelErrorMessage("配對已失效。", { paired: false, stale: true, approvalUnknown: true }),
  ).toBe("配對已失效。");
  expect(panelErrorMessage("", { paired: true, stale: false, approvalUnknown: false })).toBe("");
});

const base = {
  paired: true,
  needsPairing: false,
  stale: false,
  approvalUnknown: false,
  accessRecovery: false,
  repair: "refresh" as const,
};

test("a stale snapshot offers a reconnect, and unknown results only a status query", () => {
  // The sentence names what is wrong (the 重新連線 action), then what is on screen.
  const stale = panelRecoveryNotice("", { ...base, stale: true });
  expect(stale?.message).toStartWith("本機工作台沒有回應");
  expect(stale?.message).toContain("上次內容");
  expect(panelRecoveryNotice("無法讀取 MCP 狀態。", { ...base, stale: true })).toEqual({
    message: "本機工作台沒有回應，顯示的是上次內容。",
    tone: "warning",
    action: { kind: "refresh", label: "重新連線" },
  });
  expect(
    panelRecoveryNotice("", { ...base, stale: true, approvalUnknown: true })?.action?.label,
  ).toBe("查詢狀態");
  expect(panelRecoveryNotice("", { ...base, approvalUnknown: true })).toEqual({
    message: "結果待確認。",
    tone: "warning",
    action: { kind: "refresh", label: "查詢狀態" },
  });
});

test("an invalid pairing always says so and offers only re-pairing", () => {
  expect(panelRecoveryNotice("", { ...base, paired: false, needsPairing: true })).toEqual({
    message: "配對已失效。",
    tone: "danger",
    action: { kind: "pair", label: "重新配對" },
  });
  expect(
    panelRecoveryNotice("配對已失效。", { ...base, paired: false, needsPairing: true, stale: true })
      ?.action,
  ).toEqual({ kind: "pair", label: "重新配對" });
});

test("an access change that only unpairing can settle offers 解除配對", () => {
  expect(
    panelRecoveryNotice("結果待確認。", { ...base, approvalUnknown: true, accessRecovery: true }),
  ).toEqual({
    message: "結果待確認。",
    tone: "warning",
    action: { kind: "pair", label: "解除配對" },
  });
});

test("other errors are danger with a status query; an empty state clears the slot", () => {
  expect(panelRecoveryNotice("請求未被接受。", base)).toEqual({
    message: "請求未被接受。",
    tone: "danger",
    action: { kind: "refresh", label: "查詢狀態" },
  });
  expect(panelRecoveryNotice("", base)).toBeUndefined();
  expect(panelRecoveryNotice("", { ...base, paired: false })).toBeUndefined();
});

test("one slot: recovery outranks transient notices, and duplicates are recognised", () => {
  const recovery = panelRecoveryNotice("", { ...base, approvalUnknown: true });
  const success = { message: "已複製", tone: "success" as const };
  expect(visibleNotice(recovery, success)).toBe(recovery);
  expect(visibleNotice(undefined, success)).toBe(success);
  expect(sameNotice(recovery, panelRecoveryNotice("", { ...base, approvalUnknown: true }))).toBe(
    true,
  );
  expect(sameNotice(recovery, success)).toBe(false);
  expect(sameNotice(undefined, undefined)).toBe(true);
});
