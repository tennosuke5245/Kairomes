import type { CompanionStatus } from "@kairomes/protocol";
import { tokensCss } from "../../../packages/ui-tokens/index.ts";

/**
 * The Companion page (spec §5.5): one 480px card on the shared tokens, light and dark from the
 * OS. A status rail states each fact once; there is no hero, slogan or English eyebrow. The
 * page is static: the only interpolated value is the version, and the script is inlined so the
 * Companion's CSP can hash it. Status arrives later from /api/status with the session token.
 */

export type CompanionRailTone = "success" | "running" | "warning" | "danger" | "neutral" | "brand";
export type CompanionRailRow = {
  id: "workbench" | "tunnel" | "chatgpt" | "projects" | "mcp" | "panel";
  name: string;
  tone: CompanionRailTone;
  state: string;
  /** One sentence, only when the row needs the user; empty otherwise. */
  detail: string;
  /** Quiet when the row is healthy and the action is optional (停止, 重試工作台). */
  action: { action: string; label: string; quiet?: boolean } | null;
};
/** Enabled and configured MCP servers; undefined before the first read, null when unreadable. */
export type CompanionMcpSummary = { enabled: number; total: number } | null | undefined;
export type CompanionRailStatus = Pick<
  CompanionStatus,
  "workbench" | "tunnel" | "connector" | "workspaces" | "extension"
> & {
  versionMismatch?: boolean;
  attention?: { pairedPanels?: number | null } | null;
};

/**
 * The status rail: 本機工作台 · 安全通道 · ChatGPT · 專案 · MCP · 瀏覽器側欄, each with one state and
 * at most one action. Pure and self-contained (no outside references), because its source is
 * also inlined into the page script; keep it that way.
 */
