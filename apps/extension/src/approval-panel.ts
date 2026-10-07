import { DENIAL_REASON_MAX_LENGTH } from "@kairomes/protocol";
import { type DiffView, facts, quote, requestMeta, riskElement } from "./approval-detail.ts";
import {
  diffStatElement,
  el,
  iconButton,
  metaItem,
  pill,
  setButtonLabel,
  textButton,
  workspaceTag,
} from "./approval-dom.ts";
import {
  type ApprovalItem,
  ARM_DELAY_MS,
  approvalDecisionBlock,
  approvalsInWorkspace,
  armedUntil,
  canStopOngoing,
  checkDenialReason,
  decisionArming,
  nextPending,
  normalizeReasonInput,
  pendingQueue,
  queuePosition,
  splitApprovalItems,
} from "./approval-state.ts";
import {
  type ApprovalTab,
  approvalTitle,
  countdown,
  countdownMilestone,
  decisionNotice,
  diffStat,
  isWindowsHost,
  modelReason,
  outcomeReason,
  primaryLabel,
  queueRow,
  type RowMeta,
  runningMeta,
  sortForTab,
  stateView,
} from "./approval-view.ts";
import { icon, type PanelIcon, setIcon } from "./icons.ts";
import { activeIndicator } from "./toolbar-state.ts";

export type { ApprovalTab } from "./approval-view.ts";

export type ApprovalAction = "approve" | "deny" | "stop";

export interface ApprovalPanelOptions {
  /** Sends one decision. A deny may carry the user's reason in the same single request. */
  decide: (item: ApprovalItem, action: ApprovalAction, reason?: string) => Promise<void>;
  report: (message: string) => void;
  /** Open state or tab changed; the coordinator updates the body view and toolbar. */
  change?: (open: boolean, tab: ApprovalTab) => void;
  /** True while an earlier decision for this request has an unconfirmed result. */
  uncertain?: (item: ApprovalItem) => boolean;
  /** Approval live region (countdown milestones, decisions, auto-advance). */
  announce?: (message: string) => void;
  now?: () => number;
}

const TABS: readonly { id: ApprovalTab; label: string; empty: string; text?: string }[] = [
  {
    id: "pending",
    label: "需確認",
    empty: "沒有待確認的請求",
    text: "ChatGPT 要改檔案或執行命令時會列在這裡。",
  },
  { id: "running", label: "執行中", empty: "沒有執行中的工作" },
  {
    id: "recent",
    label: "最近",
    empty: "還沒有處理過的請求",
    text: "處理過的請求會留在這裡，本機服務重新啟動後清空。",
  },
];
const emptyIcons: Record<ApprovalTab, PanelIcon> = {
  pending: "Tray",
  running: "CircleNotch",
  recent: "ClockCountdown",
};
const backLabels: Record<ApprovalTab, string> = {
  pending: "返回需確認列表",
  running: "返回執行中列表",
  recent: "返回最近列表",
};

type Row = {
  li: HTMLLIElement;
  button: HTMLButtonElement;
  lead: SVGSVGElement;
  title: HTMLElement;
  pill: HTMLElement;
  pillIcon: SVGSVGElement;
  pillLabel: HTMLElement;
  preview: HTMLElement;
  meta: HTMLElement;
  reason: HTMLElement;
  metaKey: string;
};

/**
 * The trusted approval page: queue tabs, the full review and every decision stay in native
 * Extension DOM. A decision is bound to the immutable copy the user opened (id, fingerprint
 * and content); any change, expiry, disconnect or unconfirmed result disables it.
 */
export class ApprovalPanel {
  private readonly decide: ApprovalPanelOptions["decide"];
  private readonly report: (message: string) => void;
  private readonly change: (open: boolean, tab: ApprovalTab) => void;
  private readonly uncertain: (item: ApprovalItem) => boolean;
  private readonly announce: (message: string) => void;
  private readonly now: () => number;
  private readonly windows = isWindowsHost(navigator.userAgent);

