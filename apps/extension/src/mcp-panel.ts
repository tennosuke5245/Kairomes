import type { McpCatalogTool, McpPanelState } from "@kairomes/protocol";

const stateLabels = {
  disconnected: "尚未連線",
  connecting: "連線中",
  ready: "已連線",
  unavailable: "無法連線",
} as const;

function switchButton(checked: boolean, label: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mcp-switch";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-checked", String(checked));
  button.setAttribute("aria-label", label);
  const text = document.createElement("span");
  text.textContent = checked ? "開啟" : "關閉";
  const track = document.createElement("i");
  track.append(document.createElement("i"));
  button.append(text, track);
  return button;
}

function riskLabels(tool: McpCatalogTool) {
  const values: Array<[string, string]> = [];
  if (tool.destructive_hint === true) values.push(["warn", "可能修改資料"]);
  else if (tool.read_only_hint === true) values.push(["safe", "唯讀"]);
  else values.push(["neutral", "可執行動作"]);
  if (tool.open_world_hint === true) values.push(["network", "可連外"]);
  return values;
}

export class McpPanel {
  private readonly root = document.createElement("div");
  private readonly status = document.createElement("span");
  private readonly servers = document.createElement("div");
  private readonly addButton = document.createElement("button");
  private readonly addDialog = document.createElement("dialog");
  private readonly form = document.createElement("form");
  private readonly transport = document.createElement("select");
  private readonly name = document.createElement("input");
  private readonly target = document.createElement("input");
  private readonly targetLabel = document.createElement("span");
  private readonly args = document.createElement("textarea");
  private readonly cwd = document.createElement("input");
  private readonly submit = document.createElement("button");
  private state?: McpPanelState;
  private available = false;
  private busy = false;

  constructor(
    container: HTMLElement,
    private readonly change: (body: unknown) => Promise<McpPanelState>,
    private readonly report: (message: string) => void,
  ) {
    this.root.className = "mcp-settings";
    const heading = document.createElement("header");
    heading.className = "settings-page-heading";
    const headingCopy = document.createElement("div");
    const title = document.createElement("h1");
    title.textContent = "MCP 整合";
    title.tabIndex = -1;
    headingCopy.append(title);
    const headingActions = document.createElement("div");
    headingActions.className = "settings-page-actions";
    this.status.className = "settings-status";
    this.status.setAttribute("role", "status");
    this.addButton.type = "button";
    this.addButton.className = "settings-add-button";
    this.addButton.textContent = "＋ 加入 MCP";
    headingActions.append(this.status, this.addButton);
    heading.append(headingCopy, headingActions);

    const trust = document.createElement("aside");
    trust.className = "mcp-trust-note";
    const trustMark = document.createElement("span");
    trustMark.textContent = "K";
    const trustCopy = document.createElement("div");
    const trustTitle = document.createElement("strong");
    trustTitle.textContent = "只加入信任的 MCP";
    const trustText = document.createElement("p");
    trustText.textContent = "新增後所有工具立即可用；風險標示由伺服器提供，僅供參考。";
    trustCopy.append(trustTitle, trustText);
    trust.append(trustMark, trustCopy);

    this.servers.className = "mcp-servers";

    this.addDialog.className = "mcp-add-dialog";
    this.addDialog.setAttribute("aria-labelledby", "mcp-add-title");
    const dialogHeader = document.createElement("header");
    const dialogHeading = document.createElement("div");
    const dialogTitle = document.createElement("h2");
    dialogTitle.id = "mcp-add-title";
    dialogTitle.textContent = "加入 MCP";
    dialogHeading.append(dialogTitle);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "mcp-dialog-close";
    close.setAttribute("aria-label", "關閉加入 MCP 視窗");
    close.textContent = "×";
    dialogHeader.append(dialogHeading, close);
    this.form.className = "mcp-add-form";
    const formIntro = document.createElement("div");
    formIntro.className = "mcp-form-intro";
    const formNote = document.createElement("p");
    formNote.textContent = "加入後會開啟所有工具。只使用信任的程式；金鑰請放在環境變數。";
    formIntro.append(formNote);
    for (const [value, label] of [
      ["stdio", "本機程式（stdio）"],
      ["http", "遠端網址（Streamable HTTP）"],
    ] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      this.transport.append(option);
    }
    this.name.placeholder = "例如 Chrome DevTools";
    this.name.required = true;
    this.name.maxLength = 80;
    this.target.required = true;
    this.args.placeholder = "每行一個參數（可留空）";
    this.cwd.placeholder = "工作目錄（可留空）";
    this.submit.type = "submit";
    this.submit.textContent = "加入並開啟工具";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "取消";
    const formActions = document.createElement("div");
    formActions.className = "mcp-form-actions";
    formActions.append(cancel, this.submit);
    const transportLabel = this.field("連線方式", this.transport);
    const nameLabel = this.field("名稱", this.name);
    const targetField = this.field("啟動程式", this.target);
    this.targetLabel = targetField.querySelector("span") as HTMLSpanElement;
    const argsField = this.field("啟動參數", this.args);
    argsField.classList.add("mcp-stdio-field");
    const cwdField = this.field("工作目錄", this.cwd);
    cwdField.classList.add("mcp-stdio-field");
    this.form.append(
      formIntro,
      transportLabel,
      nameLabel,
      targetField,
      argsField,
      cwdField,
      formActions,
    );
    this.addDialog.append(dialogHeader, this.form);

    this.root.append(heading, trust, this.servers, this.addDialog);
    container.append(this.root);

    this.addButton.onclick = (event) => {
      if (!event.isTrusted || !this.available || this.busy) return;
      this.addDialog.showModal();
      queueMicrotask(() => this.name.focus());
    };
    close.onclick = () => this.addDialog.close();
    cancel.onclick = () => this.addDialog.close();
    this.addDialog.onclick = (event) => {
      if (event.target === this.addDialog) this.addDialog.close();
    };
    this.transport.onchange = () => this.updateTransport();
    this.form.onsubmit = (event) => {
      event.preventDefault();
      if (event.isTrusted) void this.add();
    };
    this.updateTransport();
    this.render();
  }

