import {
  MCP_AUTH_LIMITS,
  type McpAuthInput,
  type McpAuthResult,
  type McpCatalogTool,
  type McpPanelState,
} from "@kairomes/protocol";
import { mcpAuthDiagnostic } from "./mcp-auth-diagnostic.ts";
import {
  type McpAuthIdentity,
  McpAuthStorageConflict,
  McpAuthTracker,
  mcpAuthPresentation,
  type SavedMcpAuth,
} from "./mcp-auth-tracker.ts";
import { filterMcpCatalog, type McpToolFilter } from "./mcp-filter.ts";
import {
  type McpMutationBody,
  type McpMutationScope,
  McpMutationTracker,
  mcpAddFingerprint,
  readMcpMutationState,
  settleMcpMutation,
} from "./mcp-mutation.ts";

const stateLabels = {
  disconnected: "尚未連線",
  connecting: "連線中",
  ready: "已連線",
  unavailable: "無法連線",
} as const;

type Server = McpPanelState["servers"][number];
export interface McpAuthPanelOptions {
  context(): { source: string; instanceId: string } | undefined;
  request(body: McpAuthInput): Promise<McpAuthResult>;
  load(identity: McpAuthIdentity): Promise<unknown>;
  save(identity: McpAuthIdentity, next: SavedMcpAuth | undefined, expected: unknown): Promise<void>;
  refresh(): void;
}

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
  private readonly dialogResult = document.createElement("p");
  private readonly formNote = document.createElement("p");
  private readonly reconcileButton = document.createElement("button");
  private readonly search = document.createElement("input");
  private readonly serverFilter = document.createElement("select");
  private readonly toolFilter = document.createElement("select");
  private readonly matchStatus = document.createElement("span");
  private readonly clearFilters = document.createElement("button");
  private state?: McpPanelState;
  private available = false;
  private busy = false;
  private adding = false;
  private readonly mutation = new McpMutationTracker();
  private dialogScope?: McpMutationScope;
  private reviewRequired = false;
  private pendingFocus: string | undefined;
  private readonly auth = new McpAuthTracker();
  private authSource?: string;
  private readonly authBusy = new Set<string>();
  private readonly authStarting = new Set<string>();
  private readonly authReads = new Set<string>();
  private readonly authLoaded = new Set<string>();
  private readonly authBaseline = new Map<string, unknown>();
  private readonly authLoadFailed = new Set<string>();
  private readonly authAnnouncement = document.createElement("p");
  private readonly authLabels = new Map<string, string>();

  constructor(
    container: HTMLElement,
    private readonly change: (body: unknown) => Promise<McpPanelState>,
    private readonly report: (message: string) => void,
    private readonly source: () => string | undefined = () => undefined,
    private readonly authOptions?: McpAuthPanelOptions,
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

    const filters = document.createElement("div");
    filters.className = "mcp-filters";
    this.search.type = "search";
    this.search.placeholder = "搜尋工具";
    this.search.setAttribute("aria-label", "搜尋工具名稱或描述");
    this.serverFilter.setAttribute("aria-label", "篩選 MCP 伺服器");
    this.toolFilter.setAttribute("aria-label", "篩選工具設定");
    for (const [value, label] of [
      ["all", "全部工具"],
      ["enabled", "已開啟"],
      ["disabled", "已關閉"],
      ["read_only", "唯讀標示"],
    ] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      this.toolFilter.append(option);
    }
    this.clearFilters.type = "button";
    this.clearFilters.textContent = "清除篩選";
    this.clearFilters.onclick = () => {
      this.search.value = "";
      this.serverFilter.value = "";
      this.toolFilter.value = "all";
      this.render();
      this.search.focus();
    };
    this.matchStatus.setAttribute("role", "status");
    this.matchStatus.setAttribute("aria-live", "polite");
    const filterResult = document.createElement("div");
    filterResult.className = "mcp-filter-result";
    filterResult.append(this.matchStatus, this.clearFilters);
    filters.append(this.search, this.serverFilter, this.toolFilter, filterResult);
    this.search.oninput = () => this.render();
    this.serverFilter.onchange = this.toolFilter.onchange = () => this.render();
    const help = document.createElement("details");
    help.className = "mcp-filter-help";
    const helpTitle = document.createElement("summary");
    helpTitle.textContent = "工具權限";
    const helpCopy = document.createElement("p");
    helpCopy.textContent = "風險標示由伺服器提供，僅供參考。伺服器停用時保留個別工具設定。";
    help.append(helpTitle, helpCopy);

    this.servers.className = "mcp-servers";

    this.addDialog.className = "mcp-add-dialog";
    this.addDialog.setAttribute("aria-labelledby", "mcp-add-title");
    const dialogHeader = document.createElement("header");
    const dialogHeading = document.createElement("div");
    const dialogTitle = document.createElement("h2");
    dialogTitle.id = "mcp-add-title";
    dialogTitle.textContent = "加入 MCP";
    dialogTitle.tabIndex = -1;
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
    formIntro.append(this.formNote);
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
    this.dialogResult.className = "mcp-dialog-result";
    this.dialogResult.setAttribute("role", "alert");
    this.dialogResult.hidden = true;
    this.reconcileButton.type = "button";
    this.reconcileButton.className = "secondary";
    this.reconcileButton.hidden = true;
    this.reconcileButton.onclick = (event) => {
      if (!event.isTrusted || this.busy) return;
      if (this.uncertain) void this.reconcile();
      else this.addDialog.close();
    };
    formActions.append(this.reconcileButton);
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
      this.dialogResult,
      formActions,
    );
    this.addDialog.append(dialogHeader, this.form);

    this.root.append(heading, filters, this.servers, help, this.addDialog);
    this.authAnnouncement.className = "visually-hidden";
    this.authAnnouncement.setAttribute("role", "status");
    this.authAnnouncement.setAttribute("aria-live", "polite");
    this.authAnnouncement.setAttribute("aria-atomic", "true");
    this.root.append(this.authAnnouncement);
    container.append(this.root);

    this.addButton.onclick = (event) => {
      if (!event.isTrusted || !this.available || this.busy || this.uncertain) return;
      this.reviewRequired = false;
      this.dialogResult.textContent = "";
      this.dialogResult.hidden = this.reconcileButton.hidden = true;
      const scope = this.mutation.capture();
      this.dialogScope = scope;
      this.addDialog.showModal();
      queueMicrotask(() => {
        if (this.isMutationCurrent(scope) && this.addDialog.open) this.name.focus();
      });
    };
    close.onclick = () => this.addDialog.close();
    cancel.onclick = () => this.addDialog.close();
    this.addDialog.onclick = (event) => {
      if (event.target === this.addDialog) this.addDialog.close();
    };
    this.addDialog.addEventListener("close", () => {
      if (this.addDialog.open) return;
      const scope = this.dialogScope;
      this.dialogScope = undefined;
      if (!scope || !this.isMutationCurrent(scope)) return;
      if (this.dialogResult.textContent) this.report(this.dialogResult.textContent);
      this.reviewRequired = false;
      this.dialogResult.hidden = this.reconcileButton.hidden = true;
      this.render();
      if (!this.addButton.disabled) this.addButton.focus();
      else title.focus({ preventScroll: true });
    });
    this.transport.onchange = () => this.updateTransport();
    this.form.onsubmit = (event) => {
      event.preventDefault();
      if (event.isTrusted) void this.add();
    };
    this.updateTransport();
    this.render();
    const authTimer = setInterval(() => {
      if (!this.available) return;
      for (const server of this.state?.servers ?? []) {
        const identity = this.authIdentity(server);
        const pending = identity ? this.auth.current(identity) : undefined;
        if (pending && !pending.unknown && !this.authBusy.has(server.id))
          void this.authAction(server, "query", true);
      }
    }, 1500);
    window.addEventListener("pagehide", () => clearInterval(authTimer), { once: true });
  }

  private field(label: string, control: HTMLElement) {
    const field = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = label;
    field.append(text, control);
    return field;
  }

  private authIdentity(server: Server): McpAuthIdentity | undefined {
    const context = this.authOptions?.context();
    if (!context || !server.auth || !server.config_fingerprint) return;
    return {
      instance_id: context.instanceId,
      server_id: server.id,
      config_fingerprint: server.config_fingerprint,
    };
  }
  private authKey(identity: McpAuthIdentity) {
    return `${identity.server_id}:${identity.config_fingerprint}`;
  }
  private syncAuth() {
    const source = this.authOptions?.context()?.source;
    if (source === this.authSource) return;
    this.authSource = source;
    this.auth.bind(source);
    this.authBusy.clear();
    this.authStarting.clear();
    this.authReads.clear();
    this.authLoaded.clear();
    this.authBaseline.clear();
    this.authLoadFailed.clear();
    this.authLabels.clear();
    this.authAnnouncement.textContent = "";
  }
  private prepareAuth(server: Server, identity: McpAuthIdentity) {
    const context = this.authOptions?.context();
    if (!context || !this.authOptions || !server.auth) return;
    this.auth.observeSummary(identity, server.auth);
    const key = this.authKey(identity);
    if (this.authLoaded.has(key) || this.authBusy.has(server.id)) return;
    this.authBusy.add(server.id);
    void this.authOptions
      .load(identity)
      .then((saved) => {
        if (this.authOptions?.context()?.source !== context.source) return;
        this.authBaseline.set(key, saved);
        if (saved !== undefined && !this.auth.restore(context.source, identity, saved))
          this.authLoadFailed.add(key);
        this.authLoaded.add(key);
      })
      .catch(() => {
        if (this.authOptions?.context()?.source === context.source) {
          this.authLoadFailed.add(key);
          this.authLoaded.add(key);
        }
      })
      .finally(() => {
        if (this.authOptions?.context()?.source !== context.source) return;
        this.authBusy.delete(server.id);
        this.render();
        if (this.auth.current(identity) && !this.authLoadFailed.has(key))
          void this.authAction(server, "query", true);
      });
  }
  private async authAction(
    server: Server,
    action: "start" | "cancel" | "forget" | "query",
    quiet = false,
  ) {
    const options = this.authOptions;
    const context = options?.context();
    const identity = this.authIdentity(server);
    if (
      !options ||
      !context ||
      !identity ||
      !this.available ||
      (action !== "query" && (this.uncertain || this.busy)) ||
      this.authBusy.has(server.id) ||
      (action === "query" && this.authReads.has(server.id)) ||
      !this.authLoaded.has(this.authKey(identity)) ||
      (action !== "forget" && this.authLoadFailed.has(this.authKey(identity)))
    )
      return;
    const current = () =>
      options.context()?.source === context.source &&
      this.state?.servers.some(
        (item) => item.id === server.id && item.config_fingerprint === identity.config_fingerprint,
      );
    const key = this.authKey(identity);
    const baseline = this.authBaseline.get(key);
    const querySnapshot = this.auth.saved(identity);
    const presentationSnapshot = JSON.stringify({
      pending: this.auth.current(identity),
      summary: this.auth.summary(identity),
    });
    const phaseAtRequest = this.auth.summary(identity)?.phase_version;
    let request: McpAuthInput | undefined;
    if (action === "query") request = this.auth.query(identity);
    else if (action === "cancel") request = this.auth.cancel(context.source, identity);
    else {
      const intent: Extract<McpAuthInput, { action: "start" | "forget" }> = {
        ...identity,
        action: action === "start" ? "start" : "forget",
        operation_id: crypto.randomUUID(),
        accept_before: new Date(Date.now() + MCP_AUTH_LIMITS.admissionMs).toISOString(),
      };
      if (!this.auth.begin(context.source, intent)) return;
      request = intent;
    }
    if (!request) return;
    if (quiet) this.authReads.add(server.id);
    else {
      this.authBusy.add(server.id);
      if (action === "start") this.authStarting.add(server.id);
      this.render();
    }
    let persisted = baseline;
    try {
      if (action !== "query") {
        const saved = this.auth.saved(identity);
        await options.save(identity, saved, baseline);
        persisted = saved;
        if (!current()) return;
        this.authBaseline.set(key, saved);
      }
      const result = await options.request(request);
      if (!current()) return;
      if (action === "query" && !this.auth.queryStillCurrent(context.source, querySnapshot)) return;
      if (!this.auth.accept(context.source, result)) this.auth.markUnknown(context.source, request);
      else this.authLoadFailed.delete(key);
      const saved = this.auth.saved(identity);
      if (JSON.stringify(saved) !== JSON.stringify(persisted))
        await options.save(identity, saved, persisted);
      if (!current()) return;
      this.authBaseline.set(key, saved);
      if (
        phaseAtRequest !== this.auth.summary(identity)?.phase_version ||
        !this.auth.current(identity)
      )
        options.refresh();
    } catch (cause) {
      if (!current()) return;
      if (action === "query" && !this.auth.queryStillCurrent(context.source, querySnapshot)) return;
      if (cause instanceof McpAuthStorageConflict) {
        this.authBaseline.set(key, cause.saved);
        if (cause.saved === undefined) {
          if (baseline !== undefined) this.auth.restore(context.source, identity, baseline);
          this.auth.markUnknown(context.source, request);
        } else if (!this.auth.restore(context.source, identity, cause.saved))
          this.authLoadFailed.add(key);
      } else {
        if (persisted === baseline && action !== "query") this.auth.reject(context.source, request);
        else {
          if (!this.auth.current(identity) && persisted !== undefined)
            this.auth.restore(context.source, identity, persisted);
          this.auth.markUnknown(context.source, request);
        }
      }
    } finally {
      if (options.context()?.source === context.source) {
        if (quiet) this.authReads.delete(server.id);
        else this.authBusy.delete(server.id);
        if (action === "start") this.authStarting.delete(server.id);
        if (
          !quiet ||
          presentationSnapshot !==
            JSON.stringify({
              pending: this.auth.current(identity),
              summary: this.auth.summary(identity),
            })
        )
          this.render();
      }
    }
  }

  private updateTransport() {
    const stdio = this.transport.value === "stdio";
    this.formNote.textContent = stdio
      ? "加入後會開啟所有工具。只使用信任的程式；金鑰請放在環境變數。"
      : "只加入信任的服務。";
    this.submit.textContent = stdio ? "加入並開啟工具" : "儲存";
    this.targetLabel.textContent = stdio ? "啟動程式" : "MCP URL";
    this.target.placeholder = stdio ? "例如 npx.cmd" : "https://…/mcp 或 http://127.0.0.1:…";
    for (const field of this.form.querySelectorAll<HTMLElement>(".mcp-stdio-field"))
      field.hidden = !stdio;
  }

  private get uncertain() {
    return this.mutation.isLocked(this.source());
  }

  private isMutationCurrent(scope: McpMutationScope) {
    return this.source() === scope.source && this.mutation.isCurrent(scope);
  }

  private syncMutation() {
    if (!this.mutation.bind(this.source())) return;
    this.state = undefined;
    this.busy = this.adding = this.reviewRequired = false;
    this.pendingFocus = this.dialogScope = undefined;
    this.dialogResult.textContent = "";
    this.dialogResult.hidden = this.reconcileButton.hidden = true;
    if (this.addDialog.open) this.addDialog.close();
    this.search.value = this.serverFilter.value = "";
    this.toolFilter.value = "all";
    this.servers.replaceChildren();
  }

  get hasUncertainMutation() {
    return this.uncertain;
  }

  private async act(body: McpMutationBody) {
    this.syncMutation();
    if (this.busy || !this.available || this.uncertain || this.reviewRequired) return false;
    if (!this.state) return false;
    const base = structuredClone(this.state);
    const source = this.source();
    const scope = this.mutation.capture();
    const current = () => this.isMutationCurrent(scope);
    this.pendingFocus = (document.activeElement as HTMLElement | null)?.dataset.mcpFocus;
    this.busy = true;
    this.render(undefined, this.available);
    try {
      const fingerprint = await mcpAddFingerprint(body);
      if (!current()) return false;
      if ((body.action === "add_stdio" || body.action === "add_http") && !fingerprint) {
        if (this.addDialog.open) {
          this.report("");
          this.dialogResult.textContent = "請檢查連線設定。";
          this.dialogResult.hidden = false;
          this.reconcileButton.hidden = true;
        } else this.report("請檢查連線設定。");
        return false;
      }
      if (!this.available || !current() || !this.mutation.begin(base, body, source, fingerprint))
        return false;
      const result = await settleMcpMutation(
        async (requestBody) => {
          if (!current()) throw new Error("連線已變更。");
          const adding =
            requestBody === body && (body.action === "add_stdio" || body.action === "add_http");
          if (adding) {
            this.adding = true;
            this.render();
          }
          try {
            return await this.change(requestBody);
          } finally {
            if (adding && current()) {
              this.adding = false;
              this.render();
            }
          }
        },
        body,
        () => {
          this.reviewRequired = this.addDialog.open;
          this.showResult("結果待確認。");
          this.render();
        },
        (state) => this.mutation.observe(state, source),
        current,
      );
      if (!current()) return false;
      if (result.state) this.state = result.state;
      if (result.outcome === "unknown") {
        this.showReconciliation(false);
        return false;
      }
      if (result.outcome === "applied") this.mutation.acknowledge(source);
      this.reviewRequired = result.outcome === "reconciled" && this.addDialog.open;
      if (result.outcome === "reconciled") this.showReconciliation(true);
      else this.showResult("");
      return result.outcome === "applied";
    } finally {
      if (current()) {
        this.busy = false;
        this.render(undefined, this.available);
        this.pendingFocus = undefined;
      }
    }
  }

  private showResult(message: string) {
    if (this.addDialog.open) {
      this.report("");
      this.dialogResult.textContent = message;
      this.dialogResult.hidden = !message;
      this.reconcileButton.hidden = !message;
      this.reconcileButton.textContent = this.uncertain ? "查詢狀態" : "查看目錄";
    } else this.report(message);
  }

  private showReconciliation(observed: boolean) {
    const unresolved =
      this.mutation.diagnostic(this.state, this.source()) === "missing_fingerprint"
        ? "無法核對設定；請更新 Kairomes。"
        : "結果待確認。";
    this.showResult(observed ? (this.addDialog.open ? "目錄已更新，請核對。" : "") : unresolved);
  }

  async reconcile() {
    this.syncMutation();
    if (this.busy || !this.available || !this.uncertain) return;
    const scope = this.mutation.capture();
    const current = () => this.isMutationCurrent(scope);
    this.busy = true;
    this.render();
    try {
      const result = await readMcpMutationState(() => this.change({ action: "list" }), current);
      if (!result) return;
      this.state = result.state;
      const observed = this.mutation.observe(this.state, scope.source);
      this.showReconciliation(observed);
    } catch {
      if (current()) this.showResult("結果待確認。");
    } finally {
      if (current()) {
        this.busy = false;
        this.render();
      }
    }
  }

  private async add() {
    this.syncMutation();
    const scope = this.mutation.capture();
    const name = this.name.value.trim();
    const target = this.target.value.trim();
    if (!name || !target) return;
    const stdio = this.transport.value === "stdio";
    const previousIds = new Set(this.state?.servers.map((server) => server.id));
    const added = await this.act(
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
    if (
      added &&
      this.isMutationCurrent(scope) &&
      this.state?.servers.some((server) => server.name === name && !previousIds.has(server.id))
    ) {
      this.name.value = "";
      this.target.value = "";
      this.args.value = "";
      this.cwd.value = "";
      this.addDialog.close();
    }
  }

  render(next?: McpPanelState, available = this.available) {
    this.syncMutation();
    if (next && !this.busy) {
      this.state = next;
      if (this.uncertain) this.showReconciliation(this.mutation.observe(next, this.source()));
    }
    this.available = available;
    this.syncAuth();
    const canChange = available && Boolean(this.state) && !this.uncertain;
    const openServers = new Set(
      [...this.servers.querySelectorAll<HTMLDetailsElement>(".mcp-tool-details[open]")]
        .map((details) => details.dataset.serverId)
        .filter((id): id is string => Boolean(id)),
    );
    const openTools = new Set(
      [...this.servers.querySelectorAll<HTMLDetailsElement>(".mcp-tool-info[open]")].map(
        (details) => details.dataset.toolKey,
      ),
    );
    const openManagement = new Set(
      [...this.servers.querySelectorAll<HTMLDetailsElement>(".mcp-management[open]")].map(
        (details) => details.dataset.serverId,
      ),
    );
    const openDiagnostics = new Set(
      [...this.servers.querySelectorAll<HTMLDetailsElement>(".mcp-diagnostic[open]")].map(
        (details) => details.dataset.serverId,
      ),
    );
    const activeKey =
      (document.activeElement as HTMLElement | null)?.dataset.mcpFocus ??
      (document.activeElement === document.body ? this.pendingFocus : undefined);
    const servers = this.state?.servers ?? [];
    const selectedServer = this.serverFilter.value;
    const options = [{ id: "", name: "全部伺服器" }, ...servers];
    // Keep the same select node (and keyboard focus) across fresh catalogs.
    this.serverFilter.replaceChildren(
      ...options.map((server) => {
        const option = document.createElement("option");
        option.value = server.id;
        option.textContent = server.name;
        return option;
      }),
    );
    this.serverFilter.value = options.some((server) => server.id === selectedServer)
      ? selectedServer
      : "";
    const filtering = Boolean(
      this.search.value.trim() || this.serverFilter.value || this.toolFilter.value !== "all",
    );
    const filtered = this.state
      ? filterMcpCatalog(this.state, {
          query: this.search.value,
          serverId: this.serverFilter.value,
          tools: this.toolFilter.value as McpToolFilter,
        })
      : [];
    this.clearFilters.hidden = this.matchStatus.hidden = !filtering;
    const matches = filtering
      ? `${filtered.reduce((count, item) => count + item.tools.length, 0)} 個符合`
      : "";
    if (this.matchStatus.textContent !== matches) this.matchStatus.textContent = matches;
    const enabledServers = servers.filter((server) => server.enabled).length;
    const enabledTools = servers
      .filter((server) => server.enabled)
      .flatMap((server) => server.tools)
      .filter((tool) => tool.enabled).length;
    const status = !available
      ? "目錄待確認"
      : servers.length
        ? `${enabledServers}/${servers.length} 台開啟 · ${enabledTools} 個工具開啟`
        : "";
    if (this.status.textContent !== status) this.status.textContent = status;
    this.status.hidden = this.uncertain || !status;
    this.status.classList.toggle("offline", !available);
    this.addButton.textContent = this.adding ? "正在加入…" : "＋ 加入 MCP";
    this.submit.textContent =
      this.transport.value === "http"
        ? this.adding
          ? "儲存中…"
          : "儲存"
        : this.adding
          ? "正在加入…"
          : "加入並開啟工具";
    this.addButton.disabled = this.busy || !canChange;
    this.submit.disabled = this.busy || !canChange || this.reviewRequired;
    this.reconcileButton.disabled = this.busy || !available;
    this.transport.disabled =
      this.name.disabled =
      this.target.disabled =
      this.args.disabled =
      this.cwd.disabled =
        this.busy || !canChange || this.reviewRequired;
    this.servers.replaceChildren();
    if (!servers.length) {
      const empty = document.createElement("div");
      empty.className = "mcp-empty";
      const copy = document.createElement("p");
      copy.textContent = "尚未加入 MCP";
      empty.append(copy);
      this.servers.append(empty);
      return;
    }
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "mcp-tools-empty";
      empty.textContent = "沒有符合的工具";
      this.servers.append(empty);
    }

    const authAnnouncements: string[] = [];
    for (const { server, tools: visibleTools } of filtered) {
      const authIdentity = this.authIdentity(server);
      if (authIdentity) this.prepareAuth(server, authIdentity);
      const authSummary = authIdentity
        ? (this.auth.summary(authIdentity) ?? server.auth)
        : undefined;
      const authPending = authIdentity ? this.auth.current(authIdentity) : undefined;
      const authView = authSummary
        ? mcpAuthPresentation(authSummary, authPending, this.authStarting.has(server.id))
        : undefined;
      if (authIdentity && authView) {
        const key = this.authKey(authIdentity);
        const previousLabel = this.authLabels.get(key);
        if (previousLabel !== undefined && previousLabel !== authView.label)
          authAnnouncements.push(`${server.name}：${authView.label}`);
        this.authLabels.set(key, authView.label);
      }
      const authLoadingFailed = authIdentity && this.authLoadFailed.has(this.authKey(authIdentity));
      const toolsCurrent =
        !server.auth ||
        Boolean(
          authSummary?.tools_status === "current" &&
            server.auth.tools_status === "current" &&
            server.auth.phase_version >= authSummary.phase_version,
        );
      const serverCanChange = canChange && !authPending?.unknown && !this.authBusy.has(server.id);
      const card = document.createElement("article");
      card.className = `mcp-server${server.enabled ? "" : " disabled"}`;
      card.tabIndex = -1;
      card.dataset.mcpFocus = `card:${server.id}`;
      card.setAttribute("aria-label", server.name);
      const heading = document.createElement("header");
      const identity = document.createElement("div");
      identity.className = "mcp-server-identity";
      const stateDot = document.createElement("i");
      stateDot.dataset.state = !server.enabled
        ? "disabled"
        : !authSummary
          ? server.state
          : authSummary.auth_phase === "authenticated" && authSummary.tools_status === "current"
            ? "ready"
            : ["starting", "waiting", "verifying"].includes(authSummary.auth_phase) ||
                authSummary.tools_status === "loading"
              ? "connecting"
              : "unavailable";
      const copy = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = server.name;
      const meta = document.createElement("span");
      const enabled = server.tools.filter((tool) => tool.enabled).length;
      meta.textContent = server.enabled
        ? `${server.transport.toUpperCase()} · ${authLoadingFailed ? "登入狀態待確認" : (authView?.label ?? stateLabels[server.state])}${!server.auth ? ` · ${enabled}/${server.tools.length} 開啟` : ""}`
        : `${server.transport.toUpperCase()} · 已停用`;
      copy.append(name, meta);
      identity.append(stateDot, copy);
      const master = switchButton(
        server.enabled,
        `${server.name} ${server.enabled ? "已開啟" : "已關閉"}`,
      );
      master.disabled = this.busy || !serverCanChange;
      master.dataset.mcpFocus = `server:${server.id}`;
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

      if ((server.message && !server.auth) || server.auth) {
        const diagnostic = document.createElement("details");
        diagnostic.className = `mcp-diagnostic${server.auth ? " mcp-auth-diagnostic" : ""}`;
        diagnostic.dataset.serverId = server.id;
        diagnostic.open = openDiagnostics.has(server.id);
        const label = document.createElement("summary");
        label.textContent = server.auth ? "連線詳情" : "連線原因";
        label.dataset.mcpFocus = `diagnostic:${server.id}`;
        const message = document.createElement("div");
        message.className = "mcp-server-message";
        if (server.auth) {
          const summary = authSummary ?? server.auth;
          const reason = mcpAuthDiagnostic(summary.error_code);
          if (reason) {
            const explanation = document.createElement("p");
            explanation.textContent = reason.message;
            message.append(explanation);
          }
          if (summary.login_domain) {
            const domain = document.createElement("p");
            domain.textContent = `登入網站：${summary.login_domain}`;
            message.append(domain);
          }
          const note = document.createElement("p");
          note.textContent = "重啟後需再登入。";
          message.append(note);
        } else message.textContent = server.message ?? "";
        diagnostic.append(label, message);
        card.append(diagnostic);
      }

      const details = document.createElement("details");
      details.className = "mcp-tool-details";
      details.dataset.serverId = server.id;
      details.open = filtering || openServers.has(server.id);
      const summary = document.createElement("summary");
      summary.dataset.mcpFocus = `tools:${server.id}`;
      summary.textContent =
        server.auth && !toolsCurrent
          ? server.tools.length
            ? `上次工具 ${visibleTools.length}`
            : "工具"
          : `工具 ${visibleTools.length}`;
      const tools = document.createElement("div");
      tools.className = "mcp-tools";
      tools.dataset.serverId = server.id;
      for (const tool of visibleTools) {
        const row = document.createElement("div");
        row.className = "mcp-tool";
        const toolCopy = document.createElement("details");
        toolCopy.className = "mcp-tool-info";
        const key = `${server.id}:${tool.name}`;
        toolCopy.dataset.toolKey = key;
        toolCopy.open = openTools.has(key);
        const toolName = document.createElement("summary");
        toolName.textContent = tool.name;
        toolName.dataset.mcpFocus = `info:${key}`;
        const description = document.createElement("p");
        description.textContent = tool.description ?? tool.title ?? "無描述";
        const risks = document.createElement("div");
        risks.className = "mcp-risk-labels";
        for (const [kind, label] of riskLabels(tool)) {
          const risk = document.createElement("small");
          risk.className = kind;
          risk.textContent = label;
          risks.append(risk);
        }
        toolCopy.append(toolName, description, risks);
        if (tool.availability === "unavailable" || tool.availability === "schema_changed") {
          const availability = document.createElement("small");
          availability.className = "mcp-tool-availability";
          availability.textContent = {
            unavailable: "無法使用",
            schema_changed: "定義已變更",
          }[tool.availability];
          toolName.append(availability);
        }
        const toggle = switchButton(
          tool.enabled,
          `${tool.title ?? tool.name} ${tool.enabled ? "已開啟" : "已關閉"}`,
        );
        toggle.disabled = this.busy || !serverCanChange || !toolsCurrent;
        toggle.dataset.mcpFocus = `toggle:${key}`;
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
      if (!server.tools.length && (!server.auth || toolsCurrent)) {
        const empty = document.createElement("p");
        empty.className = "mcp-tools-empty";
        empty.textContent =
          server.state === "ready" ? "這台伺服器沒有公開工具。" : "重新探索後顯示工具。";
        tools.append(empty);
      }
      details.append(summary, tools);
      card.append(details);

      const actions = document.createElement("footer");
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.dataset.mcpFocus = `refresh:${server.id}`;
      refresh.textContent = "重新探索";
      if (authView) refresh.textContent = authView.button;
      refresh.onclick = (event) => {
        if (!event.isTrusted) return;
        if (authView && authView.action !== "refresh" && authView.action !== "none")
          void this.authAction(server, authView.action);
        else if (!authView || authView.action === "refresh")
          void this.act({ action: "refresh", server_id: server.id });
      };
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.mcpFocus = `remove:${server.id}`;
      remove.className = "danger";
      remove.textContent = "解除掛載";
      remove.onclick = (event) => {
        if (!event.isTrusted || !window.confirm(`解除「${server.name}」的 MCP 掛載？`)) return;
        void this.act({ action: "remove", server_id: server.id });
      };
      refresh.hidden = authView?.action === "none";
      refresh.disabled =
        (authView?.action === "query" ? !available : this.busy || !canChange) ||
        this.authBusy.has(server.id) ||
        Boolean(authLoadingFailed) ||
        Boolean(authView && !authIdentity) ||
        Boolean(authView?.action === "cancel" && !authPending);
      remove.disabled = this.busy || !serverCanChange;
      if (server.auth) {
        const management = document.createElement("details");
        management.className = "mcp-management";
        management.dataset.serverId = server.id;
        management.open = openManagement.has(server.id);
        const label = document.createElement("summary");
        label.textContent = "管理";
        label.dataset.mcpFocus = `manage:${server.id}`;
        const forget = document.createElement("button");
        forget.type = "button";
        forget.textContent = "清除登入";
        forget.dataset.mcpFocus = `forget:${server.id}`;
        forget.disabled =
          this.busy ||
          !canChange ||
          this.authBusy.has(server.id) ||
          !authIdentity ||
          authPending?.request.action === "forget";
        forget.onclick = (event) => {
          if (event.isTrusted) void this.authAction(server, "forget");
        };
        const managementActions = document.createElement("div");
        managementActions.className = "mcp-management-actions";
        managementActions.append(forget, remove);
        management.append(label, managementActions);
        actions.append(refresh, management);
      } else actions.append(refresh, remove);
      card.append(actions);
      this.servers.append(card);
    }
    if (authAnnouncements.length) this.authAnnouncement.textContent = authAnnouncements.join("；");
    if (activeKey) {
      const replacement = [...this.servers.querySelectorAll<HTMLElement>("[data-mcp-focus]")].find(
        (element) => element.dataset.mcpFocus === activeKey,
      );
      if (replacement && !(replacement as HTMLButtonElement).disabled)
        replacement.focus({ preventScroll: true });
      else if (!this.busy) {
        const server = this.state?.servers.find((item) => activeKey.endsWith(`:${item.id}`));
        const card =
          server && this.authBusy.has(server.id)
            ? this.servers.querySelector<HTMLElement>(`[data-mcp-focus="card:${server.id}"]`)
            : undefined;
        if (card) card.focus({ preventScroll: true });
        else this.search.focus({ preventScroll: true });
      }
    }
  }
}
