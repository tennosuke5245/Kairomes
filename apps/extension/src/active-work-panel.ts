import {
  artifactImportLabels,
  commandLabels,
  fileChangeLabels,
  terminalLabels,
} from "@kairomes/protocol";
import { type ApprovalItem, canStopOngoing } from "./approval-state.ts";

type WorkCard = {
  root: HTMLElement;
  title: HTMLElement;
  status: HTMLElement;
  detail: HTMLElement;
  action: HTMLButtonElement;
  item: ApprovalItem;
};

/** Process controls stay in the trusted Extension, outside the workbench iframe. */
export class ActiveWorkPanel {
  private cards = new Map<string, WorkCard>();
  private busy = new Set<string>();

  constructor(
    private readonly container: HTMLElement,
    private readonly stop: (item: ApprovalItem) => Promise<void>,
    private readonly report: (message: string) => void,
    private readonly uncertain: (item: ApprovalItem) => boolean = () => false,
  ) {}

  render(items: ApprovalItem[], available = true) {
    let removedFocus = false;
    for (const [id, card] of this.cards) {
      if (items.some((item) => item.id === id)) continue;
      removedFocus ||= card.root.contains(document.activeElement);
      card.root.remove();
      this.cards.delete(id);
    }

    const sorted = [...items].sort((a, b) => b.created_at - a.created_at);
    for (const item of sorted) {
      let card = this.cards.get(item.id);
      if (!card) {
        const root = document.createElement("article");
        root.className = "active-work-card";
        const title = document.createElement("strong");
        const status = document.createElement("span");
        status.className = "active-work-status";
        const detail = document.createElement("small");
        const action = document.createElement("button");
        action.type = "button";
        action.className = "secondary";
        root.append(title, status, detail, action);
        card = { root, title, status, detail, action, item };
        this.cards.set(item.id, card);
        this.container.append(root);
        const currentCard = card;
        action.onclick = async (event) => {
          const current = currentCard.item;
          if (
            !event.isTrusted ||
            this.busy.has(current.id) ||
            this.uncertain(current) ||
            !canStopOngoing(current)
          )
            return;
          this.busy.add(current.id);
          currentCard.action.disabled = true;
          try {
            await this.stop(current);
          } catch (cause) {
            this.report(
              cause instanceof Error ? cause.message : "停止結果尚未確認，請等待狀態更新。",
            );
          } finally {
            this.busy.delete(current.id);
          }
        };
      }

      card.item = item;
      const artifactImport = "source_file_id" in item ? item : undefined;
      const change = "files" in item ? item : undefined;
      const command = "argv" in item ? item : undefined;
      const terminal = "shell" in item ? item : undefined;
      card.title.textContent = `${item.workspace_name} · ${artifactImport ? "圖片匯入" : change ? "檔案變更" : command ? "命令" : terminal?.shell}`;
      card.status.textContent = artifactImport
        ? artifactImportLabels[artifactImport.state]
        : change
          ? fileChangeLabels[change.state]
          : command
            ? commandLabels[command.state]
            : terminal
              ? terminalLabels[terminal.state]
              : "";
      card.detail.textContent = artifactImport
        ? artifactImport.path
        : change
          ? change.summary
          : command
            ? command.argv.join(" ")
            : terminal?.cwd || "專案根目錄";
      card.action.hidden = !canStopOngoing(item);
      card.action.textContent = command ? "取消命令" : "停止工作階段";
      card.action.setAttribute(
        "aria-label",
        `${card.action.textContent}：${card.title.textContent}`,
      );
      card.action.disabled = !available || this.busy.has(item.id) || this.uncertain(item);
    }

    sorted.forEach((item, index) => {
      const root = this.cards.get(item.id)?.root;
      if (root && this.container.children[index] !== root)
        this.container.insertBefore(root, this.container.children[index] ?? null);
    });
    if (removedFocus && sorted.length > 0) {
      const nextAction = this.container.querySelector<HTMLButtonElement>(
        "button:not([hidden]):not([disabled])",
      );
      (
        nextAction ?? this.container.parentElement?.querySelector<HTMLElement>("#active-close")
      )?.focus();
    } else if (
      document.activeElement instanceof HTMLButtonElement &&
      this.container.contains(document.activeElement) &&
      document.activeElement.disabled
    ) {
      this.container.parentElement?.querySelector<HTMLElement>("#active-close")?.focus();
    }
  }
}