export function companionRail(
  status: CompanionRailStatus,
  mcp: CompanionMcpSummary,
): CompanionRailRow[] {
  const workbench = status.workbench;
  const tunnel = status.tunnel;
  const workbenchReady = workbench.state === "running" || workbench.state === "external";
  let workbenchRow: CompanionRailRow;
  if (workbenchReady && status.versionMismatch)
    workbenchRow = {
      id: "workbench",
      name: "本機工作台",
      tone: "warning",
      state: "版本不同",
      detail: "工作台與這個 Kairomes 版本不同；停止舊程序後再重試工作台。",
      action: { action: "retry_workbench", label: "重試工作台" },
    };
  else if (workbench.state === "running")
    workbenchRow = {
      id: "workbench",
      name: "本機工作台",
      tone: "success",
      state: "執行中",
      detail: "",
      action: null,
    };
  else if (workbench.state === "external")
    workbenchRow = {
      id: "workbench",
      name: "本機工作台",
      tone: "success",
      state: "執行中",
      detail: "沿用先前啟動的工作台。",
      action: { action: "retry_workbench", label: "重試工作台", quiet: true },
    };
  else if (workbench.state === "starting")
    workbenchRow = {
      id: "workbench",
      name: "本機工作台",
      tone: "running",
      state: "正在啟動",
      detail: "",
      action: null,
    };
  else
    workbenchRow = {
      id: "workbench",
      name: "本機工作台",
      tone: workbench.state === "error" ? "danger" : "warning",
      state: workbench.state === "error" ? "需要處理" : "已停止",
      detail: workbench.message,
      action: {
        action: "retry_workbench",
        label: workbench.state === "error" ? "重試" : "重新啟動",
      },
    };

  let tunnelRow: CompanionRailRow;
  if (tunnel.state === "running")
    tunnelRow = {
      id: "tunnel",
      name: "安全通道",
      tone: "success",
      state: "執行中",
      detail: "",
      action: { action: "stop_tunnel", label: "停止", quiet: true },
    };
  else if (tunnel.state === "starting")
    tunnelRow = {
      id: "tunnel",
      name: "安全通道",
      tone: "running",
      state: "正在啟動",
      detail: "",
      action: null,
    };
  else if (tunnel.state === "stopped")
    tunnelRow = {
      id: "tunnel",
      name: "安全通道",
      tone: "neutral",
      // Same words as Desktop 連線設定 and 疑難排解 for the same state.
      state: "已暫停",
      detail: "",
      action: { action: "start_tunnel", label: "啟動" },
    };
  else if (tunnel.state === "missing")
    tunnelRow = {
      id: "tunnel",
      name: "安全通道",
      tone: "warning",
      state: "找不到 tunnel-client",
      detail: tunnel.message,
      action: null,
    };
  else if (tunnel.nextRetryAt)
    tunnelRow = {
      id: "tunnel",
      name: "安全通道",
      tone: "warning",
      state: "稍後自動重試",
      detail: tunnel.message,
      action: { action: "restart_tunnel", label: "立即重試" },
    };
  else
    tunnelRow = {
      id: "tunnel",
      name: "安全通道",
      tone: "danger",
      state: "中斷",
      detail: tunnel.message,
      // A rejected key or a missing profile is not fixed by a restart; the sentence says what is.
      action:
        tunnel.reason === "auth" || tunnel.reason === "profile_missing"
          ? null
          : { action: "restart_tunnel", label: "重新啟動" },
    };

  const connector = status.connector;
  const chatgptRow: CompanionRailRow =
    connector.state === "connected"
      ? {
          id: "chatgpt",
          name: "ChatGPT",
          tone: "success",
          state: "已連上",
          detail: "",
          action: null,
        }
      : connector.state === "waiting"
        ? {
            id: "chatgpt",
            name: "ChatGPT",
            tone: "brand",
            state: "等待 ChatGPT",
            detail: "請在 ChatGPT 重新整理連接器。",
            action: { action: "open_connectors", label: "開啟 ChatGPT 設定" },
          }
        : {
            id: "chatgpt",
            name: "ChatGPT",
            tone: "neutral",
            state: "尚未連線",
            detail: "",
            action: null,
          };

  const count = status.workspaces.length;
  const projectsRow: CompanionRailRow = count
    ? {
        id: "projects",
        name: "專案",
        tone: "neutral",
        state: `${count} 個`,
        detail: "",
        action: null,
      }
    : {
        id: "projects",
        name: "專案",
        tone: "warning",
        state: "尚未加入",
        detail: "加入一個資料夾，ChatGPT 才能讀取。",
        action: null,
      };

  const mcpRow: CompanionRailRow =
    mcp === undefined
      ? { id: "mcp", name: "MCP", tone: "neutral", state: "讀取中", detail: "", action: null }
      : mcp === null
        ? {
            id: "mcp",
            name: "MCP",
            tone: "warning",
            state: "設定無法讀取",
            detail: "請到瀏覽器側欄的 MCP 整合檢查設定。",
            action: null,
          }
        : {
            id: "mcp",
            name: "MCP",
            tone: "neutral",
            state: mcp.total ? `${mcp.enabled}／${mcp.total} 已開啟` : "未設定",
            detail: "",
            action: null,
          };

  const paired = status.attention ? status.attention.pairedPanels : null;
  const panelRow: CompanionRailRow = !status.extension.configured
    ? {
        id: "panel",
        name: "瀏覽器側欄",
        tone: "neutral",
        state: "尚未配對",
        detail: "從側欄複製 Extension ID，貼到下面。",
        action: null,
      }
    : {
        id: "panel",
        name: "瀏覽器側欄",
        tone: typeof paired === "number" && paired > 0 ? "success" : "neutral",
        state: typeof paired === "number" ? (paired > 0 ? "已連線" : "已設定，未連線") : "已設定",
        detail: "",
        action: workbenchReady
          ? {
              action: "create_pairing",
              label: "產生配對連結",
              quiet: typeof paired === "number" && paired > 0,
            }
          : null,
      };

  return [workbenchRow, tunnelRow, chatgptRow, projectsRow, mcpRow, panelRow];
}

/** Rows in the static markup; the script fills them in place so focus never jumps. */
const RAIL: readonly [CompanionRailRow["id"], string][] = [
  ["workbench", "本機工作台"],
  ["tunnel", "安全通道"],
  ["chatgpt", "ChatGPT"],
  ["projects", "專案"],
  ["mcp", "MCP"],
  ["panel", "瀏覽器側欄"],
];

/** Phosphor CaretDown (regular), the same disclosure caret as Desktop and the side panel. */
const CARET =
  '<svg class="caret" viewBox="0 0 256 256" aria-hidden="true" focusable="false"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/></svg>';

