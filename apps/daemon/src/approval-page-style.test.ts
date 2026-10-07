import { expect, test } from "bun:test";
import { approvalPage } from "./approval-page.ts";

test("the legacy approval page uses the shared tokens in light and dark", () => {
  expect(approvalPage).toContain('lang="zh-Hant-TW"');
  expect(approvalPage).toContain("--k-bg:");
  expect(approvalPage).toMatch(/@media \(prefers-color-scheme: dark\)/);
  // The dark-only palette and the English eyebrow are gone.
  expect(approvalPage).not.toMatch(/color-scheme:dark|#151817|#c7e9ae|KAIROMES \/ LOCAL/);
  const css = approvalPage.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  const page = css.slice(css.lastIndexOf("*,*::before"));
  expect(page).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  // Host privilege is stated plainly; nothing claims isolation.
  expect(approvalPage).toContain("主機權限 · 可操作工作區外 · 可連網");
  expect(approvalPage).toContain("沒有隔離");
  expect(approvalPage).not.toMatch(/sandbox|沙箱|只限此聊天/);
});

test("the diff renders as rows through textContent and a truncated diff is not approvable", () => {
  const script = approvalPage.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  expect(script).not.toContain("<pre");
  expect(script).toContain("row.dataset.kind = entry.kind");
  expect(script).toContain("diffRows(text, files)");
  expect(script).toContain("quoted(value)");
  expect(script).toContain("session.diff_truncated) button.disabled = true");
  expect(script).toContain("if (!event.isTrusted) return;");
});
