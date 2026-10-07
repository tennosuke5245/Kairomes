import {
  isAbsoluteMcpCwd,
  MCP_AUTH_LIMITS,
  MCP_CWD_INVALID_MESSAGE,
  type McpAuthInput,
  type McpAuthResult,
  type McpPanelState,
} from "@kairomes/protocol";
import { argvList, el } from "./approval-dom.ts";
import { icon } from "./icons.ts";
import {
  type McpAuthIdentity,
  McpAuthStorageConflict,
  McpAuthTracker,
  mcpAuthPresentation,
  type SavedMcpAuth,
} from "./mcp-auth-tracker.ts";
import { type McpCardHandlers, McpServerCard, setText, syncChildren } from "./mcp-card.ts";
import { filterMcpServers, type McpServerChip } from "./mcp-filter.ts";
import {
  type McpMutationBody,
  type McpMutationScope,
  McpMutationTracker,
  mcpAddFingerprint,
  mcpCwdRejected,
  readMcpMutationState,
  settleMcpMutation,
} from "./mcp-mutation.ts";
import {
  isSearchShortcut,
  MCP_ADD_CONSEQUENCE,
  MCP_TEMPLATES,
  type McpNoticeAction,
  type McpTemplate,
  mcpArgPlaceholder,
  mcpChipCounts,
  mcpServerView,
  mcpStdioRiskLine,
  mcpSummary,
  parseMcpArgs,
} from "./mcp-view.ts";

type Server = McpPanelState["servers"][number];
type Transport = "stdio" | "http";
export interface McpAuthPanelOptions {
  context(): { source: string; instanceId: string } | undefined;
  request(body: McpAuthInput): Promise<McpAuthResult>;
  load(identity: McpAuthIdentity): Promise<unknown>;
  save(identity: McpAuthIdentity, next: SavedMcpAuth | undefined, expected: unknown): Promise<void>;
  refresh(): void;
}

const chipLabels: Record<McpServerChip, string> = {
  all: "全部",
  on: "已開啟",
  attention: "需處理",
};

function button(className: string, label: string, focus?: string) {
  const element = el("button", className);
  element.type = "button";
  element.append(el("span", undefined, label));
  if (focus) element.dataset.mcpFocus = focus;
  return element;
}

/** `<label class="k-label">` above its control. */
function field(label: string | HTMLLabelElement, control: HTMLElement, id: string) {
  const wrapper = el("div", "mcp-add__field");
  const text = typeof label === "string" ? el("label", "k-label", label) : label;
  control.id = id;
  text.htmlFor = id;
  wrapper.append(text, control);
  return wrapper;
}

export class McpPanel {
  private readonly root = el("div", "mcp");
  private readonly heading = el("h1", "k-sr-only", "MCP 整合");
  private readonly top = el("div", "mcp-top");
  private readonly summary = el("p", "mcp-summary");
  private readonly addButton = button("k-btn k-btn--secondary", "加入 MCP", "add");
  private readonly searchField = el("label", "k-field mcp-search");
  private readonly search = el("input", "k-input");
  private readonly chips = el("div", "k-chips mcp-filters");
  private readonly chipButtons = new Map<McpServerChip, HTMLButtonElement>();
  private readonly chipCounts = new Map<McpServerChip, HTMLElement>();
  private readonly matchStatus = el("p", "k-sr-only");
  private readonly list = el("div", "mcp-list");
  private readonly cards = new Map<string, McpServerCard>();
  private readonly noMatch = el("div", "mcp-nomatch");
  private readonly noMatchText = el("p");
  private readonly noMatchClear = button("k-btn k-btn--secondary k-btn--sm", "清除搜尋");
  private readonly empty = el("div", "k-empty mcp-empty");
  private readonly emptyAdd = button("k-btn k-btn--primary", "加入 MCP", "add-empty");
  private readonly hint = el("p", "k-meta mcp-hint", "風險標示由伺服器提供，僅供參考。");
  private chip: McpServerChip = "all";
  private readonly expanded = new Set<string>();
  private readonly statusLabels = new Map<string, string>();

