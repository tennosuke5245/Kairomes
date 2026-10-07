import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BaselineDetails, HandoffFlow, HandoffStepper, SessionList } from "./handoff-flow.tsx";
import { handoffSteps } from "./handoff-model.ts";

// Static markup only: effects never run, so no request is sent and no draft is created.
const NOW = new Date(2026, 9, 6, 15, 12, 0).getTime();
const WORKSPACE = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "接續測試專案",
  capabilities: ["read", "write_request"] as ("read" | "write_request")[],
};
const noop = () => undefined;
const never = () => new Promise<never>(() => undefined);

test("the handoff page has one title, a nowrap back button and the three-step stepper", () => {
  const markup = renderToStaticMarkup(
    <HandoffFlow workspace={WORKSPACE} onClose={noop} request={never} />,
  );
  expect(markup.match(/<h1/g)).toHaveLength(1);
  expect(markup).toContain("從 Codex 接續 · 接續測試專案");
  expect(markup).toContain("handoff-back");
  expect(markup).toContain("返回專案");
  expect(markup).toContain('class="k-stepper handoff-stepper"');
  expect(markup).toContain('aria-current="step"');
  expect(markup).toContain("步驟 1／3：選擇來源");
  // Two source cards; no form and no copy before a source is chosen.
  expect(markup).toContain("讀取 Codex 紀錄");
  expect(markup).toContain("手動建立摘要");
  expect(markup).not.toContain("複製接續內容");
  expect(markup).not.toContain("<textarea");
  // Without a host slot the flow keeps its own polite and alert regions.
  expect(markup).toContain('role="status"');
  expect(markup).toContain('role="alert"');
});

test("a host slot replaces the flow's own notice regions", () => {
  const markup = renderToStaticMarkup(
    <HandoffFlow
      workspace={WORKSPACE}
      onClose={noop}
      request={never}
      notify={noop}
      slot={<p id="host-slot">slot</p>}
    />,
  );
  expect(markup).toContain('id="host-slot"');
  expect(markup).not.toContain('role="alert"');
});

test("done steps carry an icon and a spoken 已完成, never a text glyph", () => {
  const markup = renderToStaticMarkup(<HandoffStepper steps={handoffSteps("preview", false)} />);
  expect(markup.match(/data-state="done"/g)).toHaveLength(2);
  expect(markup.match(/（已完成）/g)).toHaveLength(2);
  expect(markup).toContain("<svg");
  expect(markup).not.toMatch(/[✓✔]/);
  expect(markup.match(/k-stepper__sep/g)).toHaveLength(2);
});

test("source rows show the title, a relative time and the source state", () => {
  const markup = renderToStaticMarkup(
    <SessionList
      sessions={[
        {
          id: "s1",
          provider: "codex",
          title: "待處理列表調整",
          updatedAt: (NOW - 5 * 60_000) / 1000,
          sourceStatus: "idle",
        },
        {
          id: "s2",
          provider: "codex",
          title: "搜尋狀態調整",
          updatedAt: (NOW - 30_000) / 1000,
          sourceStatus: "inProgress",
        },
      ]}
      hasNextPage={false}
      busy={null}
      now={NOW}
      onSelect={noop}
    />,
  );
  expect(markup).toContain("5 分鐘前");
  expect(markup).toContain("30 秒前");
  expect(markup).toContain("閒置");
  expect(markup).toContain('data-tone="running"');
  // No seconds-precision clock time.
  expect(markup).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
  const empty = renderToStaticMarkup(
    <SessionList sessions={[]} hasNextPage={false} busy={null} now={NOW} onSelect={noop} />,
  );
  expect(empty).toContain("沒有這個專案的 Codex 紀錄");
});

test("the baseline summary names the state with an icon and lists versions behind a disclosure", () => {
  const markup = renderToStaticMarkup(
    <BaselineDetails
      baseline={{
        captured_at: "2026-10-06T07:12:00.000Z",
        complete: false,
        total_bytes: 10,
        files: [
          {
            path: "src/main.ts",
            state: "supported",
            version: "abcdef0123456789",
            bytes: 10,
            reason: null,
          },
          {
            path: "missing.ts",
            state: "unknown",
            version: null,
            bytes: null,
            reason: "找不到檔案",
          },
        ],
        git: { state: "unavailable", head: null, branch: null, dirty: [], truncated: false },
      }}
    />,
  );
  expect(markup).toContain("<details");
  expect(markup).toContain("基準不完整，僅供核對 · 2 個檔案");
  expect(markup).toContain('data-tone="warning"');
  expect(markup).toContain("abcdef012345");
  expect(markup).not.toContain("abcdef0123456789");
  expect(markup).toContain("找不到檔案");
  expect(markup).toContain("無法用 Git 核對。");
});