  private field(label: string, control: HTMLElement) {
    const field = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = label;
    field.append(text, control);
    return field;
  }

  private updateTransport() {
    const stdio = this.transport.value === "stdio";
    this.targetLabel.textContent = stdio ? "啟動程式" : "MCP URL";
    this.target.placeholder = stdio ? "例如 npx.cmd" : "https://…/mcp 或 http://127.0.0.1:…";
    for (const field of this.form.querySelectorAll<HTMLElement>(".mcp-stdio-field"))
      field.hidden = !stdio;
  }

  private async act(body: unknown) {
    if (this.busy || !this.available) return;
    this.busy = true;
    this.render(undefined, this.available);
    try {
      this.state = await this.change(body);
      this.report("");
    } catch (cause) {
      this.report(cause instanceof Error ? cause.message : "MCP 設定尚未確認，請再試一次。");
    } finally {
      this.busy = false;
      this.render(undefined, this.available);
    }
  }

  private async add() {
    const name = this.name.value.trim();
    const target = this.target.value.trim();
    if (!name || !target) return;
    const stdio = this.transport.value === "stdio";
    await this.act(
      stdio
        ? {
            action: "add_stdio",
            name,
            command: target,
            args: this.args.value
              .split(/\r?\n/)
              .map((value) => value.trim())
              .filter(Boolean),
            ...(this.cwd.value.trim() ? { cwd: this.cwd.value.trim() } : {}),
          }
        : { action: "add_http", name, url: target, header_env: {} },
    );
    if (this.state?.servers.some((server) => server.name === name)) {
      this.name.value = "";
      this.target.value = "";
      this.args.value = "";
      this.cwd.value = "";
      this.addDialog.close();
    }
  }

