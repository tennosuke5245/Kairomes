import {
  type ApprovalSession,
  type ArtifactImportApproval,
  artifactImportLabels,
  type CommandApproval,
  commandLabels,
  type FileChangeApproval,
  fileChangeLabels,
  terminalLabels,
} from "@kairomes/protocol";

type ApprovalItem = ApprovalSession | CommandApproval | FileChangeApproval | ArtifactImportApproval;
const isArtifactImport = (item: ApprovalItem): item is ArtifactImportApproval =>
  "source_file_id" in item;
const isFileChange = (item: ApprovalItem): item is FileChangeApproval => "files" in item;
const isCommand = (item: ApprovalItem): item is CommandApproval => "argv" in item;

export class ApprovalPanel {
  private cards = new Map<
    string,
    {
      root: HTMLElement;
      title: HTMLElement;
      details: HTMLElement;
      review: HTMLDetailsElement;
      diff: HTMLElement;
      actions: HTMLElement;
      key: string;
    }
  >();
  private busy = new Set<string>();
  constructor(
    private readonly container: HTMLElement,
    private readonly decide: (
      session: ApprovalItem,
      action: "approve" | "deny" | "stop",
    ) => Promise<void>,
    private readonly report: (message: string) => void,
  ) {}

  render(sessions: ApprovalItem[], available = true) {
    const active = sessions.filter((session) =>
      ["pending", "applying", "starting", "running"].includes(session.state),
    );
    this.container.hidden = active.length === 0;
    for (const [id, card] of this.cards)
      if (!active.some((session) => session.id === id)) {
        card.root.remove();
        this.cards.delete(id);
      }
    for (const session of active.sort(
      (a, b) =>
        Number(b.state === "pending") - Number(a.state === "pending") ||
        b.created_at - a.created_at,
    )) {
      let card = this.cards.get(session.id);
      if (!card) {
        const root = document.createElement("article");
        const title = document.createElement("strong");
        const details = document.createElement("p");
        const review = document.createElement("details");
        review.className = "approval-diff";
        const summary = document.createElement("summary");
        summary.textContent = "查看技術差異";
        const diff = document.createElement("pre");
        review.append(summary, diff);
        const actions = document.createElement("div");
        actions.className = "approval-actions";
        // Keep the decision controls immediately visible in a narrow sidebar;
        // the complete diff remains directly below and scrolls independently.
        root.append(title, details, actions, review);
        card = { root, title, details, review, diff, actions, key: "" };
        this.cards.set(session.id, card);
        this.container.append(root);
      }
      const key = `${session.state}:${session.fingerprint}:${session.expires_at}:${available}:${this.busy.has(session.id)}`;
      if (key === card.key) continue;
      card.key = key;
      card.root.className = session.state === "pending" ? "approval-card pending" : "approval-card";
      const artifactImport = isArtifactImport(session) ? session : undefined;
      const change = !artifactImport && isFileChange(session) ? session : undefined;
      const command = !artifactImport && !change && isCommand(session) ? session : undefined;
      const terminal =
        !artifactImport && !change && !command ? (session as ApprovalSession) : undefined;
      card.title.textContent = artifactImport
        ? `${artifactImport.workspace_name} · 圖片匯入 · ${artifactImportLabels[artifactImport.state]}`
        : change
          ? `${change.workspace_name} · 檔案變更 · ${fileChangeLabels[change.state]}`
          : command
            ? `${command.workspace_name} · 一次性命令 · ${commandLabels[command.state]}`
            : `${terminal?.workspace_name} · ${terminal?.shell} · ${terminal ? terminalLabels[terminal.state] : ""}`;
      card.details.textContent =
        session.state === "pending"
          ? artifactImport
            ? `來源：${artifactImport.source_file_name ?? "ChatGPT 檔案"}\n儲存為：${artifactImport.path}\n實際格式：${artifactImport.mime_type} · ${artifactImport.width.toLocaleString()} × ${artifactImport.height.toLocaleString()} · ${(artifactImport.byte_size / 1024).toFixed(1)} KiB\nKairomes 已驗證圖片內容；核准只會建立這個新檔，若路徑已存在就停止，不會覆寫。即使開啟完整存取，媒體匯入仍需逐筆核准。請求 ${artifactImport.id.slice(0, 8)} · ${new Date(artifactImport.expires_at).toLocaleTimeString()} 到期。`
            : change
              ? `摘要：${change.summary}\n檔案：${change.files.map((file) => `${file.operation} ${file.path}`).join("、")}\n這批變更會先再次檢查檔案版本，再以同一批次套用。請求 ${change.id.slice(0, 8)} · ${new Date(change.expires_at).toLocaleTimeString()} 到期。`
              : command
                ? `參數：${JSON.stringify(command.argv)}\n執行檔：${command.executable}\n起始位置：${command.absolute_cwd}\n最多執行 ${command.timeout_ms / 1000} 秒。只核准這次命令；仍可讀寫主機檔案及連網，起始位置不是沙箱。請求 ${command.id.slice(0, 8)} · ${new Date(command.expires_at).toLocaleTimeString()} 到期。`
                : `起始位置：${terminal?.absolute_cwd}\n核准會允許此主機 shell 15 分鐘，可讀寫檔案、存取工作區外資料與連網。請求 ${terminal?.id.slice(0, 8)} · ${terminal ? new Date(terminal.expires_at).toLocaleTimeString() : ""} 到期。`
          : artifactImport
            ? `${artifactImport.path} · ${artifactImport.message ?? artifactImportLabels[artifactImport.state]}`
            : change
              ? `${change.files.length} 個檔案 · ${change.message ?? fileChangeLabels[change.state]}`
              : `授權至 ${new Date(session.expires_at).toLocaleTimeString()} · ${command?.absolute_cwd ?? terminal?.absolute_cwd}`;
      card.review.hidden = !change;
      if (change)
        card.diff.textContent = `${change.diff}${change.diff_truncated ? "\n\n…差異過長，已截斷；核准仍會套用卡片所列的完整變更。" : ""}`;
      const actions: Array<["approve" | "deny" | "stop", string]> =
        session.state === "pending"
          ? [
              [
                "approve",
                artifactImport
                  ? "匯入這張圖片"
                  : change
                    ? "套用這批變更"
                    : command
                      ? "允許這次命令"
                      : "允許此工作階段 15 分鐘",
              ],
              ["deny", "拒絕"],
            ]
          : (artifactImport && artifactImport.state === "applying") ||
              (change && change.state === "applying")
            ? []
            : [["stop", command ? "取消命令" : "停止此工作階段"]];
      const existing = [...card.actions.querySelectorAll("button")];
      if (
        existing.map((button) => button.dataset.action).join() !==
        actions.map(([action]) => action).join()
      ) {
        card.actions.replaceChildren();
        for (const [action, label] of actions) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = label;
          button.dataset.action = action;
          if (action !== "approve") button.className = "secondary";
          button.onclick = async (event) => {
            if (!event.isTrusted || this.busy.has(session.id)) return;
            this.busy.add(session.id);
            for (const sibling of card.actions.querySelectorAll("button")) sibling.disabled = true;
            try {
              await this.decide(session, action);
            } catch (cause) {
              this.report(
                cause instanceof Error ? cause.message : "核准結果尚未確認，請等待狀態更新。",
              );
            } finally {
              this.busy.delete(session.id);
              card.key = "";
            }
          };
          card.actions.append(button);
        }
      }
      for (const button of card.actions.querySelectorAll("button"))
        button.disabled = !available || this.busy.has(session.id);
    }
    // Pending requests precede running work; unchanged cards keep their DOM and focus.
    active.forEach((session, index) => {
      const root = this.cards.get(session.id)?.root;
      if (root && this.container.children[index] !== root)
        this.container.insertBefore(root, this.container.children[index] ?? null);
    });
  }
}
