import { tokensCss } from "../../../packages/ui-tokens/index.ts";
import { approvalPageScript } from "./approval-page-script.ts";

// Legacy local approval page (admin token in the URL fragment). It follows the shared tokens
// in light and dark, renders every value through textContent and never lists or decides
// image imports: those are reviewed only in the paired browser side panel.
const style = `${tokensCss}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--k-bg);color:var(--k-ink-1);font:var(--k-text-base)/1.5 var(--k-font-sans)}
main{display:grid;gap:16px;max-width:880px;margin:0 auto;padding:32px 16px 48px}
.brand{display:flex;align-items:center;gap:8px;margin:0;color:var(--k-ink-2);font-weight:var(--k-weight-strong)}
.mark{width:20px;height:20px;fill:var(--k-brand-mark)}
h1{margin:0;font-size:var(--k-text-xl);font-weight:var(--k-weight-strong);line-height:var(--k-leading-tight)}
p{margin:0;overflow-wrap:anywhere}
.lead,.meta{color:var(--k-ink-2)}
.risk{display:grid;gap:4px;padding:12px 14px;border-left:4px solid var(--k-warning);border-radius:var(--k-radius-md);background:var(--k-warning-soft);color:var(--k-ink-1)}
.risk strong{color:var(--k-warning-on)}
#error{color:var(--k-danger-on);font-weight:var(--k-weight-strong)}
#error:empty,#empty:empty{display:none}
#requests{display:grid;gap:16px}
article{display:grid;gap:12px;padding:16px;border:1px solid var(--k-line);border-radius:var(--k-radius-md);background:var(--k-surface);box-shadow:var(--k-shadow-1),var(--k-inset-hi);min-width:0}
h2{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0;font-size:var(--k-text-md);font-weight:var(--k-weight-strong)}
.pill{display:inline-flex;align-items:center;height:22px;padding:0 8px;border:1px solid var(--tone-line);border-radius:var(--k-radius-pill);background:var(--tone-soft);color:var(--tone-on);font-size:var(--k-text-meta);font-weight:var(--k-weight-strong)}
dl{display:grid;gap:8px;margin:0}
dt{color:var(--k-ink-2);font-size:var(--k-text-meta);font-weight:var(--k-weight-strong)}
dd{margin:2px 0 0;min-width:0}
.code{padding:6px 10px;border:1px solid var(--k-line);border-radius:var(--k-radius-sm);background:var(--k-code-bg);color:var(--k-code-ink);font-family:var(--k-font-mono);white-space:pre-wrap;overflow-wrap:anywhere}
.argv{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.argv li{display:inline-flex;max-width:100%;border:1px solid var(--k-line-strong);border-radius:var(--k-radius-xs);font-family:var(--k-font-mono)}
.argv b{padding:0 6px;border-right:1px solid var(--k-line);background:var(--k-surface-2);color:var(--k-ink-3);font-size:var(--k-text-meta);font-weight:var(--k-weight-regular)}
.argv span{min-width:0;padding:0 8px;background:var(--k-code-bg);color:var(--k-code-ink);white-space:pre-wrap;overflow-wrap:anywhere}
.diff{overflow:hidden;border:1px solid var(--k-line);border-radius:var(--k-radius-md);background:var(--k-code-bg);color:var(--k-code-ink);font:var(--k-text-base)/22px var(--k-font-mono)}
.line{padding:0 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.line[data-kind="add"]{background:var(--k-diff-add-bg)}
.line[data-kind="del"]{background:var(--k-diff-del-bg)}
.line[data-kind="add"] .sign{color:var(--k-diff-add-mark);font-weight:var(--k-weight-bold)}
.line[data-kind="del"] .sign{color:var(--k-diff-del-mark);font-weight:var(--k-weight-bold)}
.line[data-kind="hunk"]{background:var(--k-diff-hunk-bg);color:var(--k-diff-hunk-ink)}
.line[data-kind="file"]{padding-block:4px;border-block:1px solid var(--k-line);background:var(--k-surface-2);color:var(--k-ink-1);font-weight:var(--k-weight-strong)}
.line[data-kind="file"]:first-child{border-top:0}
.line[data-kind="note"]{background:var(--k-warning-soft);color:var(--k-warning-on);font-family:var(--k-font-sans)}
.line[data-kind="meta"]{color:var(--k-ink-3)}
.esc{margin:0 1px;padding:0 3px;border-radius:var(--k-radius-xs);background:var(--k-warning-soft);color:var(--k-warning-on);font-size:var(--k-text-meta)}
.actions{display:flex;flex-wrap:wrap;gap:8px}
button{height:40px;padding:0 16px;border:1px solid var(--k-line-strong);border-radius:var(--k-radius-sm);background:var(--k-surface);color:var(--k-ink-1);font:inherit;font-weight:var(--k-weight-strong);cursor:pointer}
button:hover{background:var(--k-surface-2)}
button.primary{border-color:var(--k-primary-bg);background:var(--k-primary-bg);color:var(--k-primary-ink)}
button.primary:hover{background:var(--k-primary-bg-hover)}
button:disabled{border-color:var(--k-line);background:var(--k-surface-2);color:var(--k-ink-3);cursor:not-allowed}
button:focus-visible{outline:2px solid var(--k-focus);outline-offset:2px}
`;