/** The K mark from app-icon.svg; its fill follows --k-brand-mark in both themes. */
const K_MARK =
  '<svg class="mark" viewBox="0 0 128 128" aria-hidden="true" focusable="false"><path d="M22 16c-6 0-10 4-10 10v76c0 6 4 10 10 10s10-4 10-10V26c0-6-4-10-10-10Z"/><path d="M106 16H84c-3 0-6 1-8 4L38 57c-4 4-4 10 0 14l39 37c2 3 5 4 8 4h21c4 0 7-2 8-5 1-3 0-6-2-8L73 64l38-35c3-2 4-6 2-9-1-2-4-4-7-4Z"/></svg>';

// tokens.css (light, dark via prefers-color-scheme) plus the few rules this card needs.
// Every size is at least 14px; colour comes from tokens only.
const STYLE = `${tokensCss}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;min-height:100vh;padding:32px 16px;background:var(--k-bg);color:var(--k-ink-1);font-family:var(--k-font-sans);font-size:var(--k-text-base);line-height:var(--k-leading-body)}
main{width:min(100%,480px);margin:0 auto;padding:20px;border:1px solid var(--k-line);border-radius:var(--k-radius-lg);background:var(--k-surface);box-shadow:var(--k-shadow-1),var(--k-inset-hi)}
:focus-visible{outline:2px solid var(--k-focus);outline-offset:2px}
.head{display:flex;align-items:flex-start;gap:12px;margin-bottom:16px}
.mark{flex:none;width:24px;height:24px;margin-top:1px;fill:var(--k-brand-mark)}
h1{margin:0;font-size:var(--k-text-lg);font-weight:var(--k-weight-strong);line-height:var(--k-leading-tight)}
.head p{margin:4px 0 0;color:var(--k-ink-2)}
:where(.notice,.pill){--tone:var(--k-neutral);--tone-soft:var(--k-neutral-soft);--tone-on:var(--k-neutral-on);--tone-line:var(--k-neutral-line)}
.notice{margin:0 0 12px;padding:10px 12px;border:1px solid var(--tone-line);border-radius:var(--k-radius-md);background:var(--tone-soft);color:var(--k-ink-1);overflow-wrap:anywhere}
.notice:empty{margin:0;padding:0;border:0}
.rail{margin:0;padding:0;list-style:none;border:1px solid var(--k-line);border-radius:var(--k-radius-md)}
.row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:4px 8px;min-height:48px;padding:10px 14px}
.row>.pill{grid-column:3;grid-row:1}
.row+.row{border-top:1px solid var(--k-line)}
.row__name{font-weight:var(--k-weight-strong)}
.row__detail,.row__actions,.row__extra{grid-column:1/-1}
.row__detail{margin:0;color:var(--k-ink-2);overflow-wrap:anywhere}
.row__actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.row[data-quiet] .row__actions{grid-column:2;grid-row:1;margin:0}
.pill{display:inline-flex;align-items:center;gap:6px;min-height:26px;padding:0 10px;border:1px solid var(--tone-line);border-radius:var(--k-radius-pill);background:var(--tone-soft);color:var(--tone-on);font-weight:var(--k-weight-strong);white-space:nowrap}
.pill::before{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:var(--tone)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:var(--k-control);padding:0 12px;border:1px solid transparent;border-radius:var(--k-radius-sm);background:transparent;color:var(--k-ink-1);font:inherit;font-weight:var(--k-weight-strong);white-space:nowrap;cursor:pointer}
.btn--sm{min-height:var(--k-control-sm);padding:0 10px}
.btn--primary{background:var(--k-primary-bg);color:var(--k-primary-ink);box-shadow:var(--k-shadow-1)}
.btn--primary:hover{background:var(--k-primary-bg-hover)}
.btn--secondary{border-color:var(--k-line-strong);background:var(--k-surface);box-shadow:var(--k-shadow-1)}
.btn--secondary:hover,.btn--quiet:hover{background:var(--k-surface-2)}
.btn--quiet{color:var(--k-ink-2)}
.btn--danger{background:var(--k-danger);color:var(--k-danger-ink)}
.btn--danger-quiet{color:var(--k-danger-on)}
.btn--danger-quiet:hover{background:var(--k-danger-soft)}
.btn:disabled{border-color:var(--k-line);background:var(--k-surface-2);color:var(--k-ink-3);box-shadow:none;cursor:not-allowed}
.btn--quiet:disabled,.btn--danger-quiet:disabled{border-color:transparent;background:transparent}
.btn[aria-busy="true"]{cursor:progress}
.label{display:block;margin-top:8px;color:var(--k-ink-2);font-weight:var(--k-weight-strong)}
.field{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.input{flex:1 1 220px;min-width:0;min-height:var(--k-control);padding:0 10px;border:1px solid var(--k-line-control);border-radius:var(--k-radius-sm);background:var(--k-surface);color:var(--k-ink-1);font:inherit;font-family:var(--k-font-mono)}
.input::placeholder{color:var(--k-ink-3);font-family:var(--k-font-sans)}
#pairing-url{width:100%;margin-top:8px}
.pairing{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:8px}
.countdown{font-variant-numeric:tabular-nums}
.countdown::before{display:none}
.logs{margin-top:6px}
.logs summary{display:flex;align-items:center;gap:6px;width:max-content;min-height:28px;color:var(--k-ink-2);font-weight:var(--k-weight-strong);list-style:none;cursor:pointer}
.logs summary::-webkit-details-marker{display:none}
.caret{flex:none;width:16px;height:16px;fill:currentColor;transform:rotate(-90deg);transition:transform var(--k-dur-1) var(--k-ease)}
.logs[open] .caret{transform:none}
.logs pre{max-height:160px;margin:6px 0 0;padding:8px 10px;overflow:auto;border-radius:var(--k-radius-sm);background:var(--k-code-bg);color:var(--k-code-ink);font-family:var(--k-font-mono);font-size:var(--k-text-base);white-space:pre-wrap;overflow-wrap:anywhere}
.foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:16px}
.foot .ver{margin-left:auto;color:var(--k-ink-3)}
dialog{width:min(420px,calc(100vw - 32px));padding:20px;border:1px solid var(--k-line);border-radius:var(--k-radius-lg);background:var(--k-surface);color:var(--k-ink-1);box-shadow:var(--k-shadow-3)}
dialog::backdrop{background:var(--k-overlay)}
dialog h2{margin:0 0 8px;font-size:var(--k-text-lg);line-height:var(--k-leading-tight)}
dialog p{margin:0}
.dialog-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:20px}
`;