  // Add dialog (native <dialog>: modal focus trap, inert background, Escape).
  private readonly addDialog = el("dialog", "k-dialog mcp-add");
  private readonly form = el("form", "mcp-add__form");
  private readonly transportButtons = new Map<Transport, HTMLButtonElement>();
  private transport: Transport = "stdio";
  private readonly templateButtons: HTMLButtonElement[] = [];
  private readonly name = el("input", "k-input");
  private readonly target = el("input", "k-input k-input--mono");
  private readonly targetLabel = el("label", "k-label", "啟動程式");
  private readonly args = el("textarea", "k-textarea k-input--mono");
  private readonly argsError = el("p", "k-error");
  private readonly cwd = el("input", "k-input k-input--mono");
  private readonly cwdError = el("p", "k-error");
  private readonly preview = el("div", "mcp-add__preview");
  private readonly previewList = el("div", "mcp-add__argv");
  private readonly previewRisk = el("p", "mcp-add__risk");
  private readonly submit = el("button", "k-btn k-btn--primary");
  private readonly cancel = button("k-btn k-btn--secondary", "取消");
  private readonly dialogResult = el("p", "k-error mcp-add__result");
  private readonly reconcileButton = el("button", "k-btn k-btn--secondary");

  // Remove confirmation (native <dialog>, never window.confirm).
  private readonly removeDialog = el("dialog", "k-dialog");
  private readonly removeTitle = el("h2", "k-dialog__title");
  private readonly removeText = el("p");
  private readonly removeConfirm = button("k-btn k-btn--danger", "移除");
  private removeTarget?: { id: string; fingerprint?: string };

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
  private readonly authAnnouncement = el("p", "k-sr-only");

