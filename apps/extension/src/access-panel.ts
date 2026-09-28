import type { AccessGrant, PanelSnapshot } from "@kairomes/protocol";

type AccessMode = "confirm" | AccessGrant["level"];

function grantLabel(grant: AccessGrant) {
  const mode = grant.level === "full" ? "全自主" : "檔案自主";
  const limit =
    grant.expires_at === null
      ? "直到手動收回"
      : `至 ${new Date(grant.expires_at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}`;
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
  private modeButtons = new Map<AccessMode, HTMLButtonElement>();
  private selectedMode: AccessMode = "confirm";
  private busy = false;
  private available = false;
  private snapshot?: PanelSnapshot;

  constructor(
    container: HTMLElement,
    private readonly change: (body: unknown) => Promise<void>,
    private readonly report: (message: string) => void,
  ) {
    const details = document.createElement("details");
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
    for (const [mode, label, help] of [
      ["confirm", "逐步確認", "每批變更、命令與終端機都先問你。"],
      ["files", "檔案自主", "可自行套用工作區內的版本檢查變更；命令仍需確認。"],
      ["full", "全自主", "可執行命令與終端機；適合你要它持續完成任務時。"],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "access-mode";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-label", `${label}：${help}`);
      button.dataset.mode = mode;
      const name = document.createElement("strong");
      name.textContent = label;
      const description = document.createElement("span");
      description.textContent = help;
      button.append(name, description);
      button.onclick = (event) => {
        if (!event.isTrusted || this.busy) return;
        this.selectedMode = mode;
        this.updateControls();
      };
      this.modeButtons.set(mode, button);
      modes.append(button);
    }

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
    this.note.textContent =
      "「直到手動收回」會在你收回、解除配對、關閉 app 或卸載專案時結束。每次命令與終端機仍有自己的執行期限。";
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
      (grant) => grant.workspace_id === this.workspace.value,
    );
  }

  private syncSelection() {
    this.selectedMode = this.selectedGrant()?.level ?? "confirm";
    this.updateControls();
  }

  private updateControls() {
    for (const [mode, button] of this.modeButtons) {
      const selected = mode === this.selectedMode;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-checked", String(selected));
      button.disabled = this.busy || !this.available;
    }
    this.durationWrap.hidden = this.selectedMode !== "full";
    this.note.hidden = this.selectedMode !== "full";
    this.workspace.disabled = this.duration.disabled = this.busy || !this.available;
    const current = this.selectedGrant();
    this.apply.disabled = this.busy || !this.available || !this.workspace.value;
    this.revoke.disabled = this.busy || !this.available || !current;
    this.revoke.hidden = !current;
    this.apply.textContent = this.busy
      ? "正在更新…"
      : this.selectedMode === "confirm"
        ? "切換為逐步確認"
        : this.selectedMode === "files"
          ? "啟用檔案自主"
          : "啟用全自主";
  }

  private async submit(mode = this.selectedMode) {
    if (this.busy || !this.available || !this.workspace.value) return;
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
    const grants = snapshot?.accessGrants ?? [];
    const current = this.selectedGrant();
    this.status.textContent = !available
      ? "權限連線中"
      : current
        ? grantLabel(current)
        : grants.length
          ? `${grants.length} 個專案已授權`
          : "逐步確認";
    this.summary.setAttribute("aria-label", `操作權限：${this.status.textContent}`);
    this.status.dataset.level = current?.level ?? "confirm";
    this.grants.textContent = current ? `${current.workspace_name} · ${grantLabel(current)}` : "";
    this.syncSelection();
  }
}