  private readonly back = iconButton("ArrowLeft", "返回工作台");
  private readonly tabList = el("div", "k-tabs rq-tabs");
  private readonly tabs = new Map<ApprovalTab, HTMLButtonElement>();
  private readonly runningBadge = el("span", "k-badge");
  private readonly title = el("h2", "sp-sub__title rq-sub__title");
  private readonly position = el("span", "sp-sub__pos rq-sub__pos");
  private readonly timer = el("span", "k-countdown k-countdown--pill rq-sub__timer");
  private readonly timerText = el("span");
  private readonly scroll = el("div", "rq-scroll");
  private readonly queue = el("div", "rq-queue");
  private readonly list = el("ul", "k-list k-card rq-list");
  private readonly empty = el("div", "k-empty rq-empty");
  private readonly emptyIcon = icon("Tray", { size: "xl" });
  private readonly emptyTitle = el("p", "k-empty__title");
  private readonly emptyText = el("p", "k-empty__text");
  private readonly elsewhere = el("p", "rq-elsewhere");
  private readonly elsewhereText = el("span");
  private readonly elsewhereToggle = textButton("", "k-link");
  private readonly detail = el("article", "rq-detail");
  private readonly bar = el("div", "k-actionbar rq-bar");
  private readonly block = el("div", "rq-block");
  private readonly blockIcon = icon("Info");
  private readonly blockText = el("p", "rq-block__text");
  private readonly blockAction = textButton("", "k-btn k-btn--secondary k-btn--sm");
  private readonly reasonBox = el("div", "rq-reason");
  private readonly reasonInput = el("textarea", "k-textarea rq-reason__input");
  private readonly reasonCount = el("span", "rq-reason__count");
  private readonly reasonError = el("p", "k-error rq-reason__error");
  private readonly decisionRow = el("div", "k-actionbar__row");
  private readonly approve = textButton("允許這次", "k-btn k-btn--primary k-btn--lg", "Check");
  private readonly deny = textButton("拒絕", "k-btn k-btn--secondary k-btn--lg");
  private readonly reasonSubmit = textButton("送出拒絕", "k-btn k-btn--primary k-btn--lg");
  private readonly reasonCancel = textButton("取消", "k-btn k-btn--secondary k-btn--lg");
  private readonly reasonToggle = textButton("拒絕並說明原因…", "k-btn k-btn--quiet k-btn--sm");
  private readonly stopButton = textButton("停止", "k-btn k-btn--secondary k-btn--lg", "Stop");

  private items: ApprovalItem[] = [];
  private available = false;
  private workspaceId: string | null = null;
  private allWorkspaces = false;
  private openState = false;
  private currentTab: ApprovalTab = "pending";
  /** The immutable copy under review; every decision is checked against it. */
  private reviewed?: ApprovalItem;
  /** A running or finished item shown read-only (looked up live by id). */
  private recordId?: string;
  private recordKey = "";
  private busy = false;
  private armed?: number;
  private armTimer?: ReturnType<typeof setTimeout>;
  /** Requests decided in this review run, for the 2／3 position and auto-advance. */
  private decidedIds = new Set<string>();
  private advanced = false;
  private reasonOpen = false;
  private lastRow?: string;
  private queueScroll = 0;
  private tickTimer?: ReturnType<typeof setInterval>;
  private lastRemaining?: number;
  private rows = new Map<string, Row>();
  private stopping = new Set<string>();
  private readonly diffView: DiffView = { wrap: true };
  private stats = new Map<string, { additions: number; deletions: number } | undefined>();

  constructor(
    private readonly container: HTMLElement,
    options: ApprovalPanelOptions,
  ) {
    this.decide = options.decide;
    this.report = options.report;
    this.change = options.change ?? (() => {});
    this.uncertain = options.uncertain ?? (() => false);
    this.announce = options.announce ?? (() => {});
    this.now = options.now ?? Date.now;
    this.build();
  }

