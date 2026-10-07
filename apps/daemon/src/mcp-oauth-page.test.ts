import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mcpOAuthCallbackResponse } from "./mcp-oauth-page.ts";

test("回呼頁區分授權與工具可用，只回靜態內容並禁止外部請求", async () => {
  for (const [outcome, title, tone] of [
    ["connected", "已連線", "success"],
    ["authorized", "授權已完成", "neutral"],
    ["failed", "登入未完成", "danger"],
  ] as const) {
    const response = mcpOAuthCallbackResponse(outcome, outcome === "failed" ? 400 : 200);
    const html = await response.text();
    expect(response.status).toBe(outcome === "failed" ? 400 : 200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(html).toContain(`<h1 id="result-title">${title}</h1>`);
    expect(html).toContain(`data-tone="${tone}"`);
    expect(html).toContain('lang="zh-Hant-TW"');
    expect(html).not.toMatch(
      /<script|\b(?:href|src)=|url\(|@import|access_token|refresh_token|redirect_uri|error_description/,
    );
    // One inline stylesheet, allowed by its hash; no inline style attributes.
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
    expect(styles).toHaveLength(1);
    expect(html).not.toMatch(/\sstyle=/);
    const css = styles[0]?.[1] ?? "";
    const hash = createHash("sha256").update(css).digest("base64");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      `default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    expect(html.includes("使用工具")).toBe(outcome === "connected");
  }
});

test("回呼頁使用共用 token、K 標誌與深色主題，文字不小於 14px", async () => {
  const html = await mcpOAuthCallbackResponse("connected").text();
  const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  expect(css).toContain("--k-bg:");
  expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/);
  // The K mark is inline SVG filled with the brand-mark token (same shape as app-icon.svg).
  expect(html).toContain('<svg class="mark" viewBox="0 0 128 128"');
  expect(css).toContain(".mark{width:20px;height:20px;fill:var(--k-brand-mark)}");
  // Page rules only use tokens for colour and never set a size below the 14px base.
  const page = css.slice(css.lastIndexOf("*,*::before"));
  expect(page).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  for (const [, size] of page.matchAll(/font(?:-size)?:([^;}]+)/g))
    expect(size).not.toMatch(/(?:^|[\s/])(?:1[0-3]|[0-9])px/);
  expect(html).not.toMatch(/KAIROMES|LOCAL|OAuth callback/);
});
