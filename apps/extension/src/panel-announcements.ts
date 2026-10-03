/** Keep independent live regions from replacing one another during the same snapshot. */
export class PanelAnnouncements {
  private connectionLabel = "";
  private pendingIds = new Set<string>();

  constructor(
    private readonly announceConnection: (message: string) => void,
    private readonly announceApprovals: (message: string) => void,
  ) {}

  connection(label: string) {
    if (label === this.connectionLabel) return;
    this.connectionLabel = label;
    this.announceConnection(label);
  }

  approvals(ids: readonly string[]) {
    const next = new Set(ids);
    const changed =
      next.size !== this.pendingIds.size || [...next].some((id) => !this.pendingIds.has(id));
    this.pendingIds = next;
    if (changed) this.announceApprovals(next.size ? `需確認 ${next.size} 件` : "待確認清單已清空");
  }
}
