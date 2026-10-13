import { expect, test } from "bun:test";
import type { ImageImportHydrationDetail } from "@kairomes/protocol";
import {
  importHydrationDetailText,
  importHydrationText,
  panelView,
  settingsBackLabel,
} from "./panel-view.ts";

const closed = { settingsOpen: false, approvalsOpen: false, hasWorkbench: true, frameLoaded: true };

test("one body view at a time, with settings and approvals replacing the workbench", () => {
  expect(panelView(closed)).toBe("workbench");
  expect(panelView({ ...closed, approvalsOpen: true })).toBe("approvals");
  expect(panelView({ ...closed, settingsOpen: true, approvalsOpen: true })).toBe("settings");
  expect(panelView({ ...closed, hasWorkbench: false, frameLoaded: false })).toBe("setup");
  expect(panelView({ ...closed, hasWorkbench: false, settingsOpen: true })).toBe("settings");
});

test("a known workbench that is not loaded shows the empty state, not a blank body", () => {
  expect(panelView({ ...closed, frameLoaded: false })).toBe("empty");
});

test("settings return to the workbench or to pairing", () => {
  expect(settingsBackLabel(true)).toBe("返回工作台");
  expect(settingsBackLabel(false)).toBe("返回配對");
});

test("image import diagnostics appear only once ChatGPT made a request", () => {
  expect(importHydrationText(undefined)).toBeUndefined();
  expect(importHydrationText({ hydrated: 0, omitted: 0, rejected: 0 })).toBeUndefined();
  expect(importHydrationText({ hydrated: 2, omitted: 1, rejected: 0 })).toBe(
    "圖片匯入請求：附圖 2 · 未附圖 1 · 被拒 0",
  );
});

function emptyDetail(): ImageImportHydrationDetail {
  return {
    rejected: { sandbox_path: 0, non_https: 0, host_not_allowed: 0, malformed: 0, length: 0 },
    created: 0,
    retried: 0,
    download_attempts: 0,
    download_results: {
      ok: 0,
      dns: 0,
      unsafe_address: 0,
      http_4xx: 0,
      http_5xx: 0,
      empty: 0,
      network: 0,
      redirect: 0,
      timeout: 0,
      not_image: 0,
      too_large: 0,
      cancelled: 0,
    },
    verify_failed: {
      extension_mismatch: 0,
      invalid_image: 0,
      dimensions: 0,
      animated: 0,
      other: 0,
    },
  };
}

test("image delivery details list only non-zero counts and stay hidden while all are 0", () => {
  expect(importHydrationDetailText(undefined)).toBeUndefined();
  expect(importHydrationDetailText(emptyDetail())).toBeUndefined();

  const detail = emptyDetail();
  detail.created = 1;
  detail.retried = 1;
  detail.download_attempts = 2;
  detail.download_results.ok = 1;
  detail.download_results.http_4xx = 1;
  detail.rejected.sandbox_path = 1;
  detail.verify_failed.extension_mismatch = 1;
  expect(importHydrationDetailText(detail)).toBe(
    "交付細節：建立 1 · 重送 1 · 下載 2（成功 1 · HTTP 4xx 1）· 被拒：沙箱路徑 1 · 驗證失敗：副檔名不符 1",
  );

  const rejectedOnly = emptyDetail();
  rejectedOnly.rejected.non_https = 2;
  rejectedOnly.rejected.host_not_allowed = 1;
  expect(importHydrationDetailText(rejectedOnly)).toBe(
    "交付細節：被拒：非 HTTPS 2、網域不在清單 1",
  );

  // A download still in progress has an attempt but no result yet.
  const inFlight = emptyDetail();
  inFlight.created = 1;
  inFlight.download_attempts = 1;
  expect(importHydrationDetailText(inFlight)).toBe("交付細節：建立 1 · 下載 1");

  const failures = emptyDetail();
  failures.download_attempts = 3;
  failures.download_results.dns = 1;
  failures.download_results.timeout = 1;
  failures.download_results.ok = 1;
  failures.verify_failed.animated = 1;
  failures.verify_failed.other = 1;
  expect(importHydrationDetailText(failures)).toBe(
    "交付細節：下載 3（成功 1 · DNS 1 · 逾時 1）· 驗證失敗：動畫 1、其他 1",
  );
});
