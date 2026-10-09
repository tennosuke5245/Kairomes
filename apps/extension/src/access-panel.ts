import type { AccessGrant, PanelSnapshot, TrackedPanelAccessMutation } from "@kairomes/protocol";
import {
  accessChip,
  activeGrants,
  type GrantPhase,
  grantAnnouncements,
  grantTime,
  grantTimeText,
  levelLabel,
} from "./access-state.ts";
import { icon, type PanelIcon, setIcon } from "./icons.ts";
import { Popover } from "./popover.ts";

type AccessMode = "confirm" | AccessGrant["level"];
type Duration = "15" | "60" | "240" | "persistent";

const MODES: ReadonlyArray<{
  mode: AccessMode;
  icon: PanelIcon;
  title: string;
  desc: string;
  risks?: ReadonlyArray<[PanelIcon, string]>;
}> = [
  {
    mode: "confirm",
    icon: "ShieldCheck",
    title: "逐步確認",
    desc: "檔案變更、命令與終端機都先問你。",
  },
  {
    mode: "files",
    icon: "PencilSimple",
    title: "檔案自主",
    desc: "工作區內的檔案變更直接套用；命令仍要核准。",
  },
  {
    mode: "full",
    icon: "Lightning",
    title: "全自主",
    desc: "命令與終端機直接執行，不再逐一詢問。",
    // Host privilege is stated wherever full autonomy can be chosen; it is never a sandbox.
    risks: [
      ["Desktop", "主機權限"],
      ["ArrowSquareOut", "可操作工作區外"],
      ["Globe", "可連網"],
    ],
  },
];

const DURATIONS: ReadonlyArray<[Duration, string]> = [
  ["15", "15 分鐘"],
  ["60", "1 小時"],
  ["240", "4 小時"],
  ["persistent", "直到收回"],
];

let ids = 0;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** Lives only in the trusted Extension document, never in the workbench iframe. */
export class AccessPanel {
  private readonly chipIcon = icon("ShieldCheck");
  private readonly chipLabel = element("span", "k-collapse-label");
  private readonly chipSep = element("span", "k-collapse-label sp-access__sep", "·");
  private readonly chipTime = element("span", "k-access__time");
  private readonly chipLead = element("span", "sp-access__lead");
  private readonly chipValue = document.createTextNode("");
  private readonly chipTail = element("span", "sp-access__tail");
  private readonly title = element("h2", "k-popover__title");
  private readonly workspaceRow = element("label", "ap-workspace");
  private readonly workspace = element("select", "k-input");
  private readonly modes = element("div", "ap-modes");
  private readonly modeButtons = new Map<AccessMode, HTMLButtonElement>();
  private readonly modeChecks = new Map<AccessMode, SVGSVGElement>();
  private readonly modeIcons = new Map<AccessMode, SVGSVGElement>();
  private readonly durationRow = element("div", "ap-duration");
  private readonly durationButtons = new Map<Duration, HTMLButtonElement>();
  private readonly scope = element("p", "ap-scope", "適用所有 ChatGPT 聊天，不只目前這一個。");
  private readonly current = element("div", "ap-current");
  private readonly currentIcon = icon("Lightning", { fill: true });
  private readonly currentText = element("span", "ap-current__text");
  private readonly revoke = element("button", "k-btn k-btn--danger-quiet k-btn--sm", "收回");
  private readonly cancel = element("button", "k-btn k-btn--secondary", "取消");
  private readonly apply = element("button", "k-btn k-btn--primary");
  private readonly popover: Popover;
  private selectedMode: AccessMode = "confirm";
  private duration: Duration = "60";
  private busy = false;
  private available = false;
  private snapshot?: PanelSnapshot;
  private browsingWorkspace: string | null = null;
  private grantKey = "";
  private phases = new Map<string, GrantPhase>();

