export const approvalPage = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kairomes · 本機審批</title><style>
:root{color-scheme:dark;font:14px/1.6 "Segoe UI",sans-serif;background:#151817;color:#e9ede8}body{max-width:960px;margin:48px auto;padding:0 24px}h1{font-weight:500;font-size:28px}small{color:#a0aaa1;letter-spacing:.12em}.notice,article{border:1px solid #303631;border-radius:8px;padding:20px;margin:20px 0}.notice{background:#27251d;color:#e8d4a8}h2{font-size:18px;margin:0 0 12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#a0aaa1;font:12px/1.7 Consolas,monospace}button{font:inherit;border:1px solid #47543e;border-radius:5px;background:#c7e9ae;color:#172015;padding:10px 16px;cursor:pointer;margin:6px 12px 0 0}button.secondary{background:transparent;color:#efb2a6;border-color:#754e46}button:disabled{opacity:.4}#error{color:#efb2a6}#empty{color:#a0aaa1}
</style></head><body><small>KAIROMES / LOCAL APPROVAL</small><h1>由你決定，何時開始執行。</h1>
<div class="notice">結構化檔案變更會先顯示差異並再次檢查版本；一次性命令只核准卡片列出的參數；互動式終端機會開放 <strong>15 分鐘的主機 shell</strong>。命令與 shell 具有你的使用者權限，可修改或刪除檔案、存取工作區外資料及連網。請只核准你正在操作的請求，停止也無法撤銷已完成的動作。圖片匯入只能在已配對的瀏覽器側欄處理。</div>
<p>這是本機管理頁。請保留含存取權杖的原始網址，不要將網址交給模型或其他人。</p>
<p id="error" role="alert"></p><p id="empty">正在讀取請求…</p><div id="requests"></div>
<script>
const token=new URLSearchParams(location.hash.slice(1)).get('session')||'';
if(token)history.replaceState(null,'',location.pathname);
const error=document.getElementById('error'),empty=document.getElementById('empty'),container=document.getElementById('requests');
let previous='',busy=false;
const states={pending:'等待批准',applying:'套用中',applied:'已套用',conflict:'檔案已變更',starting:'啟動中',running:'執行中',exited:'已結束',denied:'已拒絕',stopped:'已停止',expired:'已到期',failed:'失敗',succeeded:'成功',timed_out:'逾時',cancelled:'已取消'};
async function api(body){const response=await fetch('/api/approvals',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const data=await response.json();if(!response.ok)throw new Error(data.message||'本機管理頁已失效，請使用啟動時的完整網址。');return data;}
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
    empty.textContent = items.length ? '' : '目前沒有待處理請求。請從 ChatGPT 建立檔案變更、命令或終端機請求。';
    for (const session of items) {
      const change = Array.isArray(session.files);
      const command = !change && Array.isArray(session.argv);
      const card = document.createElement('article');
      const title = document.createElement('h2');
      title.textContent = session.workspace_name + ' · ' + (change ? '檔案變更' : command ? '一次性命令' : session.shell) + ' · ' + states[session.state];
      const details = document.createElement('pre');
      details.textContent = change ? [
        '變更：' + session.id,
        '摘要：' + session.summary,
        '檔案：' + session.files.map(file => file.operation + ' ' + file.path).join('、'),
        '到期時間：' + new Date(session.expires_at).toLocaleString(),
        '請求指紋：' + session.fingerprint,
        '',
        session.diff,
        session.diff_truncated ? '…差異過長，顯示內容已截斷。' : ''
      ].join(String.fromCharCode(10)) : [
        '工作階段：' + session.id,
        '起始位置：' + session.absolute_cwd,
        command ? '參數：' + JSON.stringify(session.argv) : 'Shell：' + JSON.stringify(session.command),
        command ? '執行檔：' + session.executable + ' · 最多 ' + session.timeout_ms / 1000 + ' 秒' : '互動式工作階段：15 分鐘',
        '到期時間：' + new Date(session.expires_at).toLocaleString(),
        '請求指紋：' + session.fingerprint
      ].join(String.fromCharCode(10));
      card.append(title, details);
      const actions = session.state === 'pending'
        ? [['approve',change ? '套用這批變更' : command ? '允許這次命令' : '核准 15 分鐘主機存取'],['deny','拒絕']]
        : !change && ['starting','running'].includes(session.state) ? [['stop','立即停止']] : [];
      for (const [action, label] of actions) {
        const button = document.createElement('button');
        button.textContent = label;
        if (action !== 'approve') button.className = 'secondary';
        button.onclick = async () => {
          busy = true;
          button.disabled = true;
          try {
            await api({action, ...(change ? {change_id:session.id} : command ? {command_id:session.id} : {session_id:session.id}), fingerprint:session.fingerprint});
            error.textContent = '';
            previous = '';
          } catch (cause) { error.textContent = cause.message; }
          finally { busy = false; button.disabled = false; await refresh(); }
        };
        card.append(button);
      }
      container.append(card);
    }
  } catch (cause) { error.textContent = cause.message; }
}
if(!token){error.textContent='請使用 Kairomes 啟動時輸出的完整本機審批網址。';empty.textContent='';}else{refresh();setInterval(refresh,1500);}
</script></body></html>`;
