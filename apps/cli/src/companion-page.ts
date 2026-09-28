export function companionPage(logoBase64: string, version: string) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kairomes Companion</title>
  <style>
    :root {
      color-scheme: light;
      --paper: #f5f0e7;
      --paper-strong: #fffdf8;
      --ink: #201d1b;
      --muted: #746d66;
      --line: #ded4c7;
      --signal: #b9363f;
      --signal-dark: #972a32;
      --signal-soft: #f6e4e5;
      --good: #557d66;
      --good-soft: #e5eee7;
      --warn: #a0682f;
      --warn-soft: #f7ead7;
      --quiet: #8a857e;
      --shadow: 0 24px 70px rgba(74, 55, 37, .12);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background:
        radial-gradient(circle at 88% 8%, rgba(185, 54, 63, .08), transparent 27rem),
        linear-gradient(145deg, #fbf8f1 0%, var(--paper) 55%, #efe8dc 100%);
    }
    button, input { font: inherit; }
    button { cursor: pointer; }
    .shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
    .topbar {
      min-height: 74px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      padding: 14px clamp(18px, 4vw, 54px);
      border-bottom: 1px solid var(--line);
      background: rgba(255, 253, 248, .82);
      backdrop-filter: blur(20px);
      position: sticky;
      top: 0;
      z-index: 5;
    }
    .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .brand img { width: 42px; height: 42px; border-radius: 13px; }
    .brand strong { display: block; font-size: 15px; letter-spacing: -.01em; }
    .brand span span { display: block; margin-top: 2px; color: var(--muted); font-size: 9px; letter-spacing: .16em; }
    .overall {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 34px;
      padding: 0 13px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: var(--paper-strong);
      font-size: 12px;
      white-space: nowrap;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--quiet); box-shadow: 0 0 0 4px rgba(138,133,126,.1); }
    .overall.good .dot, .state.good .dot { background: var(--good); box-shadow: 0 0 0 4px rgba(85,125,102,.12); }
    .overall.warn .dot, .state.warn .dot { background: var(--warn); box-shadow: 0 0 0 4px rgba(160,104,47,.12); }
    .overall.busy .dot, .state.busy .dot { background: var(--signal); box-shadow: 0 0 0 4px rgba(185,54,63,.11); }
    main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: clamp(38px, 7vw, 82px) 0 64px; }
    .hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 34px; align-items: end; margin-bottom: 34px; }
    .eyebrow { margin: 0 0 12px; color: var(--signal); font-size: 11px; font-weight: 800; letter-spacing: .18em; }
    h1 { max-width: 720px; margin: 0; font-size: clamp(36px, 6vw, 68px); line-height: .98; letter-spacing: -.055em; }
    .hero p:last-child { max-width: 690px; margin: 20px 0 0; color: var(--muted); font-size: 15px; line-height: 1.7; }
    .hero-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
    .button {
      min-height: 42px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 0 16px;
      border: 1px solid var(--line);
      border-radius: 12px;
      color: var(--ink);
      background: var(--paper-strong);
      font-weight: 700;
      font-size: 13px;
      white-space: nowrap;
      transition: transform .15s ease, border-color .15s ease, background .15s ease;
    }
    .button:hover { transform: translateY(-1px); border-color: #c7b8a7; }
    .button.primary { color: white; border-color: var(--signal); background: var(--signal); }
    .button.primary:hover { background: var(--signal-dark); border-color: var(--signal-dark); }
    .button.danger { color: var(--signal); border-color: #e1b7ba; background: #fff8f8; }
    .button:disabled { cursor: wait; opacity: .55; transform: none; }
    .notice {
      display: none;
      margin: 0 0 20px;
      padding: 13px 16px;
      border: 1px solid #e6b5b8;
      border-radius: 12px;
      color: #7d252c;
      background: #fff3f3;
      line-height: 1.5;
      font-size: 13px;
    }
    .notice.visible { display: block; }
    .status-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
    .card {
      min-width: 0;
      min-height: 286px;
      display: flex;
      flex-direction: column;
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: rgba(255, 253, 248, .9);
      box-shadow: var(--shadow);
    }
    .card-number { color: var(--signal); font-size: 11px; font-weight: 800; letter-spacing: .16em; }
    .state { display: flex; align-items: center; gap: 9px; margin-top: 26px; color: var(--muted); font-size: 12px; font-weight: 700; }
    .state .dot { flex: 0 0 auto; }
    .card h2 { margin: 14px 0 7px; font-size: 24px; letter-spacing: -.035em; }
    .card-message { min-height: 65px; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.65; }
    .card-meta { margin-top: 12px; color: var(--quiet); font-size: 11px; }
    .card-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: auto; padding-top: 22px; }
    .card .button { min-height: 38px; padding: 0 13px; }
    .pairing {
      margin-top: 18px;
      padding: 22px;
      display: grid;
      grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr);
      gap: 28px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: rgba(255, 253, 248, .82);
    }
    .pairing h2 { margin: 6px 0 8px; font-size: 22px; letter-spacing: -.03em; }
    .pairing p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.6; }
    .pairing-form { display: grid; gap: 9px; }
    .field-row { display: flex; gap: 9px; }
    .field-row input, .pair-result input { min-width: 0; }
    input {
      width: 100%;
      min-height: 42px;
      padding: 0 13px;
      border: 1px solid var(--line);
      border-radius: 11px;
      color: var(--ink);
      background: #fbf7ef;
      outline: none;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 12px;
    }
    input:focus { border-color: var(--signal); box-shadow: 0 0 0 3px rgba(185,54,63,.1); }
    .pair-result { display: none; gap: 8px; }
    .pair-result.visible { display: flex; }
    .pair-result input { color: var(--muted); }
    .pair-notice { margin: 0; }
    .pair-notice.good {
      border-color: #bfd2c4;
      color: #355744;
      background: #eef5ef;
    }
    details { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 13px; }
    summary { cursor: pointer; color: var(--muted); font-size: 12px; font-weight: 700; }
    pre {
      max-height: 160px;
      overflow: auto;
      margin: 11px 0 0;
      padding: 12px;
      border-radius: 10px;
      color: #d8e9d8;
      background: #171b18;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 11px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    footer {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 18px clamp(18px, 4vw, 54px);
      border-top: 1px solid var(--line);
      color: var(--quiet);
      font-size: 10px;
      letter-spacing: .08em;
    }
    @media (max-width: 880px) {
      .hero { grid-template-columns: 1fr; }
      .hero-actions { justify-content: flex-start; }
      .status-grid { grid-template-columns: 1fr; }
      .card { min-height: 240px; }
      .pairing { grid-template-columns: 1fr; }
    }
    @media (max-width: 520px) {
      .topbar { padding-inline: 14px; }
      .brand span span { display: none; }
      .overall { max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
      main { width: min(100% - 24px, 1120px); padding-top: 38px; }
      h1 { font-size: 41px; }
      .hero-actions, .field-row, .pair-result { flex-direction: column; }
      .hero-actions .button, .field-row .button, .pair-result .button { width: 100%; }
      .pairing, .card { padding: 18px; border-radius: 16px; }
      footer { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <img src="data:image/png;base64,${logoBase64}" alt="">
        <span><strong>Kairomes Companion</strong><span>LOCAL CONTROL CENTER</span></span>
      </div>
      <div id="overall" class="overall busy"><i class="dot"></i><span>正在準備本機工具</span></div>
    </header>
    <main>
      <section class="hero">
        <div>
          <p class="eyebrow">ONE PLACE · CLEAR CONTROL</p>
          <h1>本機工具，現在有一個看得見的家。</h1>
          <p>不再來回貼啟動指令。Companion 會管理工作台與官方 Tunnel；關閉這個頁面不會中斷服務，重新雙擊程式就會回到同一個狀態。</p>
        </div>
        <div class="hero-actions">
          <button class="button primary" data-action="open_workbench">開啟工作台</button>
          <button class="button danger" data-action="quit">完全退出</button>
        </div>
      </section>
      <p id="notice" class="notice" role="alert"></p>
      <section class="status-grid" aria-label="Companion 狀態">
        <article class="card">
          <span class="card-number">01 · LOCAL APP</span>
          <div id="workbench-state" class="state busy"><i class="dot"></i><span>正在啟動</span></div>
          <h2>本機工作台</h2>
          <p id="workbench-message" class="card-message">正在建立安全的本機工作階段。</p>
          <p id="workbench-meta" class="card-meta"></p>
          <div class="card-actions">
            <button class="button" data-action="open_workbench">開啟</button>
            <button id="workbench-retry" class="button" data-action="retry_workbench" hidden>重新接管</button>
          </div>
        </article>
        <article class="card">
          <span class="card-number">02 · SECURE TUNNEL</span>
          <div id="tunnel-state" class="state busy"><i class="dot"></i><span>正在檢查</span></div>
          <h2>ChatGPT Tunnel</h2>
          <p id="tunnel-message" class="card-message">正在尋找官方 tunnel-client。</p>
          <p id="tunnel-meta" class="card-meta">Profile · kairomes</p>
          <div class="card-actions">
            <button id="tunnel-start" class="button primary" data-action="start_tunnel">啟動</button>
            <button id="tunnel-restart" class="button" data-action="restart_tunnel" hidden>重新啟動</button>
            <button id="tunnel-stop" class="button" data-action="stop_tunnel" hidden>停止</button>
          </div>
          <details><summary>最近訊息</summary><pre id="tunnel-log">尚無訊息。</pre></details>
        </article>
        <article class="card">
          <span class="card-number">03 · CHATGPT</span>
          <div id="connector-state" class="state"><i class="dot"></i><span>等待連線</span></div>
          <h2>Connector</h2>
          <p id="connector-message" class="card-message">Tunnel 啟動後，到 ChatGPT 的 Kairomes Connector 按一次重新整理。</p>
          <p id="connector-meta" class="card-meta">工具 schema 由 ChatGPT 快取</p>
          <div class="card-actions">
            <button class="button" data-action="open_connectors">開啟 ChatGPT 設定</button>
          </div>
        </article>
      </section>
      <section class="pairing">
        <div>
          <span class="card-number">BROWSER PAIRING</span>
          <h2>第一次只要配對一次。</h2>
          <p id="extension-message">從 Kairomes 側欄複製 Extension ID，貼到右邊。之後 Companion 會記住它，也能隨時產生新的兩分鐘配對連結。</p>
        </div>
        <form id="extension-form" class="pairing-form">
          <div class="field-row">
            <input id="extension-id" autocomplete="off" spellcheck="false" maxlength="32" placeholder="貼上 32 位 Extension ID" aria-label="Extension ID">
            <button class="button primary" type="submit">儲存並配對</button>
          </div>
          <button id="pair-create" class="button" type="button" data-action="create_pairing" hidden>產生新的配對連結</button>
          <div id="pair-result" class="pair-result">
            <input id="pairing-url" readonly aria-label="一次性配對連結">
            <button id="pair-copy" class="button" type="button">複製連結</button>
          </div>
          <p id="pair-notice" class="notice pair-notice" role="alert"></p>
        </form>
      </section>
    </main>
    <footer><span>關閉瀏覽器頁面不會停止 Companion；再次啟動即可回到這裡。</span><span>KAIROMES / ${version}</span></footer>
  </div>
  <script>
    const byId = (id) => document.getElementById(id);
    const hash = new URLSearchParams(location.hash.slice(1));
    const storageKey = 'kairomes-companion-token:' + location.origin;
    const supplied = hash.get('session');
    if (supplied) sessionStorage.setItem(storageKey, supplied);
    const token = supplied || sessionStorage.getItem(storageKey) || '';
    if (location.hash) history.replaceState(null, '', location.pathname);
    const notice = byId('notice');
    let busy = false;
    let pollTimer;

    function showNotice(message) {
      notice.textContent = message || '';
      notice.classList.toggle('visible', Boolean(message));
    }

    function showPairNotice(message, tone = 'error') {
      const pairNotice = byId('pair-notice');
      pairNotice.textContent = message || '';
      pairNotice.className = 'notice pair-notice' + (tone === 'good' ? ' good' : '');
      pairNotice.classList.toggle('visible', Boolean(message));
    }

    function setState(id, tone, label) {
      const element = byId(id);
      element.className = 'state' + (tone ? ' ' + tone : '');
      element.querySelector('span').textContent = label;
    }

    async function request(path, body = {}) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({ message: 'Companion 回應格式不正確。' }));
      if (!response.ok) throw new Error(result.message || '操作失敗。');
      return result;
    }

    function render(status) {
      const overall = byId('overall');
      overall.className = 'overall ' + status.overall.tone;
      overall.querySelector('span').textContent = status.overall.label;

      const workbenchTone = status.workbench.state === 'running' ? 'good' : status.workbench.state === 'starting' ? 'busy' : 'warn';
      setState('workbench-state', workbenchTone, status.workbench.label);
      byId('workbench-message').textContent = status.workbench.message;
      byId('workbench-meta').textContent = status.workbench.meta || '';
      byId('workbench-retry').hidden = !['external', 'error', 'stopped'].includes(status.workbench.state);

      const tunnelTone = status.tunnel.state === 'running' ? 'good' : status.tunnel.state === 'starting' ? 'busy' : 'warn';
      setState('tunnel-state', tunnelTone, status.tunnel.label);
      byId('tunnel-message').textContent = status.tunnel.message;
      byId('tunnel-meta').textContent = status.tunnel.meta;
      byId('tunnel-log').textContent = status.tunnel.logs.length ? status.tunnel.logs.join('\\n') : '尚無訊息。';
      byId('tunnel-start').hidden = ['running', 'starting'].includes(status.tunnel.state);
      byId('tunnel-restart').hidden = status.tunnel.state !== 'running';
      byId('tunnel-stop').hidden = status.tunnel.state !== 'running';

      const connectorTone = status.connector.state === 'connected' ? 'good' : status.connector.state === 'waiting' ? 'busy' : '';
      setState('connector-state', connectorTone, status.connector.label);
      byId('connector-message').textContent = status.connector.message;
      byId('connector-meta').textContent = status.connector.meta;

      byId('extension-message').textContent = status.extension.configured
        ? 'Extension 已設定。需要重新配對時，直接產生新的連結；不必重開 CMD。'
        : '從 Kairomes 側欄複製 Extension ID，貼到右邊。之後 Companion 會記住它，也能隨時產生新的兩分鐘配對連結。';
      byId('pair-create').hidden = !status.extension.configured || status.workbench.state !== 'running';
    }

    async function refresh() {
      if (!token) {
        showNotice('缺少本機控制憑證；請重新啟動 Kairomes Companion。');
        return;
      }
      try {
        render(await request('/api/status'));
        showNotice('');
      } catch (error) {
        showNotice(error instanceof Error ? error.message : '無法取得 Companion 狀態。');
      }
    }

    async function act(action, extra = {}) {
      if (busy) return;
      const pairingAction = action === 'configure_extension' || action === 'create_pairing';
      busy = true;
      document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      showNotice('');
      if (pairingAction) showPairNotice('');
      try {
        const result = await request('/api/action', { action, ...extra });
        if (result.pairingUrl) {
          byId('pairing-url').value = result.pairingUrl;
          byId('pair-result').classList.add('visible');
          showPairNotice('新的配對連結已準備好，兩分鐘內都可以使用。', 'good');
        }
        if (action === 'quit') {
          clearInterval(pollTimer);
          showNotice('Companion 已完整退出；這個頁面可以關閉。');
          return;
        }
        await refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : '操作失敗。';
        if (pairingAction) showPairNotice(message);
        else showNotice(message);
      } finally {
        busy = false;
        document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
      }
    }

    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      if (action === 'quit' && !confirm('要停止 Companion、Tunnel 與由它啟動的工作台嗎？')) return;
      void act(action);
    });

    byId('extension-form').addEventListener('submit', (event) => {
      event.preventDefault();
      void act('configure_extension', { extensionId: byId('extension-id').value.trim() });
    });

    byId('pair-copy').addEventListener('click', async () => {
      const value = byId('pairing-url').value;
      try {
        await navigator.clipboard.writeText(value);
        byId('pair-copy').textContent = '已複製';
        setTimeout(() => { byId('pair-copy').textContent = '複製連結'; }, 1400);
      } catch {
        byId('pairing-url').focus();
        byId('pairing-url').select();
        showPairNotice('瀏覽器沒有允許自動複製，已替你選取完整連結。');
      }
    });

    void refresh();
    pollTimer = setInterval(() => { if (!busy) void refresh(); }, 1800);
  </script>
</body>
</html>`;
}