  constructor(
    private readonly trigger: HTMLButtonElement,
    panel: HTMLElement,
    private readonly change: (body: unknown) => Promise<void>,
    private readonly report: (message: string) => void,
    private readonly unknown: () => TrackedPanelAccessMutation | undefined = () => undefined,
    private readonly announce: (message: string) => void = () => {},
  ) {
    const id = `access-${++ids}`;
    trigger.classList.add("k-access");
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.replaceChildren(this.chipIcon, this.chipLabel, this.chipSep, this.chipTime);
    this.chipTime.append(this.chipLead, this.chipValue, this.chipTail);
    this.chipSep.setAttribute("aria-hidden", "true");

    panel.classList.add("k-popover", "sp-popover", "ap");
    panel.setAttribute("role", "dialog");
    panel.tabIndex = -1;
    this.title.id = `${id}-title`;
    panel.setAttribute("aria-labelledby", this.title.id);

    const workspaceLabel = element("span", "k-label", "專案");
    this.workspaceRow.append(workspaceLabel, this.workspace);

    this.modes.setAttribute("role", "radiogroup");
    this.modes.setAttribute("aria-labelledby", this.title.id);
    for (const option of MODES) {
      const button = element("button", "k-option");
      button.type = "button";
      button.setAttribute("role", "radio");
      button.dataset.mode = option.mode;
      const modeIcon = icon(option.icon, { size: "lg", className: "ap-option__icon" });
      const title = element("span", "k-option__title", option.title);
      title.id = `${id}-${option.mode}-title`;
      const check = icon("Check", { className: "ap-option__check" });
      const desc = element("span", "k-option__desc", option.desc);
      desc.id = `${id}-${option.mode}-desc`;
      button.setAttribute("aria-labelledby", title.id);
      const described = [desc.id];
      button.append(modeIcon, title, check, desc);
      if (option.risks) {
        const risks = element("span", "k-option__risk");
        risks.id = `${id}-${option.mode}-risk`;
        for (const [riskIcon, text] of option.risks) {
          const fact = element("span", "ap-risk");
          fact.append(icon(riskIcon, { size: "sm" }), text);
          risks.append(fact);
        }
        button.append(risks);
        described.push(risks.id);
      }
      button.setAttribute("aria-describedby", described.join(" "));
      button.addEventListener("click", (event) => {
        if (!event.isTrusted || this.busy || this.unknown()) return;
        this.selectedMode = option.mode;
        this.updateControls();
      });
      this.modeButtons.set(option.mode, button);
      this.modeChecks.set(option.mode, check);
      this.modeIcons.set(option.mode, modeIcon);
      this.modes.append(button);
    }
    this.modes.addEventListener("keydown", (event) => this.arrow(event));

    const durationLabel = element("span", "k-label", "期限");
    durationLabel.id = `${id}-duration`;
    const chips = element("div", "k-chips");
    chips.setAttribute("role", "radiogroup");
    chips.setAttribute("aria-labelledby", durationLabel.id);
    for (const [value, label] of DURATIONS) {
      const chip = element("button", "k-chip", label);
      chip.type = "button";
      chip.setAttribute("role", "radio");
      chip.addEventListener("click", (event) => {
        if (!event.isTrusted || this.busy) return;
        this.duration = value;
        this.updateControls();
      });
      this.durationButtons.set(value, chip);
      chips.append(chip);
    }
    chips.addEventListener("keydown", (event) => {
      const values = DURATIONS.map(([value]) => value);
      const next = this.step(event, values, this.duration);
      if (!next || this.busy) return;
      this.duration = next;
      this.updateControls();
      this.durationButtons.get(next)?.focus();
    });
    this.durationRow.append(durationLabel, chips);

    this.current.append(this.currentIcon, this.currentText, this.revoke);

    const foot = element("div", "k-popover__foot");
    this.cancel.type = this.apply.type = this.revoke.type = "button";
    foot.append(this.cancel, this.apply);
    panel.replaceChildren(
      this.title,
      this.workspaceRow,
      this.modes,
      this.durationRow,
      this.scope,
      this.current,
      foot,
    );

    this.popover = new Popover(trigger, panel, {
      onOpen: () => this.syncSelection(),
      initialFocus: () => this.modeButtons.get(this.selectedMode),
    });
    trigger.addEventListener("click", () => this.popover.toggle());
    this.cancel.addEventListener("click", () => this.popover.close(true));
    this.workspace.addEventListener("change", () => this.syncSelection());
    this.apply.addEventListener("click", (event) => {
      if (event.isTrusted) void this.submit();
    });
    this.revoke.addEventListener("click", (event) => {
      if (event.isTrusted) void this.submit("confirm");
    });
  }

