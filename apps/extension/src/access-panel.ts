import type { AccessGrant, PanelSnapshot, TrackedPanelAccessMutation } from "@kairomes/protocol";

type AccessMode = "confirm" | AccessGrant["level"];

function grantLabel(grant: AccessGrant) {
  const mode = grant.level === "full" ? "全自主" : "檔案自主";
  const limit =
    grant.expires_at === null
      ? "手動收回"
      : `${new Date(grant.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })} 到期`;
  return `${mode} · ${limit}`;
}

/** Lives only in the trusted Extension document, never in the workbench iframe. */
export class AccessPanel {
  private workspace = document.createElement("select");
  private duration = document.createElement("select");
  private durationWrap = document.createElement("label");
  private summary = document.createElement("summary");
  private status = document.createElement("span");
  private apply = document.createElement("button");
  private revoke = document.createElement("button");
  private grants = document.createElement("div");
  private note = document.createElement("p");
  private scope = document.createElement("p");
  private details = document.createElement("details");
  private modeButtons = new Map<AccessMode, HTMLButtonElement>();
  private selectedMode: AccessMode = "confirm";
  private busy = false;
  private available = false;
  private snapshot?: PanelSnapshot;
  private browsingWorkspace: string | null = null;
  private grantKey = "";

  constructor(
    container: HTMLElement,
    private readonly change: (body: unknown) => Promise<void>,
    private readonly report: (message: string) => void,
    private readonly unknown: () => TrackedPanelAccessMutation | undefined = () => undefined,
  ) {
    const details = this.details;
    details.className = "access-menu";
    this.status.className = "access-trigger-label";
    this.status.setAttribute("role", "status");
    this.summary.append(this.status);

    const popover = document.createElement("div");
    popover.className = "access-popover";
    const title = document.createElement("h2");
    title.textContent = "操作權限";
    const workspaceLabel = document.createElement("label");
    workspaceLabel.className = "access-workspace";
    workspaceLabel.textContent = "套用專案";
    this.workspace.setAttribute("aria-label", "授權工作區");
    workspaceLabel.append(this.workspace);

    const modes = document.createElement("div");
    modes.className = "access-modes";
    modes.setAttribute("role", "radiogroup");
    modes.setAttribute("aria-label", "操作模式");
    for (const [mode, label, help] of [
      ["confirm", "逐步確認", "檔案變更、命令與終端機需核准"],
      ["files", "檔案自主", "檔案變更自主；命令與終端機需核准"],
      ["full", "全自主", "命令與終端機可自主執行"],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "access-mode";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-label", `${label}：${help}`);
      button.dataset.mode = mode;
      const name = document.createElement("strong");
      name.textContent = label;
      button.append(name);
      button.onclick = (event) => {
        if (!event.isTrusted || this.busy || this.unknown()) return;
        this.selectedMode = mode;
        this.updateControls();
      };
      this.modeButtons.set(mode, button);
      modes.append(button);
    }
    modes.addEventListener("keydown", (event) => {
      if (
        !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) ||
        this.busy ||
        !this.available ||
        this.unknown()
      )
        return;
      event.preventDefault();
      const values = [...this.modeButtons.keys()];
      const index = values.indexOf(this.selectedMode);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? values.length - 1
            : (index + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + values.length) %
              values.length;
      this.selectedMode = values[next] ?? "confirm";
      this.updateControls();
      this.modeButtons.get(this.selectedMode)?.focus();
    });
    details.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        details.open = false;
        this.summary.focus();
      }
    });
    // This is a nonmodal disclosure: Tab may leave it, without leaving an overlay open.
    document.addEventListener("focusin", (event) => {
      if (details.open && event.target instanceof Node && !details.contains(event.target))
        details.open = false;
    });
    document.addEventListener("pointerdown", (event) => {
      if (!details.open || !(event.target instanceof Node) || details.contains(event.target))
        return;
      const movingFocus =
        event.target instanceof Element &&
        event.target.closest(
          "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, iframe, label, [contenteditable], [tabindex]:not([tabindex='-1'])",
        );
      const restore = !movingFocus && details.contains(document.activeElement);
      details.open = false;
      if (restore) this.summary.focus({ preventScroll: true });
    });
    window.addEventListener("blur", () => {
      // Focusing the cross-origin workbench does not bubble focusin into this document.
      queueMicrotask(() => {
        if (details.open && document.activeElement instanceof HTMLIFrameElement)
          details.open = false;
      });
    });

    this.durationWrap.className = "access-duration";
    this.durationWrap.textContent = "全自主期限";
    this.duration.setAttribute("aria-label", "全自主期限");
    for (const [value, label] of [
      ["15", "15 分鐘"],
      ["60", "1 小時"],
      ["240", "4 小時"],
      ["persistent", "直到手動收回"],
    ] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      this.duration.append(option);
    }
    this.duration.value = "60";
    this.durationWrap.append(this.duration);

    this.grants.className = "access-current";
    this.note.className = "access-note";
    this.scope.className = "access-note access-scope";
    this.scope.textContent = "適用此實例的所有聊天；切換瀏覽專案不會改變授權。";
    this.apply.type = this.revoke.type = "button";
    this.apply.className = "access-apply";
    this.revoke.className = "access-revoke";
    this.revoke.textContent = "立即收回";
    const actions = document.createElement("div");
    actions.className = "access-actions";
    actions.append(this.apply, this.revoke);
    popover.append(
      title,
      workspaceLabel,
      modes,
      this.durationWrap,
      this.grants,
      this.scope,
      this.note,
      actions,
    );
    details.append(this.summary, popover);
    container.append(details);

    this.workspace.onchange = () => this.syncSelection();
    this.apply.onclick = (event) => {
      if (event.isTrusted) void this.submit();
    };
    this.revoke.onclick = (event) => {
      if (event.isTrusted) void this.submit("confirm");
    };
  }

  private selectedGrant() {
    return this.snapshot?.accessGrants?.find(
      (grant) =>
        grant.workspace_id === this.workspace.value &&
        (grant.expires_at === null || grant.expires_at > Date.now()),
    );
  }

  private syncSelection() {
    this.selectedMode = this.selectedGrant()?.level ?? "confirm";
    this.updateControls();
  }

  private updateControls() {
    const unknown = this.unknown();
    const recoverable =
      unknown?.action === "enable" && unknown.workspace_id === this.workspace.value;
    for (const [mode, button] of this.modeButtons) {
      const selected = mode === this.selectedMode;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-checked", String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.disabled = this.busy || !this.available || !!unknown;
    }
    this.durationWrap.hidden = this.selectedMode !== "full";
    this.note.textContent =
      this.selectedMode === "full"
        ? "主機權限：可操作工作區外、可連網。收回會停止受此授權管理的工作。"
        : this.selectedMode === "files"
          ? "只授權工作區檔案變更；命令與終端機需核准。"
          : "每批檔案變更、命令與終端機需核准。";
    this.workspace.disabled = this.duration.disabled = this.busy || !this.available || !!unknown;
    const current = this.selectedGrant();
    this.grants.textContent = current ? `目前：${grantLabel(current)}` : "";
    this.apply.disabled = this.busy || !this.available || !!unknown || !this.workspace.value;
    this.revoke.disabled =
      this.busy || !this.available || (!current && !recoverable) || (!!unknown && !recoverable);
    this.revoke.hidden = !current && !recoverable;
    this.apply.textContent = this.busy
      ? "正在更新…"
      : this.selectedMode === "confirm"
        ? "套用逐步確認"
        : this.selectedMode === "files"
          ? "啟用檔案自主"
          : "啟用全自主";
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
    try {
      await this.change(
        mode === "confirm"
          ? { action: "disable", workspace_id: this.workspace.value }
          : {
              action: "enable",
              workspace_id: this.workspace.value,
              level: mode,
              minutes:
                mode === "files" || this.duration.value === "persistent"
                  ? null
                  : Number(this.duration.value),
            },
      );
    } catch (cause) {
      this.report(cause instanceof Error ? cause.message : "權限變更尚未確認，請檢查連線。");
    } finally {
      this.busy = false;
      this.render(this.snapshot, this.available);
    }
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
    const grants = (snapshot?.accessGrants ?? []).filter(
      (grant) => grant.expires_at === null || grant.expires_at > Date.now(),
    );
    const current = this.selectedGrant();
    const browsingGrant = grants.find((grant) => grant.workspace_id === this.browsingWorkspace);
    const status =
      !available || this.unknown()
        ? "權限待確認"
        : this.browsingWorkspace === null
          ? grants.length
            ? `${grants.length} 專案已授權`
            : "逐步確認"
          : browsingGrant
            ? grantLabel(browsingGrant)
            : "逐步確認";
    if (this.status.textContent !== status) this.status.textContent = status;
    this.summary.setAttribute("aria-label", `操作權限：${this.status.textContent}`);
    this.status.dataset.level = browsingGrant?.level ?? "confirm";
    const key = `${this.workspace.value}:${current?.id ?? ""}:${current?.level ?? ""}:${current?.expires_at ?? ""}`;
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
}