  private build() {
    this.container.classList.add("rq-page");
    const sub = el("header", "sp-sub rq-sub");
    this.tabList.setAttribute("role", "tablist");
    this.tabList.setAttribute("aria-label", "請求");
    for (const tab of TABS) {
      const button = el("button", "k-tab", tab.label);
      button.type = "button";
      button.id = `approvals-tab-${tab.id}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", "approvals-queue");
      button.addEventListener("click", () => this.selectTab(tab.id, true));
      if (tab.id === "running") {
        this.runningBadge.dataset.tone = "running";
        this.runningBadge.hidden = true;
        button.append(this.runningBadge);
      }
      this.tabs.set(tab.id, button);
      this.tabList.append(button);
    }
    this.tabList.addEventListener("keydown", (event) => this.tabKeys(event));
    this.title.tabIndex = -1;
    this.title.id = "approvals-detail-title";
    this.timer.append(icon("Timer"), this.timerText);
    // Read as one phrase (剩 4 分 12 秒到期); milestones are announced separately.
    this.timer.setAttribute("role", "img");
    sub.append(this.back, this.tabList, this.title, this.position, this.timer);
    this.back.addEventListener("click", () => (this.inDetail ? this.backToQueue() : this.close()));

    this.queue.id = "approvals-queue";
    this.queue.setAttribute("role", "tabpanel");
    this.list.addEventListener("keydown", (event) => this.rowKeys(event));
    const emptyTile = el("span", "k-empty__icon");
    emptyTile.append(this.emptyIcon);
    const emptyBack = textButton("返回工作台", "k-btn k-btn--secondary");
    emptyBack.addEventListener("click", () => this.close());
    this.empty.append(emptyTile, this.emptyTitle, this.emptyText, emptyBack);
    this.elsewhere.append(this.elsewhereText, this.elsewhereToggle);
    this.elsewhereToggle.addEventListener("click", () => {
      this.allWorkspaces = !this.allWorkspaces;
      this.renderList();
      this.elsewhereToggle.focus();
    });
    this.queue.append(this.list, this.empty, this.elsewhere);
    this.detail.setAttribute("aria-labelledby", this.title.id);
    this.scroll.append(this.queue, this.detail);

    this.block.append(this.blockIcon, this.blockText, this.blockAction);
    this.block.setAttribute("role", "status");
    this.blockAction.addEventListener("click", () => this.blockActionClick());
    const reasonLabel = el("label", "k-label", "拒絕原因");
    reasonLabel.htmlFor = "approval-reason";
    const reasonHint = el("p", "k-hint rq-reason__hint", "ChatGPT 會讀到這段說明。");
    reasonHint.id = "approval-reason-hint";
    this.reasonInput.id = "approval-reason";
    this.reasonInput.rows = 2;
    this.reasonInput.maxLength = DENIAL_REASON_MAX_LENGTH;
    this.reasonInput.placeholder = "例如：先跑單元測試，不要改設定檔";
    this.reasonInput.setAttribute("aria-describedby", "approval-reason-hint approval-reason-error");
    this.reasonInput.addEventListener("input", () => {
      const normalized = normalizeReasonInput(this.reasonInput.value);
      if (normalized !== this.reasonInput.value) this.reasonInput.value = normalized;
      this.updateDecision();
    });
    this.reasonInput.addEventListener("keydown", (event) => {
      // Single-line by contract: Enter never inserts a break and never submits.
      if (event.key === "Enter") event.preventDefault();
    });
    this.reasonError.id = "approval-reason-error";
    const reasonHead = el("div", "rq-reason__head");
    reasonHead.append(reasonLabel, this.reasonCount);
    this.reasonBox.append(reasonHead, this.reasonInput, reasonHint, this.reasonError);
    this.decisionRow.append(
      this.approve,
      this.deny,
      this.reasonSubmit,
      this.reasonCancel,
      this.stopButton,
    );
    this.bar.append(this.block, this.reasonBox, this.decisionRow, this.reasonToggle);
    this.container.append(sub, this.scroll, this.bar);

    // Decisions require a real user gesture; synthetic clicks are ignored.
    this.approve.addEventListener("click", (event) => {
      if (event.isTrusted) void this.submit("approve");
    });
    this.deny.addEventListener("click", (event) => {
      if (event.isTrusted) void this.submit("deny");
    });
    this.reasonSubmit.addEventListener("click", (event) => {
      if (event.isTrusted) void this.submit("deny", true);
    });
    this.stopButton.addEventListener("click", (event) => {
      if (event.isTrusted) void this.stop();
    });
    this.reasonToggle.addEventListener("click", () => this.setReason(true));
    this.reasonCancel.addEventListener("click", () => this.setReason(false));
    this.container.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (this.reasonOpen) this.setReason(false);
      else if (this.inDetail) this.backToQueue();
      else this.close();
    });
  }

  get isOpen() {
    return this.openState;
  }

  get tab() {
    return this.currentTab;
  }

  private get inDetail() {
    return this.reviewed !== undefined || this.recordId !== undefined;
  }

  /** Opens the page on a tab (the queue, not a detail). */
  open(tab: ApprovalTab = "pending") {
    const wasOpen = this.openState;
    this.openState = true;
    this.container.hidden = false;
    this.clearDetail();
    this.currentTab = tab;
    this.decidedIds.clear();
    this.renderList();
    this.refreshView();
    this.scroll.scrollTop = 0;
    this.tabs.get(tab)?.focus();
    if (!wasOpen) {
      clearInterval(this.tickTimer);
      this.tickTimer = setInterval(() => this.tick(), 1000);
    }
    this.change(true, tab);
  }

  /** The toolbar buttons: a second press on the shown tab closes the page. */
  toggle(tab: ApprovalTab) {
    if (this.openState && this.currentTab === tab && !this.inDetail) this.close();
    else this.open(tab);
  }

  close() {
    if (!this.openState) return;
    clearInterval(this.tickTimer);
    clearTimeout(this.armTimer);
    this.tickTimer = undefined;
    this.openState = false;
    this.clearDetail();
    this.container.hidden = true;
    this.change(false, this.currentTab);
  }

  private clearDetail() {
    this.reviewed = undefined;
    this.recordId = undefined;
    this.recordKey = "";
    this.advanced = false;
    this.armed = undefined;
    this.reasonOpen = false;
    this.reasonInput.value = "";
    this.detail.replaceChildren();
  }

  private selectTab(tab: ApprovalTab, focus = false) {
    if (tab === this.currentTab && !this.inDetail) return;
    this.clearDetail();
    this.currentTab = tab;
    this.decidedIds.clear();
    this.renderList();
    this.refreshView();
    this.scroll.scrollTop = 0;
    if (focus) this.tabs.get(tab)?.focus();
    this.change(this.openState, tab);
  }

  private tabKeys(event: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const order = TABS.map((tab) => tab.id);
    const index = order.indexOf(this.currentTab);
    const next =
      event.key === "Home"
        ? order[0]
        : event.key === "End"
          ? order.at(-1)
          : order[(index + (event.key === "ArrowLeft" ? -1 : 1) + order.length) % order.length];
    if (next) this.selectTab(next, true);
  }

  private rowKeys(event: KeyboardEvent) {
    const steps: Record<string, number> = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 };
    if (!(event.key in steps) && event.key !== "Home" && event.key !== "End") return;
    const buttons = [...this.list.querySelectorAll<HTMLButtonElement>("button.k-row")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    event.preventDefault();
    const target =
      event.key === "Home"
        ? buttons[0]
        : event.key === "End"
          ? buttons.at(-1)
          : buttons[Math.min(buttons.length - 1, Math.max(0, index + (steps[event.key] ?? 0)))];
    if (!target) return;
    for (const button of buttons) button.tabIndex = button === target ? 0 : -1;
    target.focus();
  }

  private scope() {
    return this.allWorkspaces ? null : this.workspaceId;
  }

  private scoped() {
    return approvalsInWorkspace(this.items, this.scope());
  }

  /** The 需確認 queue in its current order, without requests this run already decided. */
  private pendingVisible() {
    return pendingQueue(this.scoped()).filter((item) => !this.decidedIds.has(item.id));
  }

  private visibleFor(tab: ApprovalTab) {
    if (tab === "pending") return this.pendingVisible();
    const { ongoing, recent } = splitApprovalItems(this.scoped());
    return sortForTab(tab === "running" ? ongoing : recent, tab);
  }

  private find(id: string | undefined) {
    return id === undefined ? undefined : this.items.find((item) => item.id === id);
  }

  /** All panel items (pending, running and finished); the page filters by tab and project. */
  render(items: ApprovalItem[], available = true, workspaceId: string | null = null) {
    this.items = [...items];
    this.available = available;
    for (const key of this.stats.keys())
      if (!items.some((item) => `${item.id}:${item.fingerprint}` === key)) this.stats.delete(key);
    if (this.workspaceId !== workspaceId) {
      this.workspaceId = workspaceId;
      this.allWorkspaces = false;
      const shown = this.reviewed ?? this.find(this.recordId);
      if (shown && workspaceId !== null && shown.workspace_id !== workspaceId) this.backToQueue();
    }
    // A request that left the snapshot entirely cannot be reviewed any more.
    if (this.reviewed && !this.find(this.reviewed.id)) this.backToQueue(this.openState);
    if (this.recordId && !this.find(this.recordId)) this.backToQueue(this.openState);
    this.renderList();
    if (this.recordId) this.renderRecord();
    this.refreshView();
  }

  private tick() {
    if (!this.openState) return;
    if (!this.inDetail) this.renderList();
    else if (this.recordId) this.updateRecordMeta();
    this.updateDecision();
  }

  // ---------- Queue ----------

  private statFor(item: ApprovalItem) {
    const key = `${item.id}:${item.fingerprint}`;
    if (!this.stats.has(key)) this.stats.set(key, diffStat(item));
    return this.stats.get(key);
  }

  private createRow(id: string): Row {
    const li = el("li");
    const button = el("button", "k-row k-row--q");
    button.type = "button";
    button.dataset.id = id;
    const tile = el("span", "k-kind k-row__lead");
    const lead = icon("Terminal", { size: "lg" });
    tile.append(lead);
    const title = el("span", "k-row__title");
    const trail = el("span", "k-row__trail");
    const statePill = el("span", "k-pill");
    const pillIcon = icon("Desktop");
    const pillLabel = el("span");
    statePill.append(pillIcon, pillLabel);
    trail.append(statePill);
    const preview = el("span", "k-row__preview");
    const meta = el("span", "k-row__meta sp-meta");
    const reason = el("span", "k-row__reason");
    button.append(tile, title, trail, preview, meta, reason);
    button.addEventListener("click", () => {
      const current = this.find(id);
      if (current) this.openFromRow(current);
    });
    li.append(button);
    return {
      li,
      button,
      lead,
      title,
      pill: statePill,
      pillIcon,
      pillLabel,
      preview,
      meta,
      reason,
      metaKey: "",
    };
  }

  private renderMeta(row: Row, meta: RowMeta[]) {
    const key = JSON.stringify(meta);
    if (row.metaKey === key) return;
    row.metaKey = key;
    const parts = meta.map((part, index): Node => {
      let node: Node;
      if (part.kind === "tag") node = workspaceTag(part.text, part.hue);
      else if (part.kind === "text") node = el("span", undefined, part.text);
      else if (part.kind === "stat") node = diffStatElement(part.additions, part.deletions);
      else {
        const time = el("span", "k-countdown");
        if (part.urgency) time.dataset.urgency = part.urgency;
        time.append(icon("Timer"), el("span", undefined, part.text));
        node = time;
      }
      return index ? metaItem(node) : node;
    });
    row.meta.replaceChildren(...parts);
  }

  private renderList() {
    if (this.inDetail) return;
    const tab = this.currentTab;
    const visible = this.visibleFor(tab);
    const now = this.now();
    const visibleIds = new Set(visible.map((item) => item.id));
    let lostFocus = false;
    for (const [id, row] of this.rows) {
      if (visibleIds.has(id)) continue;
      lostFocus ||= row.li.contains(document.activeElement);
      row.li.remove();
      this.rows.delete(id);
    }
    visible.forEach((item, index) => {
      let row = this.rows.get(item.id);
      if (!row) {
        row = this.createRow(item.id);
        this.rows.set(item.id, row);
      }
      const view = queueRow(item, tab, now, tab === "pending" ? this.statFor(item) : undefined);
      setIcon(row.lead, view.icon);
      if (row.title.textContent !== view.title) row.title.textContent = view.title;
      row.pill.dataset.tone = view.pill.tone;
      setIcon(row.pillIcon, view.pill.icon);
      row.pillIcon.classList.toggle("k-spin", view.pill.spin);
      if (row.pillLabel.textContent !== view.pill.label)
        row.pillLabel.textContent = view.pill.label;
      if (row.preview.textContent !== view.preview) row.preview.textContent = view.preview;
      this.renderMeta(row, view.meta);
      row.reason.hidden = !view.reason;
      if (view.reason) {
        if (row.reason.textContent !== view.reason.text) row.reason.textContent = view.reason.text;
        if (view.reason.tone) row.reason.dataset.tone = view.reason.tone;
        else delete row.reason.dataset.tone;
      }
      if (this.list.children[index] !== row.li)
        this.list.insertBefore(row.li, this.list.children[index] ?? null);
    });
    // Roving tabindex: one row in the tab order, arrows move between rows.
    const buttons = [...this.rows.values()].map((row) => row.button);
    const current =
      buttons.find((button) => button === document.activeElement) ??
      this.rows.get(this.lastRow ?? "")?.button ??
      this.list.querySelector<HTMLButtonElement>("button.k-row") ??
      undefined;
    for (const button of buttons) button.tabIndex = button === current ? 0 : -1;
    if (lostFocus && this.openState) (current ?? this.tabs.get(tab))?.focus();

    const info = TABS.find((entry) => entry.id === tab);
    this.list.hidden = visible.length === 0;
    this.list.setAttribute("aria-label", info?.label ?? "");
    this.empty.hidden = visible.length > 0;
    if (info) {
      setIcon(this.emptyIcon, emptyIcons[tab]);
      if (this.emptyTitle.textContent !== info.empty) this.emptyTitle.textContent = info.empty;
      this.emptyText.textContent = info.text ?? "";
      this.emptyText.hidden = !info.text;
    }
    // Browsing one project never hides that others are waiting.
    const elsewhere =
      tab === "pending" && this.workspaceId !== null && !this.allWorkspaces
        ? pendingQueue(this.items).length - pendingQueue(this.scoped()).length
        : 0;
    this.elsewhere.hidden = !(
      (this.allWorkspaces && this.workspaceId !== null && tab === "pending") ||
      elsewhere > 0
    );
    if (!this.elsewhere.hidden) {
      const text = this.allWorkspaces ? "正在顯示全部專案。" : `其他專案還有 ${elsewhere} 件。`;
      if (this.elsewhereText.textContent !== text) this.elsewhereText.textContent = text;
      setButtonLabel(this.elsewhereToggle, this.allWorkspaces ? "只看目前專案" : "顯示全部專案");
    }
  }

  private openFromRow(item: ApprovalItem) {
    this.queueScroll = this.scroll.scrollTop;
    this.lastRow = item.id;
    this.decidedIds.clear();
    if (item.state === "pending") this.openReview(item, false);
    else this.openRecord(item);
  }

  private backToQueue(restore = true) {
    this.clearDetail();
    this.decidedIds.clear();
    this.renderList();
    this.refreshView();
    this.scroll.scrollTop = this.queueScroll;
    if (restore && this.openState) {
      const row = this.rows.get(this.lastRow ?? "");
      (row ? row.button : this.tabs.get(this.currentTab))?.focus();
    }
  }

  // ---------- Review (pending) ----------

  private openReview(item: ApprovalItem, advanced: boolean) {
    this.reviewed = structuredClone(item);
    this.recordId = undefined;
    this.advanced = advanced;
    this.lastRemaining = undefined;
    this.reasonOpen = false;
    this.reasonInput.value = "";
    // Arm on every open: the second click of a double click (on a row or on the previous
    // request's buttons) cannot land on this request's decision.
    this.armed = armedUntil(this.now());
    clearTimeout(this.armTimer);
    this.armTimer = setTimeout(() => this.updateDecision(), ARM_DELAY_MS + 20);
    this.renderReview(this.reviewed);
    this.refreshView();
    this.scroll.scrollTop = 0;
    this.title.focus({ preventScroll: true });
  }

  private renderReview(item: ApprovalItem) {
    const parts: HTMLElement[] = [riskElement(item, this.windows)];
    const reason = modelReason(item);
    if (reason) parts.push(quote(reason));
    parts.push(...facts(item, this.diffView), requestMeta(item, this.now()));
    this.detail.replaceChildren(...parts);
    setButtonLabel(this.approve, primaryLabel(item));
  }

  private setReason(open: boolean) {
    if (!this.reviewed) return;
    this.reasonOpen = open;
    if (!open) this.reasonInput.value = "";
    this.refreshView();
    (open ? this.reasonInput : this.reasonToggle).focus();
  }

  private blockActionClick() {
    const kind = this.blockAction.dataset.kind;
    if (kind === "back") this.backToQueue();
    else if (kind === "rereview") {
      const current = this.find(this.reviewed?.id);
      if (current?.state === "pending") this.openReview(current, this.advanced);
    }
  }

  /** Re-evaluates whether the reviewed request may still be decided. Runs every second. */
  private updateDecision() {
    const reviewed = this.reviewed;
    if (!this.openState || !reviewed) return;
    const now = this.now();
    const current = this.find(reviewed.id);
    const uncertain = this.uncertain(reviewed);
    const blockFor = (action: "approve" | "deny") =>
      approvalDecisionBlock(reviewed, current, this.available, action, now, uncertain);
    const block = blockFor("approve");
    const denyBlock = blockFor("deny");
    const arming = decisionArming(this.armed, now);
    // While our own decision is in flight the request leaving "pending" is expected.
    const notice = this.busy ? undefined : decisionNotice(block);
    this.block.hidden = !notice;
    if (notice) {
      this.block.dataset.tone = notice.tone;
      setIcon(this.blockIcon, notice.icon);
      if (this.blockText.textContent !== notice.text) this.blockText.textContent = notice.text;
      this.blockAction.hidden = !notice.action;
      if (notice.action) {
        this.blockAction.dataset.kind = notice.action.kind;
        setButtonLabel(this.blockAction, notice.action.label);
        this.blockAction.disabled = notice.action.kind === "rereview" && !this.available;
      }
    }
    const reason = checkDenialReason(this.reasonInput.value);
    this.reasonCount.textContent = `${[...this.reasonInput.value].length}／${DENIAL_REASON_MAX_LENGTH}`;
    this.reasonError.textContent = reason.ok ? "" : reason.message;
    this.reasonError.hidden = reason.ok;
    this.reasonInput.setAttribute("aria-invalid", String(!reason.ok));
    this.reasonInput.readOnly = this.busy;
    this.approve.disabled = this.busy || arming || Boolean(block);
    this.deny.disabled = this.busy || arming || Boolean(denyBlock);
    this.reasonSubmit.disabled =
      this.busy || arming || Boolean(denyBlock) || !reason.ok || reason.reason === undefined;
    this.reasonToggle.disabled = this.busy || Boolean(denyBlock);
    this.bar.setAttribute("aria-busy", String(this.busy));

    // The earlier deadline wins: a request never looks more open than it is.
    const deadline = Math.min(reviewed.expires_at, current?.expires_at ?? reviewed.expires_at);
    const remaining = deadline - now;
    const shown = countdown(deadline, now);
    if (this.timerText.textContent !== shown.text) this.timerText.textContent = shown.text;
    if (shown.urgency) this.timer.dataset.urgency = shown.urgency;
    else delete this.timer.dataset.urgency;
    this.timer.setAttribute("aria-label", shown.spoken);
    const milestone = countdownMilestone(this.lastRemaining, remaining);
    this.lastRemaining = remaining;
    if (milestone && current?.state === "pending")
      this.announce(`${approvalTitle(reviewed)}：${milestone}`);
    this.updatePosition();
  }

  private updatePosition() {
    const reviewed = this.reviewed;
    if (!reviewed) return;
    const queue = this.pendingVisible();
    const index = queue.findIndex((item) => item.id === reviewed.id);
    const text =
      index === -1
        ? ""
        : `${this.advanced ? "下一件 " : ""}${queuePosition(this.decidedIds.size, index, queue.length)}`;
    if (this.position.textContent !== text) this.position.textContent = text;
    this.position.hidden = !text;
  }

  private async submit(action: "approve" | "deny", withReason = false) {
    const reviewed = this.reviewed;
    const now = this.now();
    if (!reviewed || this.busy || decisionArming(this.armed, now)) return;
    const current = this.find(reviewed.id);
    if (
      approvalDecisionBlock(
        reviewed,
        current,
        this.available,
        action,
        now,
        this.uncertain(reviewed),
      )
    )
      return;
    let reason: string | undefined;
    if (withReason) {
      const checked = checkDenialReason(this.reasonInput.value);
      if (!checked.ok || checked.reason === undefined) return;
      reason = checked.reason;
    }
    const order = this.pendingVisible().map((item) => item.id);
    this.busy = true;
    this.updateDecision();
    let decided = false;
    try {
      await this.decide(reviewed, action, reason);
      decided = true;
    } catch (cause) {
      this.report(cause instanceof Error ? cause.message : "結果待確認；請查詢狀態。");
    } finally {
      this.busy = false;
    }
    if (decided && this.openState && this.reviewed?.id === reviewed.id)
      this.advance(reviewed, action, order);
    else this.updateDecision();
  }

  /** B7: open the next request in the same queue; it arms before it accepts a decision. */
  private advance(decided: ApprovalItem, action: "approve" | "deny", order: string[]) {
    this.decidedIds.add(decided.id);
    const done = action === "approve" ? "已允許" : "已拒絕";
    const next = nextPending(order, decided.id, this.pendingVisible());
    if (!next) {
      this.lastRow = undefined;
      this.backToQueue();
      this.announce(`${done}。沒有其他待確認的請求。`);
      return;
    }
    this.lastRow = next.id;
    this.openReview(next, true);
    this.announce(`${done}。${this.position.textContent ?? ""}：${approvalTitle(next)}`);
  }

  // ---------- Read-only record (running, finished) ----------

  private openRecord(item: ApprovalItem) {
    this.reviewed = undefined;
    this.recordId = item.id;
    this.recordKey = "";
    this.renderRecord();
    this.refreshView();
    this.scroll.scrollTop = 0;
    this.title.focus({ preventScroll: true });
  }

  private renderRecord() {
    const item = this.find(this.recordId);
    if (!item) return;
    if (item.state === "pending") {
      // A record never turns into a decision without a fresh, armed review.
      this.openReview(item, false);
      return;
    }
    const key = JSON.stringify(item);
    if (key !== this.recordKey) {
      this.recordKey = key;
      const outcome = el("div", "rq-outcome");
      const state = stateView(item);
      const statePill = pill(
        state.dataTone,
        state.icon === "Dot" ? undefined : state.icon,
        state.label,
        state.spin,
      );
      statePill.classList.add("k-pill--lg");
      outcome.append(statePill);
      const reason = outcomeReason(item);
      if (reason) {
        const line = el("p", "rq-outcome__reason", reason.text);
        if (reason.tone) line.dataset.tone = reason.tone;
        outcome.append(line);
      }
      const running = el("p", "rq-outcome__meta");
      running.dataset.role = "running-meta";
      outcome.append(running);
      this.detail.replaceChildren(
        outcome,
        ...facts(item, this.diffView),
        requestMeta(item, this.now()),
      );
    }
    this.updateRecordMeta();
  }

  private updateRecordMeta() {
    const item = this.find(this.recordId);
    if (!item) return;
    const line = this.detail.querySelector<HTMLElement>("[data-role='running-meta']");
    const text = runningMeta(item, this.now()) ?? "";
    if (line && line.textContent !== text) line.textContent = text;
    if (line) line.hidden = !text;
    this.stopButton.disabled =
      !this.available ||
      this.stopping.has(item.id) ||
      this.uncertain(item) ||
      !canStopOngoing(item);
  }

  private async stop() {
    const item = this.find(this.recordId);
    if (
      !item ||
      !this.available ||
      !canStopOngoing(item) ||
      this.stopping.has(item.id) ||
      this.uncertain(item)
    )
      return;
    this.stopping.add(item.id);
    this.updateRecordMeta();
    try {
      await this.decide(item, "stop");
    } catch (cause) {
      this.report(cause instanceof Error ? cause.message : "停止結果尚未確認，請等待狀態更新。");
    } finally {
      this.stopping.delete(item.id);
      this.updateRecordMeta();
    }
  }

  // ---------- Layout ----------

  private refreshView() {
    const review = this.reviewed;
    const record = this.find(this.recordId);
    const detail = Boolean(review || record);
    this.queue.hidden = detail;
    this.detail.hidden = !detail;
    this.tabList.hidden = detail;
    this.title.hidden = !detail;
    this.timer.hidden = !review;
    for (const [id, tab] of this.tabs) {
      const selected = id === this.currentTab;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    // 執行中 carries the count of the list it opens (this project, or every project).
    const running = activeIndicator(splitApprovalItems(this.scoped()).ongoing.length);
    const runningTab = this.tabs.get("running");
    this.runningBadge.hidden = running.hidden;
    if (this.runningBadge.textContent !== running.badge)
      this.runningBadge.textContent = running.badge;
    if (running.hidden) runningTab?.removeAttribute("aria-label");
    else runningTab?.setAttribute("aria-label", running.ariaLabel);
    this.queue.setAttribute("aria-labelledby", `approvals-tab-${this.currentTab}`);
    const backLabel = detail ? backLabels[this.currentTab] : "返回工作台";
    if (this.back.getAttribute("aria-label") !== backLabel)
      this.back.setAttribute("aria-label", backLabel);
    const shown = review ?? record;
    if (shown) {
      const title = approvalTitle(shown);
      if (this.title.textContent !== title) this.title.textContent = title;
    }
    if (!review) this.position.hidden = true;

    const stoppable = Boolean(record && canStopOngoing(record));
    this.bar.hidden = !review && !stoppable;
    this.approve.hidden = !review || this.reasonOpen;
    this.deny.hidden = !review || this.reasonOpen;
    this.reasonSubmit.hidden = !review || !this.reasonOpen;
    this.reasonCancel.hidden = !review || !this.reasonOpen;
    this.reasonBox.hidden = !review || !this.reasonOpen;
    this.reasonToggle.hidden = !review || this.reasonOpen;
    this.stopButton.hidden = Boolean(review) || !stoppable;
    this.decisionRow.classList.toggle("rq-bar__row--single", !review);
    if (!review) this.block.hidden = true;
    if (review) this.updateDecision();
    else if (record) this.updateRecordMeta();
  }
}
