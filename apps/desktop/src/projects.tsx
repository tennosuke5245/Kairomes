import {
  ClockCounterClockwise,
  Eject,
  Eye,
  FolderOpen,
  FolderPlus,
  FolderSimplePlus,
  Lightning,
  PencilSimple,
  PencilSimpleLine,
  type Icon as PhosphorIcon,
  Plus,
  Question,
  ShieldCheck,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Icon, WorkspaceAvatar, waitable } from "./components.tsx";
import { OverflowMenu } from "./menu.tsx";
import {
  capabilitySummary,
  type DesktopAttention,
  type WorkspaceSummary,
  workspaceAccess,
} from "./model.ts";

type Access = ReturnType<typeof workspaceAccess>;

const ACCESS: Record<Access, { label: string; icon: PhosphorIcon; tone?: "warning" }> = {
  step: { label: "逐步確認", icon: ShieldCheck },
  files: { label: "檔案自主", icon: PencilSimple, tone: "warning" },
  full: { label: "全自主", icon: Lightning, tone: "warning" },
  read: { label: "唯讀", icon: Eye },
  unknown: { label: "權限待確認", icon: Question },
};

export function AccessPill({ access }: { access: Access }) {
  const pill = ACCESS[access];
  return (
    <span className="k-pill" data-tone={pill.tone}>
      <Icon icon={pill.icon} size="sm" />
      {pill.label}
    </span>
  );
}

/**
 * One project: name, Desktop-only absolute root (ellipsized, full value in `title`), access
 * mode and what ChatGPT may do. The footer says only what needs saying: waiting requests, or
 * on 總覽 that ChatGPT cannot reach it. On 專案 the overflow menu sits beside the name.
 */
export function ProjectCard({
  workspace,
  root,
  access,
  pending,
  unavailable,
  menu,
}: {
  workspace: WorkspaceSummary;
  root: string | undefined;
  access: Access;
  pending: number;
  unavailable: boolean;
  menu?: ReactNode;
}) {
  return (
    <article className="k-card desk-project" aria-label={workspace.name}>
      <div className="desk-project__head">
        <WorkspaceAvatar id={workspace.id} name={workspace.name} large />
        <div className="desk-project__id">
          <h3 className="desk-project__name">{workspace.name}</h3>
          {root ? (
            <p className="desk-project__path" title={root}>
              <bdi dir="ltr">{root}</bdi>
            </p>
          ) : null}
        </div>
        {menu}
      </div>
      <div className="desk-project__pills">
        <AccessPill access={access} />
        <span className="desk-project__caps">{capabilitySummary(workspace.capabilities)}</span>
      </div>
      {pending > 0 ? (
        <p className="desk-project__foot desk-project__need">
          <span className="k-badge">{pending}</span>需確認
        </p>
      ) : unavailable ? (
        <p className="desk-project__foot k-meta">ChatGPT 目前無法使用</p>
      ) : null}
    </article>
  );
}

/** Dashed add slot that fills the row while there are fewer than three projects. */
export function AddProjectSlot({ waiting, onAdd }: { waiting: boolean; onAdd: () => void }) {
  return (
    <button
      className="k-card k-card--slot desk-project-slot"
      type="button"
      {...waitable(waiting, onAdd)}
    >
      <Icon icon={FolderPlus} size="xl" />
      加入專案資料夾
    </button>
  );
}

export type ProjectGridProps = {
  workspaces: WorkspaceSummary[];
  paths: ReadonlyMap<string, string>;
  attention: DesktopAttention;
  unavailable: boolean;
  /** Another action runs: 加入專案資料夾 waits, but keeps keyboard focus. */
  addWaiting: boolean;
  onAdd: () => void;
  menu?: (workspace: WorkspaceSummary) => ReactNode;
};

export function ProjectGrid({
  workspaces,
  paths,
  attention,
  unavailable,
  addWaiting,
  onAdd,
  menu,
}: ProjectGridProps) {
  const pending = new Map(
    attention.pendingByWorkspace.map((entry) => [entry.workspaceId, entry.count]),
  );
  return (
    <div className="desk-grid">
      {workspaces.map((workspace) => (
        <ProjectCard
          key={workspace.id}
          workspace={workspace}
          root={paths.get(workspace.id)}
          access={workspaceAccess(attention, workspace)}
          pending={pending.get(workspace.id) ?? 0}
          unavailable={unavailable}
          menu={menu?.(workspace)}
        />
      ))}
      {workspaces.length < 3 ? <AddProjectSlot waiting={addWaiting} onAdd={onAdd} /> : null}
    </div>
  );
}