export const approvalPage = `<!doctype html>
<html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>本機核准 · Kairomes</title><style>${style}</style></head><body><main>
<p class="brand"><svg class="mark" viewBox="0 0 128 128" aria-hidden="true" focusable="false"><path d="M22 16c-6 0-10 4-10 10v76c0 6 4 10 10 10s10-4 10-10V26c0-6-4-10-10-10Z"/><path d="M106 16H84c-3 0-6 1-8 4L38 57c-4 4-4 10 0 14l39 37c2 3 5 4 8 4h21c4 0 7-2 8-5 1-3 0-6-2-8L73 64l38-35c3-2 4-6 2-9-1-2-4-4-7-4Z"/></svg>Kairomes</p>
<h1>本機核准</h1>
<p class="lead">平常請在已配對的瀏覽器側欄核准；圖片匯入只能在側欄處理。</p>
<div class="risk"><strong>主機權限 · 可操作工作區外 · 可連網</strong><p>命令與終端機以你的使用者權限執行，沒有隔離；檔案變更會先核對版本。只核准你正在操作的請求，停止無法撤銷已完成的動作。</p></div>
<p class="meta">這是本機管理頁。請保留含存取權杖的原始網址，不要將網址交給模型或其他人。</p>
<p id="error" role="alert"></p><p id="empty" class="meta">正在讀取請求…</p><div id="requests"></div>
</main><script>${approvalPageScript}
const token=new URLSearchParams(location.hash.slice(1)).get('session')||'';
if(token)history.replaceState(null,'',location.pathname);
const error=document.getElementById('error'),empty=document.getElementById('empty'),container=document.getElementById('requests');
let previous='',busy=false;
const states={pending:['需確認','brand'],applying:['套用中','running'],applied:['已套用','success'],conflict:['版本衝突','danger'],starting:['啟動中','running'],running:['執行中','running'],exited:['已結束','neutral'],denied:['已拒絕','neutral'],stopped:['已停止','neutral'],expired:['已到期','neutral'],failed:['失敗','danger'],succeeded:['已完成','success'],timed_out:['逾時','danger'],cancelled:['已取消','neutral']};
async function api(body){const response=await fetch('/api/approvals',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const data=await response.json();if(!response.ok)throw new Error(data.message||'本機管理頁已失效，請使用啟動時的完整網址。');return data;}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
// Text with invisible or reordering characters shown as labelled escapes.
function visible(element, text) {
  for (const segment of visibleSegments(text)) element.append(segment.escape ? node('span', 'esc', segment.text) : segment.text);
  return element;
}
function fact(list, label, value) {
  const term = node('dt', '', label);
  const detail = node('dd');
  if (typeof value === 'string') detail.append(visible(node('div', 'code'), value));
  else detail.append(value);
  list.append(term, detail);
}
// Each element JSON-quoted, so empty, whitespace-only and control characters stay distinct.
function argv(values) {
  const list = node('ol', 'argv');
  values.forEach((value, index) => {
    const item = node('li');
    item.append(node('b', '', String(index)), node('span', '', quoted(value)));
    list.append(item);
  });
  return list;
}
// One row per line: file rows, hunk labels, additions, removals and context (see diffRows).
function diff(text, truncated, files) {
  const box = node('div', 'diff');
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', '差異');
  for (const entry of diffRows(text, files)) {
    const row = node('div', 'line');
    row.dataset.kind = entry.kind;
    if (entry.kind === 'add' || entry.kind === 'del') row.append(node('span', 'sign', entry.kind === 'add' ? '+' : '-'));
    else if (entry.kind === 'context') row.append(node('span', 'sign', ' '));
    if (entry.kind === 'hunk' || entry.kind === 'note') row.textContent = entry.text;
    else visible(row, entry.text);
    if (!row.textContent) row.append(' ');
    box.append(row);
  }
  if (truncated) {
    const note = node('div', 'line', '差異過長，顯示內容已截斷。');
    note.dataset.kind = 'note';
    box.append(note);
  }
  return box;
}
async function refresh() {
  if (busy) return;
  try {
    const data = await api({action:'list'});
    const encoded = JSON.stringify(data);
    if (encoded === previous) return;
    previous = encoded;
    container.replaceChildren();
    // Image imports are reviewed only in the paired Extension; this page never lists them.
    const items = [...(data.changes || []), ...(data.commands || []), ...data.sessions];
    empty.textContent = items.length ? '' : '目前沒有待處理請求。ChatGPT 要改檔案或執行命令時會列在這裡。';
    for (const session of items) {
      const change = Array.isArray(session.files);
      const command = !change && Array.isArray(session.argv);
      const card = node('article');
      const title = node('h2', '', session.workspace_name + ' · ' + (change ? '檔案變更' : command ? '一次性命令' : '終端機'));
      const state = states[session.state] || ['結果待確認', 'warning'];
      const pill = node('span', 'pill', state[0]);
      pill.dataset.tone = state[1];
      title.append(pill);
      const facts = node('dl');
      if (change) {
        fact(facts, '摘要', node('p', '', session.summary));
        // One line per file, so a newline inside a path still shows as an escape.
        const list = node('div', 'code');
        for (const file of session.files) list.append(visible(node('div'), fileLine(file)));
        fact(facts, '檔案', list);
      } else {
        fact(facts, '工作目錄', session.absolute_cwd);
        if (command) {
          fact(facts, '執行檔', session.executable);
          fact(facts, '參數（' + session.argv.length + ' 個）', argv(session.argv));
          fact(facts, '時限', node('p', '', '只允許這一次，最多 ' + session.timeout_ms / 1000 + ' 秒'));
        } else {
          fact(facts, 'Shell', JSON.stringify(session.command));
          fact(facts, '時限', node('p', '', '互動式終端機 15 分鐘'));
        }
      }
      const meta = node('p', 'meta', '請求 ' + session.id + ' · 到期 ' + new Date(session.expires_at).toLocaleString() + ' · 指紋 ' + session.fingerprint);
      card.append(title, facts);
      if (change) card.append(diff(session.diff, session.diff_truncated, session.files));
      card.append(meta);
      const actions = session.state === 'pending'
        ? [['approve',change ? '套用這批' : command ? '允許這次' : '允許 15 分鐘終端機'],['deny','拒絕']]
        : !change && ['starting','running'].includes(session.state) ? [['stop','停止']] : [];
      const row = node('div', 'actions');
      for (const [action, label] of actions) {
        const button = node('button', action === 'approve' ? 'primary' : '', label);
        button.type = 'button';
        // A truncated diff is never approvable.
        if (action === 'approve' && change && session.diff_truncated) button.disabled = true;
        button.onclick = async (event) => {
          if (!event.isTrusted) return;
          busy = true;
          button.disabled = true;
          try {
            await api({action, ...(change ? {change_id:session.id} : command ? {command_id:session.id} : {session_id:session.id}), fingerprint:session.fingerprint});
            error.textContent = '';
            previous = '';
          } catch (cause) { error.textContent = cause.message; }
          finally { busy = false; button.disabled = false; await refresh(); }
        };
        row.append(button);
      }
      if (actions.length) card.append(row);
      container.append(card);
    }
  } catch (cause) { error.textContent = cause.message; }
}
if(!token){error.textContent='請使用 Kairomes 啟動時輸出的完整本機核准網址。';empty.textContent='';}else{refresh();setInterval(refresh,1500);}
</script></body></html>`;
