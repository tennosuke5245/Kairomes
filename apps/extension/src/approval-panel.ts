import type { ApprovalSession } from "@kairomes/protocol";
import {
  type ApprovalItem,
  approvalDecisionBlock,
  approvalsInWorkspace,
} from "./approval-state.ts";

function button(label: string, action: () => void) {
  const result = document.createElement("button");
  result.type = "button";
  result.textContent = label;
  result.onclick = action;
  return result;
}

export function approvalTitle(item: ApprovalItem) {
  return "source_file_id" in item
    ? "匯入圖片"
    : "files" in item
      ? `修改 ${item.files.length} 個檔案`
      : "argv" in item
        ? "執行命令"
        : `開啟 ${item.shell} 終端機`;
}

/** The complete review and every decision stay in native Extension DOM. */
export class ApprovalPanel {
  private heading = document.createElement("h2");
  private back = button("← 返回", () => this.backToQueue());
  private all = button("全部", () => {
    this.allWorkspaces = true;
    this.backToQueue();
  });
  private closeButton = button("返回工作台", () => this.close());
  private list = document.createElement("div");
  private detail = document.createElement("article");
  private notice = document.createElement("p");
  private rereview = button("重新審閱", () => {
    const current = this.items.find((item) => item.id === this.reviewed?.id);
    if (current) this.openItem(current);
  });
  private approve = button("允許", () => {});
  private deny = button("拒絕", () => {});
  private actions = document.createElement("div");
  private rows = new Map<string, HTMLButtonElement>();
  private items: ApprovalItem[] = [];
  private available = false;
  private workspaceId: string | null = null;
  private allWorkspaces = false;
  private reviewed?: ApprovalItem;
  private busy = false;
  private lastRow?: string;
  private queueScroll = 0;
  private tick?: ReturnType<typeof setInterval>;
  private openState = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly decide: (session: ApprovalItem, action: "approve" | "deny") => Promise<void>,
    private readonly report: (message: string) => void,
    private readonly visibility: (open: boolean) => void = () => {},
    private readonly uncertain: (item: ApprovalItem) => boolean = () => false,
  ) {
    this.container.classList.add("approval-page");
    const header = document.createElement("header");
    header.className = "approval-heading";
    this.heading.tabIndex = -1;
    header.append(this.back, this.heading, this.all, this.closeButton);
    this.list.className = "approval-queue";
    this.detail.className = "approval-detail";
    this.notice.className = "approval-notice";
    this.notice.setAttribute("role", "status");
    this.actions.className = "approval-actions";
    this.deny.className = "secondary";
    this.actions.append(this.approve, this.deny);
    this.container.append(header, this.list, this.detail, this.notice, this.rereview, this.actions);
    this.approve.onclick = (event) => {
      if (event.isTrusted) void this.submit("approve");
    };
    this.deny.onclick = (event) => {
      if (event.isTrusted) void this.submit("deny");
    };
    this.container.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (this.reviewed) this.backToQueue();
      else this.close();
    });
  }

  get isOpen() {
    return this.openState;
  }

  open(allWorkspaces = false) {
    this.openState = true;
    this.allWorkspaces = allWorkspaces;
    this.container.hidden = false;
    this.visibility(true);
    this.backToQueue(false);
    this.heading.focus();
    clearInterval(this.tick);
    this.tick = setInterval(() => this.updateDecision(), 1000);
  }

  close() {
    clearInterval(this.tick);
    this.tick = undefined;
    this.openState = false;
    this.reviewed = undefined;
    this.container.hidden = true;
    this.visibility(false);
  }

  private backToQueue(restore = true) {
    this.reviewed = undefined;
    this.refreshView();
    this.container.scrollTop = this.queueScroll;
    if (restore) {
      const row = this.rows.get(this.lastRow ?? "");
      (row && !row.hidden ? row : this.heading).focus();
    }
  }

  private openItem(item: ApprovalItem) {
    this.queueScroll = this.container.scrollTop;
    this.lastRow = item.id;
    this.reviewed = structuredClone(item);
    this.renderDetail(item);
    this.refreshView();
    this.container.scrollTop = 0;
    this.heading.focus();
  }

  private renderDetail(item: ApprovalItem) {
    const fields = document.createElement("dl");
    const field = (name: string, value: string) => {
      const label = document.createElement("dt");
      label.textContent = name;
      const content = document.createElement("dd");
      content.textContent = value;
      fields.append(label, content);
    };
    field("專案", item.workspace_name);
    if ("source_file_id" in item) {
      field("來源", item.source_file_name ?? "ChatGPT 檔案");
      field("儲存為", item.path);
      field(
        "內容",
        `${item.mime_type} · ${item.width} × ${item.height} · ${(item.byte_size / 1024).toFixed(1)} KiB`,
      );
      field("範圍", "只建立新檔；不覆寫既有檔案");
      this.approve.textContent = "匯入圖片";
    } else if ("files" in item) {
      field("摘要", item.summary);
      field(
        "變更",
        item.files
          .map(
            (file) =>
              `${({ edit: "編輯", write: "寫入", delete: "刪除" } as const)[file.operation]} ${file.path}`,
          )
          .join("\n"),
      );
      field("範圍", "套用前再次核對檔案版本");
      this.approve.textContent = "套用這批";
    } else if ("argv" in item) {
      field("執行檔", item.executable);
      // JSON encoding keeps empty arguments, spaces and newlines distinguishable.
      field(
        "參數 argv",
        item.argv.map((value, index) => `[${index}] ${JSON.stringify(value)}`).join("\n"),
      );
      field("位置", item.absolute_cwd);
      field("範圍", "主機權限；可操作工作區外、可連網");
      field("期限", `只允許這次，最多 ${item.timeout_ms / 1000} 秒`);
      this.approve.textContent = "允許這次";
    } else {
      const terminal = item as ApprovalSession;
      field("Shell", terminal.shell);
      field(
        "執行參數",
        terminal.command.map((value, index) => `[${index}] ${JSON.stringify(value)}`).join("\n"),
      );
      field("位置", terminal.absolute_cwd);
      field("範圍", "整個 shell 具主機權限；可操作工作區外、可連網");
      field("期限", "15 分鐘");
      this.approve.textContent = "允許 15 分鐘";
    }
    field(
      "請求",
      `${item.id.slice(0, 8)} · ${new Date(item.expires_at).toLocaleTimeString()} 到期`,
    );
    this.detail.replaceChildren(fields);
    if ("files" in item) {
      const diff = document.createElement("pre");
      diff.className = "approval-diff-content";
      diff.tabIndex = 0;
      diff.setAttribute("aria-label", "檔案差異");
      diff.textContent = item.diff;
      this.detail.append(diff);
    }
  }

  private updateDecision() {
    if (!this.openState || !this.reviewed) return;
    const current = this.items.find((item) => item.id === this.reviewed?.id);
    const block = approvalDecisionBlock(
      this.reviewed,
      current,
      this.available,
      "approve",
      Date.now(),
      this.uncertain(this.reviewed),
    );
    const messages = {
      unavailable: "",
      unknown: "",
      gone: "請求已結束。",
      expired: "請求已到期。",
      changed: "內容已變更，請重新審閱。",
      incomplete: "差異不完整；請拒絕並要求拆批。",
    } as const;
    const message = block ? messages[block] : "";
    if (this.notice.textContent !== message) this.notice.textContent = message;
    this.notice.hidden = !message;
    this.rereview.hidden = block !== "changed";
    this.rereview.disabled = this.busy || !this.available;
    this.approve.disabled = this.busy || Boolean(block);
    this.deny.disabled =
      this.busy ||
      Boolean(
        approvalDecisionBlock(
          this.reviewed,
          current,
          this.available,
          "deny",
          Date.now(),
          this.uncertain(this.reviewed),
        ),
      );
    this.actions.setAttribute("aria-busy", String(this.busy));
  }

  private async submit(action: "approve" | "deny") {
    const reviewed = this.reviewed;
    const current = this.items.find((item) => item.id === reviewed?.id);
    if (
      this.busy ||
      !reviewed ||
      approvalDecisionBlock(
        reviewed,
        current,
        this.available,
        action,
        Date.now(),
        this.uncertain(reviewed),
      )
    )
      return;
    this.busy = true;
    this.updateDecision();
    try {
      await this.decide(reviewed, action);
    } catch (cause) {
      this.report(cause instanceof Error ? cause.message : "結果待確認；請查詢狀態。");
    } finally {
      this.busy = false;
      this.updateDecision();
    }
  }

  private refreshView() {
    const reviewing = Boolean(this.reviewed);
    this.list.hidden = reviewing;
    this.detail.hidden = !reviewing;
    this.actions.hidden = !reviewing;
    this.back.hidden = !reviewing;
    this.all.hidden = reviewing || this.workspaceId === null || this.allWorkspaces;
    const visible = approvalsInWorkspace(this.items, this.allWorkspaces ? null : this.workspaceId);
    this.heading.textContent = reviewing
      ? approvalTitle(this.reviewed as ApprovalItem)
      : `需確認 ${visible.length}`;
    if (!reviewing) {
      this.notice.textContent = visible.length ? "" : "沒有待確認請求。";
      this.notice.hidden = Boolean(visible.length);
      this.rereview.hidden = true;
    } else this.updateDecision();
    for (const [id, row] of this.rows) row.hidden = !visible.some((item) => item.id === id);
  }

  render(items: ApprovalItem[], available = true, workspaceId: string | null = null) {
    this.items = [...items]
      .filter((item) => item.state === "pending")
      .sort((a, b) => a.created_at - b.created_at);
    this.available = available;
    if (this.workspaceId !== workspaceId) {
      this.workspaceId = workspaceId;
      this.allWorkspaces = false;
      if (this.reviewed && this.reviewed.workspace_id !== workspaceId && workspaceId !== null)
        this.backToQueue();
    }
    for (const [id, row] of this.rows) {
      if (this.items.some((item) => item.id === id)) continue;
      const focused = row === document.activeElement;
      row.remove();
      this.rows.delete(id);
      if (focused && this.openState) this.heading.focus();
    }
    for (const item of this.items) {
      let row = this.rows.get(item.id);
      if (!row) {
        row = button("", () => {
          const current = this.items.find((entry) => entry.id === item.id);
          if (current) this.openItem(current);
        });
        row.className = "approval-row";
        this.rows.set(item.id, row);
        this.list.append(row);
      }
      const label = `${approvalTitle(item)}\n${item.workspace_name} · ${item.id.slice(0, 8)}`;
      if (row.textContent !== label) row.textContent = label;
    }
    if (this.reviewed && !this.items.some((item) => item.id === this.reviewed?.id))
      this.backToQueue(this.openState);
    this.refreshView();
  }
}