/**
 * Follows a live pairing link against the paired-panel count. The baseline first falls to any
 * lower count, because saving an Extension ID restarts the workbench, which forgets earlier
 * pairings; only a count above the baseline means a panel paired with this link. An unknown
 * baseline is learnt from the first count seen.
 */
export function pairingProgress(
  baseline: number | null,
  paired: unknown,
): { baseline: number | null; used: boolean } {
  if (typeof paired !== "number") return { baseline, used: false };
  if (baseline === null || paired < baseline) return { baseline: paired, used: false };
  return { baseline, used: paired > baseline };
}

/** The page logic: plain browser JavaScript, no interpolation of request or status data. */
const SCRIPT = `
const companionRail = (${companionRail.toString()});
const pairingProgress = (${pairingProgress.toString()});
const byId = (id) => document.getElementById(id);
const storageKey = 'kairomes-companion-token:' + location.origin;
const supplied = new URLSearchParams(location.hash.slice(1)).get('session');
let token = supplied || '';
try {
  if (supplied) sessionStorage.setItem(storageKey, supplied);
  else token = sessionStorage.getItem(storageKey) || '';
} catch {
  // Storage can be unavailable; the token from the link still works until a reload.
}
if (location.hash) history.replaceState(null, '', location.pathname);

let busy = false;
let stopped = false;
let pollTimer = 0;
let polls = 0;
let mcp;
let status = null;
let pairing = null;
let successTimer = 0;
let statusFailed = false;

/** One message at a time: danger interrupts, everything else is polite; repeats stay quiet. */
function notify(text, tone) {
  const alert = byId('alert');
  const polite = byId('polite');
  const target = tone === 'danger' ? alert : polite;
  if (text && target.textContent === text && target.dataset.tone === tone) return;
  clearTimeout(successTimer);
  alert.textContent = '';
  polite.textContent = '';
  if (!text) return;
  target.dataset.tone = tone;
  target.textContent = text;
  if (tone === 'success') successTimer = setTimeout(() => { polite.textContent = ''; }, 4000);
}

async function request(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const result = await response.json().catch(() => ({ message: 'Kairomes 回應格式不正確。' }));
  if (!response.ok) throw new Error(result.message || '操作沒有完成，請再試一次。');
  return result;
}

function renderRail() {
  if (!status) return;
  for (const row of companionRail(status, mcp)) {
    const item = document.querySelector('[data-row="' + row.id + '"]');
    if (!item) continue;
    const pill = item.querySelector('.pill');
    pill.dataset.tone = row.tone;
    pill.textContent = row.state;
    const detail = item.querySelector('.row__detail');
    detail.textContent = row.detail;
    detail.hidden = !row.detail;
    const actions = item.querySelector('.row__actions');
    const button = actions.querySelector('button');
    actions.hidden = !row.action;
    // An optional action on a healthy row sits beside its pill instead of on its own line.
    item.toggleAttribute('data-quiet', Boolean(row.action && row.action.quiet));
    if (row.action) {
      button.dataset.action = row.action.action;
      button.textContent = row.action.label;
      button.className = 'btn btn--sm ' + (row.action.quiet ? 'btn--quiet' : 'btn--secondary');
    }
  }
  const tunnel = status.tunnel;
  byId('tunnel-logs').hidden =
    !tunnel.logs.length || tunnel.state === 'running' || tunnel.state === 'starting';
  byId('tunnel-log').textContent = tunnel.logs.join('\\n');
  byId('extension-form').hidden = Boolean(status.extension.configured);
  const paired = status.attention ? status.attention.pairedPanels : null;
  if (pairing) {
    const progress = pairingProgress(pairing.pairedAtStart, paired);
    pairing.pairedAtStart = progress.baseline;
    if (progress.used) {
      clearPairing();
      notify('側欄已完成配對。', 'success');
    }
  }
}

function setBusy(next, source) {
  busy = next;
  document.querySelectorAll('main button').forEach((button) => {
    button.disabled = next || stopped;
    if (next && button === source) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  });
}

async function refreshMcp() {
  try {
    mcp = (await request('/api/action', { action: 'mcp_summary' })).mcp;
  } catch {
    mcp = null;
  }
}

async function refresh() {
  if (!token) {
    notify('缺少本機控制憑證；請重新開啟 Kairomes。', 'danger');
    return;
  }
  try {
    status = await request('/api/status');
    if (mcp === undefined || polls % 10 === 0) await refreshMcp();
    polls++;
    renderRail();
    if (statusFailed) {
      statusFailed = false;
      notify('');
    }
  } catch {
    statusFailed = true;
    notify('暫時讀不到 Kairomes 狀態；會自動重試。', 'danger');
  }
}

function countdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return '剩 ' + Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

function clearPairing() {
  pairing = null;
  byId('pairing').hidden = true;
  byId('pairing-url').hidden = true;
  byId('pairing-url').value = '';
}

function tickPairing() {
  if (!pairing) return;
  const left = pairing.expiresAt - Date.now();
  if (left <= 0) {
    clearPairing();
    notify('配對連結已到期，需要時再產生一次。', 'neutral');
    return;
  }
  const time = byId('pairing-time');
  time.textContent = countdown(left);
  time.dataset.tone = left < 30000 ? 'warning' : 'neutral';
}

function keepPairing(result) {
  if (!result.pairingUrl) return;
  const seconds = Number(result.expiresInSeconds);
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 120;
  const paired = status && status.attention ? status.attention.pairedPanels : null;
  pairing = {
    url: result.pairingUrl,
    expiresAt: Date.now() + lifetime * 1000,
    pairedAtStart: typeof paired === 'number' ? paired : null,
  };
  byId('pairing-url').hidden = true;
  byId('pairing').hidden = false;
  tickPairing();
}

async function act(action, extra, source) {
  if (busy || stopped) return;
  setBusy(true, source);
  notify('');
  try {
    const result = await request('/api/action', Object.assign({ action }, extra || {}));
    if (action === 'quit') {
      stopped = true;
      clearInterval(pollTimer);
      clearPairing();
      byId('title').textContent = 'Kairomes 已退出';
      notify('Kairomes 已完整退出；這個頁面可以關閉。', 'neutral');
      return;
    }
    keepPairing(result);
    await refresh();
  } catch (error) {
    notify(error instanceof Error ? error.message : '操作沒有完成，請再試一次。', 'danger');
  } finally {
    setBusy(false, source);
  }
}

document.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('main [data-action]') : null;
  if (button) void act(button.dataset.action, {}, button);
});

byId('extension-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void act('configure_extension', { extensionId: byId('extension-id').value.trim() }, byId('extension-save'));
});

byId('pairing-copy').addEventListener('click', async () => {
  if (!pairing) return;
  try {
    await navigator.clipboard.writeText(pairing.url);
    const minutes = Math.max(1, Math.ceil((pairing.expiresAt - Date.now()) / 60000));
    notify('配對連結已複製，' + minutes + ' 分鐘內有效；只貼到瀏覽器側欄。', 'success');
  } catch {
    const field = byId('pairing-url');
    field.value = pairing.url;
    field.hidden = false;
    field.focus();
    field.select();
    notify('瀏覽器沒有允許自動複製，已選取完整連結。', 'warning');
  }
});

const dialog = byId('quit-dialog');
byId('quit').addEventListener('click', () => {
  if (!busy && !stopped) dialog.showModal();
});
byId('quit-cancel').addEventListener('click', () => dialog.close());
byId('quit-confirm').addEventListener('click', () => {
  dialog.close('quit');
  void act('quit', {}, byId('quit'));
});
dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'quit') byId('quit').focus();
  dialog.returnValue = '';
});

void refresh();
pollTimer = setInterval(() => { if (!busy) void refresh(); }, 1800);
setInterval(tickPairing, 1000);
`;

