import { createHash } from "node:crypto";

export type McpOAuthPageOutcome = "connected" | "authorized" | "failed";

const messages = {
  connected: { title: "已連線", detail: "可返回 Kairomes 使用工具。", symbol: "check" },
  authorized: { title: "授權已完成", detail: "請返回 Kairomes 重試連線。", symbol: "pending" },
  failed: { title: "登入未完成", detail: "請返回 Kairomes 重新登入。", symbol: "failed" },
} as const;

const style = `
:root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f1e9;color:#222727}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px}
main{width:min(100%,360px);padding:32px;background:#fffdf8;border:1px solid #dfd6ca;border-radius:20px;box-shadow:0 12px 40px #3027190b}
.brand{display:flex;align-items:center;gap:9px;margin-bottom:28px;font-size:14px;font-weight:600;color:#5d6461}
.brand span{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:#f8eae6;color:#b93443;font-size:19px;font-weight:750}
.symbol{display:grid;place-items:center;width:48px;height:48px;margin-bottom:20px;border-radius:50%;background:#edf3e9;color:#4d7752}
.authorized .symbol{background:#f9f0dd;color:#937127}
.failed .symbol{background:#f9e9e5;color:#b93443}
svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
h1{margin:0;font-size:24px;line-height:1.4;font-weight:700;letter-spacing:-.02em}
p{margin:12px 0 0;font-size:15px;line-height:1.7;color:#606965;overflow-wrap:anywhere}
@media(prefers-color-scheme:dark){:root{background:#181b1a;color:#f1f1e9}main{background:#222725;border-color:#3b433e;box-shadow:none}.brand,p{color:#bdc6be}.brand span{background:#3c282b;color:#ee9da3}.symbol{background:#2c3a2e;color:#b1cfab}.authorized .symbol{background:#3d3522;color:#e3c481}.failed .symbol{background:#422b2c;color:#efadb1}}
`;
const styleHash = createHash("sha256").update(style).digest("base64");
const symbols = {
  check: '<path d="m5 12 4 4L19 6"/>',
  pending: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/>',
  failed: '<path d="m7 7 10 10M17 7 7 17"/>',
} as const;

/** Static callback UI only: never interpolate request URLs, OAuth data or remote errors. */
export function mcpOAuthCallbackResponse(outcome: McpOAuthPageOutcome, status = 200): Response {
  const message = messages[outcome];
  return new Response(
    `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${message.title} · Kairomes</title><style>${style}</style></head><body><main class="${outcome}" aria-labelledby="result-title"><div class="brand"><span aria-hidden="true">K</span>Kairomes</div><div class="symbol" aria-hidden="true"><svg viewBox="0 0 24 24">${symbols[message.symbol]}</svg></div><h1 id="result-title">${message.title}</h1><p>${message.detail}</p></main></body></html>`,
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