/** Id of a project's menu button, where focus returns after a dialog or the handoff flow. */
export function projectMenuId(workspaceId: string) {
  return `project-menu-${workspaceId}`;
}

/**
 * 專案: the page title is the only heading. Each card has one overflow menu (重新命名…,
 * 在檔案總管中顯示, 從 Codex 接續, 解除掛載…); folders can also be dropped onto the page.
 */
export function ProjectsPage({
  grid,
  busy,
  canAdd,
  dropActive,
  handoffUnavailable,
  onAdd,
  onRename,
  onReveal,
  onHandoff,
  onRemove,
}: {
  grid: Omit<ProjectGridProps, "menu" | "addWaiting" | "onAdd">;
  busy: boolean;
  canAdd: boolean;
  /** Folders are being dragged over the window. */
  dropActive: boolean;
  /** Why 從 Codex 接續 cannot start for this project right now; null when it can. */
  handoffUnavailable: (workspace: WorkspaceSummary) => string | null;
  onAdd: () => void;
  onRename: (workspace: WorkspaceSummary, trigger: HTMLButtonElement) => void;
  onReveal: (workspace: WorkspaceSummary) => void;
  onHandoff: (workspace: WorkspaceSummary) => void;
  onRemove: (workspace: WorkspaceSummary, trigger: HTMLButtonElement) => void;
}) {
  const drop = dropActive ? (
    <div className="desk-drop" aria-hidden="true">
      <Icon icon={FolderSimplePlus} size="2xl" />
      放開以加入專案資料夾
    </div>
  ) : null;
  if (!canAdd)
    return (
      <div className="k-card desk-empty">
        <div className="k-empty">
          <span className="k-empty__icon">
            <Icon icon={FolderOpen} size="xl" />
          </span>
          <p className="k-empty__title">暫時讀不到專案</p>
          <p className="k-empty__text">本機服務回應後，這裡會列出你的專案。</p>
        </div>
      </div>
    );
  if (!grid.workspaces.length)
    return (
      <div className="desk-drop-zone">
        <div className="k-card desk-empty">
          <div className="k-empty">
            <span className="k-empty__icon">
              <Icon icon={FolderOpen} size="xl" />
            </span>
            <p className="k-empty__title">還沒有專案</p>
            <p className="k-empty__text">加入一個資料夾，ChatGPT 才能讀取。</p>
            <button className="k-btn k-btn--primary" type="button" {...waitable(busy, onAdd)}>
              <Icon icon={Plus} />
              新增專案
            </button>
          </div>
        </div>
        {drop}
      </div>
    );
  return (
    <div className="desk-drop-zone">
      <ProjectGrid
        {...grid}
        unavailable={false}
        addWaiting={busy}
        onAdd={onAdd}
        menu={(workspace) => {
          const handoff = handoffUnavailable(workspace);
          return (
            <OverflowMenu
              id={projectMenuId(workspace.id)}
              label={`${workspace.name} 的更多操作`}
              disabled={busy}
              items={[
                {
                  id: "rename",
                  label: "重新命名…",
                  icon: PencilSimpleLine,
                  onSelect: (trigger) => onRename(workspace, trigger),
                },
                {
                  id: "reveal",
                  label: "在檔案總管中顯示",
                  icon: FolderOpen,
                  onSelect: () => onReveal(workspace),
                },
                {
                  id: "handoff",
                  label: "從 Codex 接續",
                  icon: ClockCounterClockwise,
                  ...(handoff ? { disabledReason: handoff } : {}),
                  onSelect: () => onHandoff(workspace),
                },
                {
                  id: "remove",
                  label: "解除掛載…",
                  icon: Eject,
                  danger: true,
                  onSelect: (trigger) => onRemove(workspace, trigger),
                },
              ]}
            />
          );
        }}
      />
      <p className="k-hint desk-drop-hint">也可以把資料夾拖進這個視窗。</p>
      {drop}
    </div>
  );
}