const TUNNEL_EXTRA = `<details id="tunnel-logs" class="row__extra logs" hidden><summary>${CARET}最近訊息</summary><pre id="tunnel-log"></pre></details>`;
const PANEL_EXTRA =
  '<form id="extension-form" class="row__extra" hidden><label class="label" for="extension-id">Extension ID</label><div class="field"><input id="extension-id" class="input" autocomplete="off" spellcheck="false" maxlength="32" placeholder="貼上 32 位 Extension ID"><button id="extension-save" class="btn btn--secondary" type="submit">儲存並配對</button></div></form>' +
  '<div id="pairing" class="row__extra" hidden><div class="pairing"><span>配對連結已產生</span><span id="pairing-time" class="pill countdown" data-tone="neutral"></span><button id="pairing-copy" class="btn btn--secondary btn--sm" type="button">複製連結</button></div><input id="pairing-url" class="input" readonly aria-label="一次性配對連結" hidden></div>';

function railMarkup() {
  return RAIL.map(
    ([id, name]) =>
      `<li class="row" data-row="${id}"><span class="row__name">${name}</span><span class="pill" data-tone="neutral">讀取中</span><p class="row__detail" hidden></p><div class="row__actions" hidden><button class="btn btn--secondary btn--sm" type="button"></button></div>${
        id === "tunnel" ? TUNNEL_EXTRA : id === "panel" ? PANEL_EXTRA : ""
      }</li>`,
  ).join("");
}

