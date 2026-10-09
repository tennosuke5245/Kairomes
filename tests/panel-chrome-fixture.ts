import { AccessPanel } from "../apps/extension/src/access-panel.ts";
import { setIcon } from "../apps/extension/src/icons.ts";
import { connectionView } from "../apps/extension/src/toolbar-state.ts";
import { workspaceLabel } from "../apps/extension/src/workspace-selection.ts";
import type { AccessGrant, PanelSnapshot } from "../packages/protocol/src/activity.ts";

// Visual fixture only: puts the side panel toolbar into a paired-looking state with the
// product's own helpers. No credentials, bridge, stream or host capability are involved.
type Workspace = { id: string; name: string };

export function markConnected() {
  const status = document.querySelector<HTMLElement>("#connection-status");
  const view = connectionView("connected");
  status?.setAttribute("aria-label", `Kairomes：${view.label}（合成測試）`);
  if (status) status.title = view.label;
  status?.querySelector<HTMLElement>(".k-dot")?.setAttribute("data-tone", view.tone);
  const approvalCount = document.querySelector<HTMLElement>("#approval-count");
  if (approvalCount) approvalCount.hidden = false;
}

/** `?grant=N` starts with a synthetic 全自主 grant on the first project, expiring in N minutes. */
export function syntheticGrants(workspaces: Workspace[], query: URLSearchParams): AccessGrant[] {
  const minutes = Number(query.get("grant") ?? 0);
  const first = workspaces[0];
  if (!(minutes > 0) || !first) return [];
  return [
    {
      id: "fake-grant-initial",
      workspace_id: first.id,
      workspace_name: first.name,
      level: query.get("level") === "files" ? "files" : "full",
      expires_at: query.get("level") === "files" ? null : Date.now() + minutes * 60_000,
    },
  ];
}

export function syntheticAccess(snapshot: PanelSnapshot, selected: string | null) {
  const trigger = document.querySelector<HTMLButtonElement>("#access");
  const popover = document.querySelector<HTMLElement>("#access-popover");
  if (!trigger || !popover) return undefined;
  trigger.hidden = false;
  const workspaces = snapshot.workspaces ?? [];
  const access = new AccessPanel(
    trigger,
    popover,
    async (body: unknown) => {
      const input = body as {
        action: string;
        level?: "files" | "full";
        minutes?: number | null;
        workspace_id?: string;
      };
      const target = workspaces.find((workspace) => workspace.id === input.workspace_id);
      if (!target) throw new Error("合成授權專案不存在。");
      snapshot.accessGrants = [
        ...(snapshot.accessGrants ?? []).filter((grant) => grant.workspace_id !== target.id),
        ...(input.action === "enable"
          ? [
              {
                id: `fake-grant-${target.id}`,
                workspace_id: target.id,
                workspace_name: target.name,
                level: input.level ?? "full",
                expires_at:
                  input.minutes === null ? null : Date.now() + (input.minutes ?? 15) * 60000,
              },
            ]
          : []),
      ];
      access.render(snapshot);
    },
    () => {},
  );
  access.render(snapshot);
  access.selectWorkspace(selected);
  setInterval(() => access.tick(), 1000);
  return access;
}

export function syntheticSwitcher(
  workspaces: Workspace[],
  selected: string | null,
  onChange: (id: string | null) => void,
) {
  const switcher = document.querySelector<HTMLElement>("#workspace-switcher");
  const select = document.querySelector<HTMLSelectElement>("#workspace-filter");
  if (!switcher || !select) return;
  switcher.hidden = false;
  const brand = document.querySelector<HTMLElement>("#brand");
  if (brand) brand.hidden = true;
  for (const workspace of workspaces) {
    const option = document.createElement("option");
    option.value = workspace.id;
    option.textContent = workspace.name;
    select.append(option);
  }
  const sync = () => {
    const view = workspaceLabel(select.value || null, workspaces);
    select.title = view.label;
    const glyph = switcher.querySelector<SVGSVGElement>(".sp-switcher__icon");
    if (glyph) setIcon(glyph, view.icon);
  };
  select.value = selected ?? "";
  sync();
  select.onchange = () => {
    sync();
    onChange(select.value || null);
  };
}