  render(next?: McpPanelState, available = this.available) {
    if (next) this.state = next;
    this.available = available;
    const openServers = new Set(
      [...this.servers.querySelectorAll<HTMLDetailsElement>(".mcp-tool-details[open]")]
        .map((details) => details.dataset.serverId)
        .filter((id): id is string => Boolean(id)),
    );
    const toolScroll = new Map(
      [...this.servers.querySelectorAll<HTMLElement>(".mcp-tools[data-server-id]")].map(
        (tools) => [tools.dataset.serverId as string, tools.scrollTop] as const,
      ),
    );
    const servers = this.state?.servers ?? [];
    const enabledServers = servers.filter((server) => server.enabled).length;
    const enabledTools = servers
      .filter((server) => server.enabled)
      .flatMap((server) => server.tools)
      .filter((tool) => tool.enabled).length;
    this.status.textContent = !available
      ? "正在連接本機"
      : servers.length
        ? `${enabledServers}/${servers.length} 台開啟 · ${enabledTools} 個工具`
        : "尚未加入 MCP";
    this.status.classList.toggle("offline", !available);
    this.addButton.disabled = this.busy || !available;
    this.submit.disabled = this.busy || !available;
    this.transport.disabled =
      this.name.disabled =
      this.target.disabled =
      this.args.disabled =
      this.cwd.disabled =
        this.busy || !available;
    this.servers.replaceChildren();
    if (!servers.length) {
      const empty = document.createElement("div");
      empty.className = "mcp-empty";
      const title = document.createElement("strong");
      title.textContent = "還沒有 MCP";
      const copy = document.createElement("p");
      copy.textContent = "加入一台伺服器後，它的工具會出現在 Kairomes 即時目錄。";
      empty.append(title, copy);
      this.servers.append(empty);
      return;
    }

    for (const server of servers) {
      const card = document.createElement("article");
      card.className = `mcp-server${server.enabled ? "" : " disabled"}`;
      const heading = document.createElement("header");
      const identity = document.createElement("div");
      identity.className = "mcp-server-identity";
      const stateDot = document.createElement("i");
      stateDot.dataset.state = server.enabled ? server.state : "disabled";
      const copy = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = server.name;
      const meta = document.createElement("span");
      const enabled = server.tools.filter((tool) => tool.enabled).length;
      meta.textContent = server.enabled
        ? `${server.transport.toUpperCase()} · ${stateLabels[server.state]} · ${enabled}/${server.tools.length} 個工具可用`
        : `${server.transport.toUpperCase()} · 整台已停用 · 保留 ${enabled} 個工具設定`;
      copy.append(name, meta);
      identity.append(stateDot, copy);
      const master = switchButton(
        server.enabled,
        `${server.name} ${server.enabled ? "已開啟" : "已關閉"}`,
      );
      master.disabled = this.busy || !available;
      master.onclick = (event) => {
        if (!event.isTrusted) return;
        void this.act({
          action: "set_server_enabled",
          server_id: server.id,
          enabled: !server.enabled,
        });
      };
      heading.append(identity, master);
      card.append(heading);

      if (server.message) {
        const message = document.createElement("p");
        message.className = "mcp-server-message";
        message.textContent = server.message;
        card.append(message);
      }

      const details = document.createElement("details");
      details.className = "mcp-tool-details";
      details.dataset.serverId = server.id;
      details.open = openServers.has(server.id);
      const summary = document.createElement("summary");
      summary.textContent = `管理 ${server.tools.length} 個工具`;
      const tools = document.createElement("div");
      tools.className = "mcp-tools";
      tools.dataset.serverId = server.id;
      for (const tool of server.tools) {
        const row = document.createElement("div");
        row.className = "mcp-tool";
        const toolCopy = document.createElement("div");
        const toolName = document.createElement("strong");
        toolName.textContent = tool.title ?? tool.name;
        const description = document.createElement("span");
        description.textContent = tool.description ?? tool.name;
        const risks = document.createElement("div");
        risks.className = "mcp-risk-labels";
        for (const [kind, label] of riskLabels(tool)) {
          const risk = document.createElement("small");
          risk.className = kind;
          risk.textContent = label;
          risks.append(risk);
        }
        toolCopy.append(toolName, description, risks);
        const toggle = switchButton(
          tool.enabled,
          `${tool.title ?? tool.name} ${tool.enabled ? "已開啟" : "已關閉"}`,
        );
        toggle.disabled = this.busy || !available;
        toggle.onclick = (event) => {
          if (!event.isTrusted) return;
          void this.act({
            action: "set_tool_enabled",
            server_id: server.id,
            tool_name: tool.name,
            enabled: !tool.enabled,
          });
        };
        row.append(toolCopy, toggle);
        tools.append(row);
      }
      if (!server.tools.length) {
        const empty = document.createElement("p");
        empty.className = "mcp-tools-empty";
        empty.textContent =
          server.state === "ready" ? "這台伺服器沒有公開工具。" : "重新探索後顯示工具。";
        tools.append(empty);
      }
      details.append(summary, tools);
      card.append(details);
      const previousScroll = toolScroll.get(server.id);
      if (previousScroll) queueMicrotask(() => (tools.scrollTop = previousScroll));

      const actions = document.createElement("footer");
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.textContent = "重新探索";
      refresh.onclick = (event) => {
        if (event.isTrusted) void this.act({ action: "refresh", server_id: server.id });
      };
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "解除掛載";
      remove.onclick = (event) => {
        if (!event.isTrusted || !window.confirm(`解除「${server.name}」的 MCP 掛載？`)) return;
        void this.act({ action: "remove", server_id: server.id });
      };
      refresh.disabled = remove.disabled = this.busy || !available;
      actions.append(refresh, remove);
      card.append(actions);
      this.servers.append(card);
    }
  }
}