export function companionPage(version: string) {
  const safeVersion = version.replace(/[^0-9A-Za-z.-]/g, "");
  return `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Kairomes</title>
<style>${STYLE}</style>
</head>
<body>
<main aria-labelledby="title">
<header class="head">${K_MARK}<div><h1 id="title">Kairomes 正在背景執行</h1><p>關閉這個頁面不會停止 Kairomes。</p></div></header>
<div id="alert" class="notice" role="alert"></div>
<div id="polite" class="notice" role="status"></div>
<ul class="rail" aria-label="Kairomes 狀態">${railMarkup()}</ul>
<div class="foot"><button class="btn btn--primary" type="button" data-action="open_workbench">開啟工作台</button><button id="quit" class="btn btn--danger-quiet" type="button">完全退出…</button><span class="ver">版本 ${safeVersion}</span></div>
</main>
<dialog id="quit-dialog" aria-labelledby="quit-title" aria-describedby="quit-text">
<h2 id="quit-title">完全退出 Kairomes？</h2>
<p id="quit-text">會停止安全通道與 Kairomes 啟動的工作台；再次開啟 Kairomes 之前，ChatGPT 無法讀取你的專案。</p>
<div class="dialog-actions"><button id="quit-cancel" class="btn btn--secondary" type="button" autofocus>取消</button><button id="quit-confirm" class="btn btn--danger" type="button">完全退出</button></div>
</dialog>
<script>${SCRIPT}</script>
</body>
</html>`;
}
