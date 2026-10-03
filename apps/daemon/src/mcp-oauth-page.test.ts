import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mcpOAuthCallbackResponse } from "./mcp-oauth-page.ts";

test("回呼頁區分授權與工具可用，只回靜態內容並禁止外部請求", async () => {
  for (const [outcome, title] of [
    ["connected", "已連線"],
    ["authorized", "授權已完成"],
    ["failed", "登入未完成"],
  ] as const) {
    const response = mcpOAuthCallbackResponse(outcome, outcome === "failed" ? 400 : 200);
    const html = await response.text();
    expect(response.status).toBe(outcome === "failed" ? 400 : 200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(html).toContain(`<h1 id="result-title">${title}</h1>`);
    expect(html).toContain('lang="zh-Hant"');
    expect(html).not.toMatch(
      /<script|\b(?:href|src)=|access_token|refresh_token|redirect_uri|error_description/,
    );
    const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const hash = createHash("sha256").update(css).digest("base64");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      `default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    expect(html.includes("使用工具")).toBe(outcome === "connected");
  }
});
