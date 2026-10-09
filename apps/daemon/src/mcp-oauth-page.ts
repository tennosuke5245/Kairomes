import { createHash } from "node:crypto";
import { tokensCss } from "../../../packages/ui-tokens/index.ts";

export type McpOAuthPageOutcome = "connected" | "authorized" | "failed";

// Phosphor 2.1.10 (regular) path data, inlined: the page loads nothing from anywhere.
const icons = {
  check:
    "M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z",
  info: "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm16-40a8,8,0,0,1-8,8,16,16,0,0,1-16-16V128a8,8,0,0,1,0-16,16,16,0,0,1,16,16v40A8,8,0,0,1,144,176ZM112,84a12,12,0,1,1,12,12A12,12,0,0,1,112,84Z",
  warning:
    "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,172Z",
} as const;

// One status sentence and one next step; the server name, URLs and remote errors never
// appear, because this page is static and identical for every MCP server.
const messages = {
  connected: {
    tone: "success",
    icon: icons.check,
    title: "已連線",
    detail: "可以關閉這個分頁，回到 Kairomes 使用工具。",
  },
  authorized: {
    tone: "neutral",
    icon: icons.info,
    title: "授權已完成",
    detail: "回到 Kairomes 側欄，按「重試」取得工具。",
  },
  failed: {
    tone: "danger",
    icon: icons.warning,
    title: "登入未完成",
    detail: "回到 Kairomes 側欄再試一次。",
  },
} as const;

/** The K mark from app-icon.svg; its fill follows --k-brand-mark in both themes. */
const kMark =
  '<svg class="mark" viewBox="0 0 128 128" aria-hidden="true" focusable="false"><path d="M22 16c-6 0-10 4-10 10v76c0 6 4 10 10 10s10-4 10-10V26c0-6-4-10-10-10Z"/><path d="M106 16H84c-3 0-6 1-8 4L38 57c-4 4-4 10 0 14l39 37c2 3 5 4 8 4h21c4 0 7-2 8-5 1-3 0-6-2-8L73 64l38-35c3-2 4-6 2-9-1-2-4-4-7-4Z"/></svg>';

// tokens.css (light, dark via prefers-color-scheme) plus the few rules this card needs.
const style = `${tokensCss}
*,*::before,*::after{box-sizing:border-box}
body{display:grid;min-height:100svh;margin:0;padding:24px 16px;place-items:center;background:var(--k-bg);color:var(--k-ink-1);font:var(--k-text-base)/1.5 var(--k-font-sans)}
main{width:min(100%,480px);padding:24px;border:1px solid var(--k-line);border-radius:var(--k-radius-lg);background:var(--k-surface);box-shadow:var(--k-shadow-1),var(--k-inset-hi)}
.brand{display:flex;align-items:center;gap:8px;margin:0 0 20px;color:var(--k-ink-2);font-weight:var(--k-weight-strong)}
.mark{width:20px;height:20px;fill:var(--k-brand-mark)}
.status{display:grid;grid-template-columns:40px minmax(0,1fr);gap:4px 14px;align-items:center;padding:14px 16px;border:1px solid var(--tone-line);border-radius:var(--k-radius-md);background:var(--tone-soft)}
.icon{display:grid;grid-row:span 2;place-items:center;width:40px;height:40px;border-radius:50%;background:var(--k-surface);color:var(--tone)}
.icon svg{width:24px;height:24px;fill:currentColor}
h1{margin:0;color:var(--tone-on);font-size:var(--k-text-lg);font-weight:var(--k-weight-strong);line-height:var(--k-leading-tight)}
p{margin:0;color:var(--k-ink-2);overflow-wrap:anywhere}
`;
const styleHash = createHash("sha256").update(style).digest("base64");

/** Static callback UI only: never interpolate request URLs, OAuth data or remote errors. */
export function mcpOAuthCallbackResponse(outcome: McpOAuthPageOutcome, status = 200): Response {
  const message = messages[outcome];
  return new Response(
    `<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${message.title} · Kairomes</title><style>${style}</style></head><body><main class="${outcome}" aria-labelledby="result-title"><p class="brand">${kMark}Kairomes</p><div class="status" data-tone="${message.tone}"><span class="icon" aria-hidden="true"><svg viewBox="0 0 256 256" focusable="false"><path d="${message.icon}"/></svg></span><h1 id="result-title">${message.title}</h1><p>${message.detail}</p></div></main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      },
    },
  );
}