  private step<T>(event: KeyboardEvent, values: readonly T[], selected: T): T | undefined {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
      return undefined;
    event.preventDefault();
    const index = values.indexOf(selected);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? values.length - 1
          : (index + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + values.length) %
            values.length;
    return values[next];
  }

  private arrow(event: KeyboardEvent) {
    if (this.busy || !this.available || this.unknown()) return;
    const next = this.step(event, [...this.modeButtons.keys()], this.selectedMode);
    if (!next) return;
    this.selectedMode = next;
    this.updateControls();
    this.modeButtons.get(next)?.focus();
  }

  private selectedGrant() {
    return activeGrants(this.snapshot?.accessGrants).find(
      (grant) => grant.workspace_id === this.workspace.value,
    );
  }

  private syncSelection() {
    this.selectedMode = this.selectedGrant()?.level ?? "confirm";
    this.updateControls();
  }

  private updateControls() {
    const unknown = this.unknown();
    const locked = this.busy || !this.available || !!unknown;
    const recoverable =
      unknown?.action === "enable" && unknown.workspace_id === this.workspace.value;
    const name = this.workspace.selectedOptions[0]?.textContent ?? "";
    const title = this.workspace.options.length > 1 || !name ? "操作模式" : `操作模式 · ${name}`;
    if (this.title.textContent !== title) this.title.textContent = title;
    this.workspaceRow.hidden = this.workspace.options.length <= 1;
    for (const [mode, button] of this.modeButtons) {
      const selected = mode === this.selectedMode;
      button.setAttribute("aria-checked", String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.disabled = locked;
      this.modeChecks.get(mode)?.classList.toggle("ap-option__check--on", selected);
    }
    const lightning = this.modeIcons.get("full");
    if (lightning) setIcon(lightning, "Lightning", this.selectedMode === "full");
    this.durationRow.hidden = this.selectedMode !== "full";
    this.scope.hidden = this.selectedMode === "confirm";
    for (const [value, chip] of this.durationButtons) {
      const selected = value === this.duration;
      chip.setAttribute("aria-checked", String(selected));
      chip.tabIndex = selected ? 0 : -1;
      chip.disabled = locked;
    }
    this.workspace.disabled = locked;
    const current = this.selectedGrant();
    this.current.hidden = !current && !recoverable;
    this.renderCurrent(current);
    this.revoke.disabled =
      this.busy || !this.available || (!current && !recoverable) || (!!unknown && !recoverable);
    this.apply.disabled =
      locked || !this.workspace.value || (this.selectedMode === "confirm" && !current);
    this.apply.setAttribute("aria-busy", String(this.busy));
    const duration = DURATIONS.find(([value]) => value === this.duration)?.[1] ?? "";
    this.apply.textContent = this.busy
      ? "正在更新…"
      : this.selectedMode === "confirm"
        ? "套用逐步確認"
        : this.selectedMode === "files"
          ? "啟用檔案自主"
          : this.duration === "persistent"
            ? "啟用全自主，直到收回"
            : `啟用全自主 ${duration}`;
  }

  private renderCurrent(current: AccessGrant | undefined, now = Date.now()) {
    if (!current) {
      this.currentText.textContent = this.unknown() ? "權限待確認" : "";
      setIcon(this.currentIcon, "Question");
      return;
    }
    const text = `目前：${levelLabel(current.level)} · ${
      current.expires_at === null ? "直到收回" : grantTimeText(grantTime(current.expires_at, now))
    }`;
    if (this.currentText.textContent !== text) this.currentText.textContent = text;
    setIcon(
      this.currentIcon,
      current.level === "full" ? "Lightning" : "PencilSimple",
      current.level === "full",
    );
  }

  private renderChip(now = Date.now()) {
    const chip = accessChip({
      grants: this.snapshot?.accessGrants,
      workspaceId: this.browsingWorkspace,
      available: this.available,
      unknown: !!this.unknown(),
      now,
    });
    this.trigger.dataset.mode = chip.mode;
    if (chip.urgent) this.trigger.dataset.urgency = "soon";
    else delete this.trigger.dataset.urgency;
    setIcon(this.chipIcon, chip.icon, chip.fill);
    if (this.chipLabel.textContent !== chip.label) this.chipLabel.textContent = chip.label;
    this.chipSep.hidden = this.chipTime.hidden = !chip.time;
    const time = chip.time ?? { lead: "", value: "", tail: "" };
    if (this.chipLead.textContent !== time.lead) this.chipLead.textContent = time.lead;
    if (this.chipValue.data !== time.value) this.chipValue.data = time.value;
    if (this.chipTail.textContent !== time.tail) this.chipTail.textContent = time.tail;
    if (this.trigger.getAttribute("aria-label") !== chip.ariaLabel)
      this.trigger.setAttribute("aria-label", chip.ariaLabel);
  }

  /** The panel's 1 s tick: countdowns only; it never changes or extends a grant. */
  tick(now = Date.now()) {
    const grants = this.snapshot?.accessGrants;
    const result = grantAnnouncements(this.phases, grants, now);
    this.phases = result.phases;
    for (const message of result.messages) this.announce(message);
    this.renderChip(now);
    // An expired grant falls back to 逐步確認 in the open popover as well.
    const key = this.grantSelectionKey(now);
    if (key !== this.grantKey) {
      this.grantKey = key;
      if (!this.busy) this.syncSelection();
    } else this.renderCurrent(this.selectedGrant(), now);
  }

  private grantSelectionKey(now = Date.now()) {
    const current = activeGrants(this.snapshot?.accessGrants, now).find(
      (grant) => grant.workspace_id === this.workspace.value,
    );
    return `${this.workspace.value}:${current?.id ?? ""}:${current?.level ?? ""}:${current?.expires_at ?? ""}`;
  }

  private async submit(mode = this.selectedMode) {
    if (this.busy || !this.available || !this.workspace.value) return;
    const unknown = this.unknown();
    if (
      unknown &&
      (mode !== "confirm" ||
        unknown.action !== "enable" ||
        unknown.workspace_id !== this.workspace.value)
    )
      return;
    this.busy = true;
    this.updateControls();
    let failed = false;
    try {
      await this.change(
        mode === "confirm"
          ? { action: "disable", workspace_id: this.workspace.value }
          : {
              action: "enable",
              workspace_id: this.workspace.value,
              level: mode,
              minutes:
                mode === "files" || this.duration === "persistent" ? null : Number(this.duration),
            },
      );
    } catch (cause) {
      failed = true;
      this.report(cause instanceof Error ? cause.message : "權限變更尚未確認，請檢查連線。");
    } finally {
      this.busy = false;
      this.render(this.snapshot, this.available);
    }
    if (!failed && !this.unknown()) this.popover.close(true);
  }

  render(snapshot?: PanelSnapshot, available = true) {
    this.snapshot = snapshot;
    this.available = available;
    const workspaces = snapshot?.workspaces ?? [];
    if (
      [...this.workspace.options]
        .map((option) => `${option.value}:${option.textContent}`)
        .join() !== workspaces.map((workspace) => `${workspace.id}:${workspace.name}`).join()
    ) {
      const selected = this.workspace.value;
      this.workspace.replaceChildren(
        ...workspaces.map((workspace) => {
          const option = document.createElement("option");
          option.value = workspace.id;
          option.textContent = workspace.name;
          return option;
        }),
      );
      if (workspaces.some((workspace) => workspace.id === selected))
        this.workspace.value = selected;
    }
    const unfinished = this.unknown();
    if (unfinished && workspaces.some((workspace) => workspace.id === unfinished.workspace_id))
      this.workspace.value = unfinished.workspace_id;
    this.renderChip();
    const key = this.grantSelectionKey();
    if (key !== this.grantKey) {
      this.grantKey = key;
      this.syncSelection();
    } else this.updateControls();
  }

  selectWorkspace(id: string | null) {
    this.browsingWorkspace = id;
    if (!this.unknown() && id && [...this.workspace.options].some((option) => option.value === id))
      this.workspace.value = id;
    this.render(this.snapshot, this.available);
  }

  close() {
    this.popover.close(false);
  }
}