  constructor(
    container: HTMLElement,
    private readonly change: (body: unknown) => Promise<McpPanelState>,
    private readonly report: (message: string) => void,
    private readonly source: () => string | undefined = () => undefined,
    private readonly authOptions?: McpAuthPanelOptions,
  ) {
    this.heading.tabIndex = -1;
    this.addButton.prepend(icon("Plus"));
    this.top.append(this.summary, this.addButton);

    // Search: `/` focuses it, Escape clears it before Escape can leave settings.
    this.search.type = "search";
    this.search.placeholder = "搜尋伺服器或工具";
    this.search.setAttribute("aria-label", "搜尋伺服器或工具");
    this.search.setAttribute("aria-keyshortcuts", "/");
    this.search.autocomplete = "off";
    this.search.spellcheck = false;
    this.search.dataset.mcpFocus = "search";
    const kbd = el("kbd", "k-kbd", "/");
    kbd.setAttribute("aria-hidden", "true");
    this.searchField.append(icon("MagnifyingGlass"), this.search, kbd);
    this.search.addEventListener("input", () => this.render());
    this.search.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.search.value) return;
      event.preventDefault();
      this.search.value = "";
      this.render();
    });
    document.addEventListener("keydown", (event) => {
      if (
        !this.root.getClientRects().length ||
        this.search.closest("[hidden]") ||
        document.querySelector("dialog[open]") ||
        !isSearchShortcut(event, event.target instanceof HTMLElement ? event.target : null)
      )
        return;
      event.preventDefault();
      this.search.focus();
    });

    this.chips.setAttribute("role", "group");
    this.chips.setAttribute("aria-label", "篩選伺服器");
    for (const chip of ["all", "on", "attention"] as const) {
      const item = button("k-chip", chipLabels[chip], `chip:${chip}`);
      item.setAttribute("aria-pressed", String(chip === this.chip));
      if (chip === "attention") item.dataset.tone = "danger";
      const count = el("span", "k-chip__count");
      item.append(count);
      this.chipCounts.set(chip, count);
      item.addEventListener("click", () => {
        this.chip = chip;
        this.render();
      });
      this.chipButtons.set(chip, item);
      this.chips.append(item);
    }
    this.matchStatus.setAttribute("role", "status");
    this.matchStatus.setAttribute("aria-live", "polite");

    this.noMatch.append(this.noMatchText, this.noMatchClear);
    this.noMatch.hidden = true;
    this.noMatchClear.addEventListener("click", () => {
      this.search.value = "";
      this.chip = "all";
      this.render();
      this.search.focus();
    });

    const emptyIcon = el("span", "k-empty__icon");
    emptyIcon.append(icon("HardDrives", { size: "xl" }));
    this.emptyAdd.prepend(icon("Plus"));
    this.empty.append(
      emptyIcon,
      el("p", "k-empty__title", "還沒有 MCP 伺服器"),
      el("p", "k-empty__text", "加入本機程式或遠端網址後，ChatGPT 就能使用它的工具。"),
      this.emptyAdd,
    );
    this.empty.hidden = true;

    this.buildAddDialog();
    this.buildRemoveDialog();

    this.authAnnouncement.setAttribute("role", "status");
    this.authAnnouncement.setAttribute("aria-live", "polite");
    this.authAnnouncement.setAttribute("aria-atomic", "true");
    this.root.append(
      this.heading,
      this.top,
      this.searchField,
      this.chips,
      this.matchStatus,
      this.list,
      this.noMatch,
      this.empty,
      this.hint,
      this.addDialog,
      this.removeDialog,
      this.authAnnouncement,
    );
    container.append(this.root);

    const openAdd = (event: MouseEvent) => {
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
    this.addButton.addEventListener("click", openAdd);
    this.emptyAdd.addEventListener("click", openAdd);
    this.addDialog.addEventListener("close", () => {
      if (this.addDialog.open) return;
      const scope = this.dialogScope;
      this.dialogScope = undefined;
      if (!scope || !this.isMutationCurrent(scope)) return;
      if (this.dialogResult.textContent) this.report(this.dialogResult.textContent);
      this.reviewRequired = false;
      this.dialogResult.hidden = this.reconcileButton.hidden = true;
      this.render();
      const opener = [this.addButton, this.emptyAdd].find(
        (item) => !item.disabled && item.getClientRects().length,
      );
      if (opener) opener.focus();
      else this.heading.focus({ preventScroll: true });
    });
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (event.isTrusted) void this.add();
    });
    this.setTransport("stdio");
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

  private buildAddDialog() {
    const dialog = this.addDialog;
    dialog.setAttribute("aria-labelledby", "mcp-add-title");
    const head = el("div", "k-dialog__head");
    const title = el("h2", "k-dialog__title", "加入 MCP");
    title.id = "mcp-add-title";
    const close = el("button", "k-btn k-btn--quiet k-btn--icon k-btn--sm");
    close.type = "button";
    close.setAttribute("aria-label", "關閉");
    close.append(icon("X"));
    close.addEventListener("click", () => dialog.close());
    head.append(title, close);

    const body = el("div", "k-dialog__body mcp-add__body");
    const templates = el("div", "mcp-add__templates");
    const templateLabel = el("p", "k-label", "從範本開始");
    templateLabel.id = "mcp-add-templates";
    const templateList = el("div", "k-chips");
    templateList.setAttribute("role", "group");
    templateList.setAttribute("aria-labelledby", templateLabel.id);
    for (const template of MCP_TEMPLATES) {
      const item = button("k-chip", template.label);
      item.addEventListener("click", () => this.applyTemplate(template));
      this.templateButtons.push(item);
      templateList.append(item);
    }
    templates.append(templateLabel, templateList);

    const transport = el("div", "mcp-add__field");
    const transportLabel = el("p", "k-label", "連線方式");
    transportLabel.id = "mcp-add-transport";
    const seg = el("div", "k-seg mcp-add__seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-labelledby", transportLabel.id);
    for (const [value, label] of [
      ["stdio", "本機程式（stdio）"],
      ["http", "遠端網址（HTTP）"],
    ] as const) {
      const item = button("", label);
      item.addEventListener("click", () => this.setTransport(value));
      this.transportButtons.set(value, item);
      seg.append(item);
    }
    transport.append(transportLabel, seg);

    this.name.required = true;
    this.name.maxLength = 80;
    this.name.autocomplete = "off";
    this.name.placeholder = "例如 Chrome DevTools";
    this.target.required = true;
    this.target.autocomplete = "off";
    this.target.spellcheck = false;
    this.args.rows = 4;
    this.args.spellcheck = false;
    this.args.placeholder = "每行一個參數（可留空）";
    this.args.setAttribute("aria-describedby", "mcp-add-args-error");
    this.argsError.id = "mcp-add-args-error";
    this.argsError.hidden = true;
    this.cwd.autocomplete = "off";
    this.cwd.spellcheck = false;
    // Left empty, the program starts in Kairomes' own MCP folder, not wherever the Host started.
    this.cwd.placeholder = "可留空；指定時填絕對路徑";
    this.cwd.setAttribute("aria-describedby", "mcp-add-cwd-error");
    this.cwdError.id = "mcp-add-cwd-error";
    this.cwdError.hidden = true;
    const nameField = field("名稱", this.name, "mcp-add-name");
    const targetField = field(this.targetLabel, this.target, "mcp-add-target");
    const argsField = field("參數", this.args, "mcp-add-args");
    argsField.append(this.argsError);
    argsField.classList.add("mcp-add__stdio");
    const cwdField = field("工作目錄", this.cwd, "mcp-add-cwd");
    cwdField.append(this.cwdError);
    cwdField.classList.add("mcp-add__stdio");

    // The exact argv is shown before saving, with one host-privilege line.
    const previewLabel = el("p", "k-label", "將執行");
    this.preview.classList.add("mcp-add__stdio");
    this.preview.append(previewLabel, this.previewList, this.previewRisk);
    const consequence = el("p", "k-hint mcp-add__consequence");
    consequence.append(icon("Info"), el("span", undefined, MCP_ADD_CONSEQUENCE));
    this.dialogResult.setAttribute("role", "alert");
    this.dialogResult.hidden = true;
    body.append(
      templates,
      transport,
      nameField,
      targetField,
      argsField,
      this.preview,
      cwdField,
      consequence,
      this.dialogResult,
    );
    for (const input of [this.target, this.args])
      input.addEventListener("input", this.updatePreview);
    this.cwd.addEventListener("input", () => {
      const value = this.cwd.value.trim();
      if (!value || isAbsoluteMcpCwd(value)) this.showCwdError(false);
    });

    const actions = el("div", "k-dialog__actions");
    this.submit.type = "submit";
    this.cancel.addEventListener("click", () => dialog.close());
    this.reconcileButton.type = "button";
    this.reconcileButton.hidden = true;
    this.reconcileButton.addEventListener("click", (event) => {
      if (!event.isTrusted || this.busy) return;
      if (this.uncertain) void this.reconcile();
      else dialog.close();
    });
    actions.append(this.reconcileButton, this.cancel, this.submit);
    this.form.append(head, body, actions);
    dialog.append(this.form);
  }

  private buildRemoveDialog() {
    const dialog = this.removeDialog;
    this.removeTitle.id = "mcp-remove-title";
    this.removeText.id = "mcp-remove-text";
    dialog.setAttribute("aria-labelledby", this.removeTitle.id);
    dialog.setAttribute("aria-describedby", this.removeText.id);
    const head = el("div", "k-dialog__head");
    head.append(this.removeTitle);
    const body = el("div", "k-dialog__body");
    body.append(this.removeText);
    const actions = el("div", "k-dialog__actions");
    const cancel = button("k-btn k-btn--secondary", "取消");
    // Destructive confirmations start on the safe button.
    cancel.autofocus = true;
    cancel.addEventListener("click", () => dialog.close());
    this.removeConfirm.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      const target = this.removeTarget;
      dialog.close("confirm");
      const server = this.state?.servers.find((item) => item.id === target?.id);
      // The card the user confirmed must still be the same configuration.
      if (target && server && server.config_fingerprint === target.fingerprint)
        void this.act({ action: "remove", server_id: target.id });
    });
    actions.append(cancel, this.removeConfirm);
    dialog.append(head, body, actions);
    dialog.addEventListener("close", () => {
      const target = this.removeTarget;
      this.removeTarget = undefined;
      const confirmed = dialog.returnValue === "confirm";
      dialog.returnValue = "";
      if (confirmed || !target) return;
      const remove = this.root.querySelector<HTMLElement>(
        `[data-mcp-focus="remove:${CSS.escape(target.id)}"]`,
      );
      if (remove && !remove.closest("[hidden]")) remove.focus();
    });
  }

  private showCwdError(visible: boolean) {
    this.cwdError.textContent = visible ? MCP_CWD_INVALID_MESSAGE : "";
    this.cwdError.hidden = !visible;
    if (visible) this.cwd.setAttribute("aria-invalid", "true");
    else this.cwd.removeAttribute("aria-invalid");
  }

  private openRemove(server: Server) {
    if (this.removeDialog.open) return;
    this.removeTarget = { id: server.id, fingerprint: server.config_fingerprint };
    setText(this.removeTitle, `移除「${server.name}」？`);
    setText(
      this.removeText,
      server.auth
        ? "ChatGPT 將無法再使用它的工具，本機登入也會清除。要再使用需重新加入。"
        : "ChatGPT 將無法再使用它的工具。要再使用需重新加入。",
    );
    this.removeDialog.showModal();
  }

  private setTransport(value: Transport) {
    this.transport = value;
    const stdio = value === "stdio";
    for (const [key, item] of this.transportButtons)
      item.setAttribute("aria-pressed", String(key === value));
    setText(this.targetLabel, stdio ? "啟動程式" : "MCP 網址");
    this.target.placeholder = stdio ? "例如 npx.cmd" : "https://…/mcp";
    this.target.inputMode = stdio ? "text" : "url";
    for (const item of this.form.querySelectorAll<HTMLElement>(".mcp-add__stdio"))
      item.hidden = !stdio;
    this.updatePreview();
    this.render();
  }

  private applyTemplate(template: McpTemplate) {
    this.setTransport(template.transport);
    if (template.name) this.name.value = template.name;
    this.target.value = template.target;
    this.args.value = template.args.join("\n");
    this.updatePreview();
    const placeholder = mcpArgPlaceholder(template.args);
    if (placeholder) {
      const start = this.args.value.indexOf(placeholder);
      this.args.focus();
      this.args.setSelectionRange(start, start + placeholder.length);
    } else if (!this.name.value.trim()) this.name.focus();
    else this.target.focus();
  }

  private readonly updatePreview = () => {
    const command = this.target.value.trim();
    const args = parseMcpArgs(this.args.value);
    // The textarea grows with its lines so a template's argv is visible without scrolling.
    this.args.rows = Math.min(8, Math.max(3, this.args.value.split("\n").length));
    this.preview.hidden = this.transport !== "stdio" || !command;
    if (!this.argsError.hidden && !mcpArgPlaceholder(args)) {
      this.argsError.hidden = true;
      this.args.removeAttribute("aria-invalid");
    }
    if (this.preview.hidden) return;
    this.previewList.replaceChildren(argvList([command, ...args]));
    this.previewRisk.replaceChildren(
      icon("Desktop"),
      el("span", undefined, mcpStdioRiskLine(command, args)),
    );
  };

  private handlers: McpCardHandlers = {
    toggleServer: (id) => {
      const server = this.server(id);
      if (server)
        void this.act({ action: "set_server_enabled", server_id: id, enabled: !server.enabled });
    },
    toggleTool: (id, name) => {
      const tool = this.server(id)?.tools.find((item) => item.name === name);
      if (tool)
        void this.act({
          action: "set_tool_enabled",
          server_id: id,
          tool_name: name,
          enabled: !tool.enabled,
        });
    },
    notice: (id, action: McpNoticeAction) => {
      const server = this.server(id);
      if (!server) return;
      if (action === "refresh") void this.act({ action: "refresh", server_id: id });
      else void this.authAction(server, action);
    },
    refresh: (id) => {
      if (this.server(id)) void this.act({ action: "refresh", server_id: id });
    },
    forget: (id) => {
      const server = this.server(id);
      if (server) void this.authAction(server, "forget");
    },
    remove: (id) => {
      const server = this.server(id);
      if (server) this.openRemove(server);
    },
    expand: (id) => {
      if (this.expanded.has(id)) this.expanded.delete(id);
      else this.expanded.add(id);
      this.render();
    },
  };

  private server(id: string) {
    return this.state?.servers.find((server) => server.id === id);
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
    this.statusLabels.clear();
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
    if (this.removeDialog.open) this.removeDialog.close();
    this.search.value = "";
    this.chip = "all";
    this.expanded.clear();
    this.cards.clear();
    this.statusLabels.clear();
    this.list.replaceChildren();
  }

  get hasUncertainMutation() {
    return this.uncertain;
  }

  /** "applied", "cwd" when the Host refused the working directory before saving, else undefined. */
  private async act(body: McpMutationBody): Promise<"applied" | "cwd" | undefined> {
    this.syncMutation();
    if (this.busy || !this.available || this.uncertain || this.reviewRequired) return;
    if (!this.state) return;
    const base = structuredClone(this.state);
    const source = this.source();
    const scope = this.mutation.capture();
    const current = () => this.isMutationCurrent(scope);
    this.pendingFocus = (document.activeElement as HTMLElement | null)?.dataset.mcpFocus;
    this.busy = true;
    this.render(undefined, this.available);
    try {
      const fingerprint = await mcpAddFingerprint(body);
      if (!current()) return;
      if ((body.action === "add_stdio" || body.action === "add_http") && !fingerprint) {
        if (this.addDialog.open) {
          this.report("");
          this.dialogResult.textContent = "請檢查連線設定。";
          this.dialogResult.hidden = false;
          this.reconcileButton.hidden = true;
        } else this.report("請檢查連線設定。");
        return;
      }
      if (!this.available || !current() || !this.mutation.begin(base, body, source, fingerprint))
        return;
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
        (error) => body.action === "add_stdio" && mcpCwdRejected(error),
      );
      if (!current()) return;
      if (result.outcome === "rejected") {
        // Refused before saving: nothing to reconcile, and the form marks the field.
        this.mutation.acknowledge(source);
        if (this.addDialog.open) this.showResult("");
        else this.report(MCP_CWD_INVALID_MESSAGE);
        return "cwd";
      }
      if (result.state) this.state = result.state;
      if (result.outcome === "unknown") {
        this.showReconciliation(false);
        return;
      }
      if (result.outcome === "applied") this.mutation.acknowledge(source);
      this.reviewRequired = result.outcome === "reconciled" && this.addDialog.open;
      if (result.outcome === "reconciled") this.showReconciliation(true);
      else this.showResult("");
      return result.outcome === "applied" ? "applied" : undefined;
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
    const stdio = this.transport === "stdio";
    const args = parseMcpArgs(this.args.value);
    const placeholder = stdio ? mcpArgPlaceholder(args) : undefined;
    if (placeholder) {
      // A template placeholder never reaches the Host as a literal argument.
      this.argsError.textContent = `請把 ${placeholder} 換成實際值。`;
      this.argsError.hidden = false;
      this.args.setAttribute("aria-invalid", "true");
      this.args.focus();
      return;
    }
    const cwd = stdio ? this.cwd.value.trim() : "";
    if (cwd && !isAbsoluteMcpCwd(cwd)) {
      this.showCwdError(true);
      this.cwd.focus();
      return;
    }
    const previousIds = new Set(this.state?.servers.map((server) => server.id));
    const outcome = await this.act(
      stdio
        ? { action: "add_stdio", name, command: target, args, ...(cwd ? { cwd } : {}) }
        : { action: "add_http", name, url: target, header_env: {} },
    );
    if (outcome === "cwd" && this.isMutationCurrent(scope) && this.addDialog.open) {
      this.showCwdError(true);
      this.cwd.focus();
      return;
    }
    if (
      outcome === "applied" &&
      this.isMutationCurrent(scope) &&
      this.state?.servers.some((server) => server.name === name && !previousIds.has(server.id))
    ) {
      this.name.value = "";
      this.target.value = "";
      this.args.value = "";
      this.cwd.value = "";
      this.showCwdError(false);
      this.updatePreview();
      this.addDialog.close();
    }
  }

  private serverView(server: Server) {
    const identity = this.authIdentity(server);
    if (identity) this.prepareAuth(server, identity);
    const summary = identity ? (this.auth.summary(identity) ?? server.auth) : undefined;
    const pending = identity ? this.auth.current(identity) : undefined;
    const presentation = summary
      ? mcpAuthPresentation(summary, pending, this.authStarting.has(server.id))
      : undefined;
    const loadFailed = Boolean(identity && this.authLoadFailed.has(this.authKey(identity)));
    const view = mcpServerView(
      server,
      summary && presentation ? { summary, view: presentation, loadFailed } : undefined,
    );
    return { identity, pending, presentation, view };
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
    const active = document.activeElement as HTMLElement | null;
    const lostFocus = !active || active === document.body;
    const focusKey = active?.dataset.mcpFocus ?? (lostFocus ? this.pendingFocus : undefined);

    const servers = this.state?.servers ?? [];
    const details = new Map(servers.map((server) => [server.id, this.serverView(server)]));
    const views = [...details.values()].map((item) => item.view);
    const hasServers = servers.length > 0;

    // Summary row, search and chips only exist while there is something to filter.
    setText(
      this.summary,
      !this.state
        ? available
          ? "正在讀取伺服器…"
          : "伺服器狀態待確認"
        : hasServers
          ? mcpSummary(views)
          : "",
    );
    this.addButton.hidden = Boolean(this.state) && !hasServers;
    setText(
      this.addButton.querySelector("span") ?? this.addButton,
      this.adding ? "正在加入…" : "加入 MCP",
    );
    this.top.hidden = Boolean(this.state) && !hasServers;
    this.addButton.disabled = this.emptyAdd.disabled = this.busy || !canChange;
    setText(this.submit, this.adding ? "正在加入…" : "加入");
    this.submit.setAttribute("aria-busy", String(this.adding));
    this.submit.disabled = this.busy || !canChange || this.reviewRequired;
    this.reconcileButton.disabled = this.busy || !available;
    const locked = this.busy || !canChange || this.reviewRequired;
    for (const control of [
      this.name,
      this.target,
      this.args,
      this.cwd,
      ...this.transportButtons.values(),
      ...this.templateButtons,
    ])
      control.disabled = locked;
    this.searchField.hidden = this.chips.hidden = !hasServers;
    const counts = mcpChipCounts(views);
    for (const [chip, count] of this.chipCounts) {
      setText(count, String(counts[chip]));
      // 需處理 shows only while something needs the user; 全部 and 已開啟 always count.
      count.hidden = chip === "attention" && !counts.attention;
    }
    for (const [chip, item] of this.chipButtons)
      item.setAttribute("aria-pressed", String(chip === this.chip));

    const query = this.search.value.trim();
    const matches = this.state
      ? filterMcpServers(this.state, { query, chip: this.chip }, (server) => {
          const view = details.get(server.id)?.view;
          return { on: Boolean(view?.on), attention: Boolean(view?.attention) };
        })
      : [];
    setText(
      this.matchStatus,
      query && hasServers ? (matches.length ? `${matches.length} 個伺服器符合` : "") : "",
    );

    const cards = matches.map(({ server, tools }) => {
      const detail = details.get(server.id);
      if (!detail) throw new Error("Missing MCP server view");
      const { identity, pending, view } = detail;
      let card = this.cards.get(server.id);
      if (!card) {
        card = new McpServerCard(server.id, this.handlers);
        this.cards.set(server.id, card);
      }
      const serverCanChange = canChange && !pending?.unknown && !this.authBusy.has(server.id);
      const kind = view.notice?.action?.kind;
      card.update({
        server,
        view,
        tools: tools ?? server.tools,
        narrowed: Boolean(tools),
        expanded: this.expanded.has(server.id),
        disabled: {
          server: this.busy || !serverCanChange,
          tools: this.busy || !serverCanChange || !view.toolsCurrent,
          notice:
            (kind === "query" ? !available : this.busy || !canChange) ||
            this.authBusy.has(server.id) ||
            (kind !== "refresh" && !identity) ||
            (kind === "cancel" && !pending),
          refresh: this.busy || !canChange,
          forget:
            this.busy ||
            !canChange ||
            this.authBusy.has(server.id) ||
            !identity ||
            pending?.request.action === "forget",
          remove: this.busy || !serverCanChange,
        },
      });
      return card.element;
    });
    syncChildren(this.list, cards);
    for (const id of this.cards.keys()) if (!details.has(id)) this.cards.delete(id);
    for (const id of this.expanded) if (!details.has(id)) this.expanded.delete(id);

    this.empty.hidden = !this.state || hasServers;
    this.noMatch.hidden = !hasServers || matches.length > 0;
    setText(
      this.noMatchText,
      query
        ? `沒有符合「${query}」的結果`
        : this.chip === "attention"
          ? "沒有需要處理的伺服器"
          : "沒有已開啟的伺服器",
    );
    setText(this.noMatchClear, query ? "清除搜尋" : "顯示全部");
    this.hint.hidden = !matches.some(({ server }) => server.tools.length);

    // Announce status changes (not first sight) without making every card a live region.
    const announcements: string[] = [];
    for (const server of servers) {
      const label = details.get(server.id)?.view.status.label ?? "";
      const previous = this.statusLabels.get(server.id);
      if (previous !== undefined && previous !== label)
        announcements.push(`${server.name}：${label}`);
      this.statusLabels.set(server.id, label);
    }
    for (const id of this.statusLabels.keys()) if (!details.has(id)) this.statusLabels.delete(id);
    if (announcements.length) this.authAnnouncement.textContent = announcements.join("；");

    // Nodes are patched in place, so focus survives a refresh. Only a control that was
    // disabled mid-request (or a removed card) loses focus; put it back once usable.
    if (focusKey && (lostFocus || document.activeElement === document.body)) {
      const replacement = [...this.root.querySelectorAll<HTMLElement>("[data-mcp-focus]")].find(
        (element) => element.dataset.mcpFocus === focusKey,
      );
      if (
        replacement &&
        !(replacement as HTMLButtonElement).disabled &&
        !replacement.closest("[hidden]")
      )
        replacement.focus({ preventScroll: true });
      else if (!this.busy) {
        const id = focusKey.slice(focusKey.indexOf(":") + 1).split(":")[0] ?? "";
        const card = this.cards.get(id)?.element;
        if (card?.isConnected) card.focus({ preventScroll: true });
        else if (!this.searchField.hidden) this.search.focus({ preventScroll: true });
        else if (!this.addButton.hidden && !this.addButton.disabled) this.addButton.focus();
      }
    }
  }
}
