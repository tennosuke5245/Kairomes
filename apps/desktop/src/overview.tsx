import {
  ArrowSquareOut,
  ArrowUpRight,
  ChatCircleDots,
  Check,
  CircleNotch,
  Copy,
  Desktop,
  DownloadSimple,
  FolderPlus,
  Globe,
  Image,
  Key,
  Lightning,
  PencilSimple,
  type Icon as PhosphorIcon,
  Plug,
  Plus,
  Question,
  SidebarSimple,
  Terminal,
  TerminalWindow,
  Timer,
  Tray,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { ExternalTarget } from "./api.ts";
import { Icon, Pathway, Section, StatusTile, WorkspaceTag, waitable } from "./components.tsx";
import { focusControl, focusHeading, focusScope } from "./focus.ts";
import {
  APPROVAL_SOON_MS,
  countdownUrgency,
  formatChecked,
  formatCountdown,
  formatRelative,
  formatRemaining,
  formatUptime,
} from "./format.ts";
import {
  ACTION_LABELS,
  type AttentionGrant,
  type CompanionPendingKind,
  type DesktopAttention,
  type DesktopSnapshot,
  type DesktopView,
  type PathwayStates,
  PROFILE_NAME,
  pathwayStates,
  type SetupStep,
  type SetupStepId,
  type ViewAction,
} from "./model.ts";
import { ProjectGrid, type ProjectGridProps } from "./projects.tsx";

/* ---------- Status line ---------- */

const ACTION_ICONS: Partial<Record<ViewAction, PhosphorIcon>> = {
  configure_key: Key,
  open_tunnel_releases: DownloadSimple,
};

export function ActionButton({
  action,
  busyAction,
  onAction,
}: {
  action: Exclude<ViewAction, "none">;
  /** The action in flight, if any: every action waits, only this one spins. */
  busyAction: string | null;
  onAction: (action: ViewAction, trigger: HTMLButtonElement) => void;
}) {
  const lead = ACTION_ICONS[action];
  const running = busyAction === action;
  // Every action waits while one runs, but the pressed button keeps keyboard focus.
  return (
    <button
      className="k-btn k-btn--primary"
      type="button"
      aria-busy={running}
      {...focusControl}
      {...waitable(busyAction !== null, (event) => onAction(action, event.currentTarget))}
    >
      {running ? <Icon icon={CircleNotch} spin /> : lead ? <Icon icon={lead} /> : null}
      {ACTION_LABELS[action]}
      {action === "open_workbench" || action === "open_connectors" ? (
        <Icon icon={ArrowUpRight} />
      ) : null}
    </button>
  );
}

/**
 * One status sentence, one fact and one action. Error lines and 疑難排解 lead with the pathway
 * (`pathway`); every other line leads with its state tile.
 */
export function StatusLine({
  view,
  meta,
  pathway = null,
  progress = true,
  busyAction,
  onAction,
}: {
  view: DesktopView;
  meta: string;
  pathway?: PathwayStates | null;
  /** The setup progress bar; only 總覽, where the checklist is, shows it. */
  progress?: boolean;
  busyAction: string | null;
  onAction: (action: ViewAction, trigger: HTMLButtonElement) => void;
}) {
  const setup = progress ? view.setup : null;
  const tinted = view.tone === "danger" || view.tone === "brand";
  // When the action is done and its button goes, focus lands on the new status sentence.
  return (
    <div
      className={
        pathway
          ? "k-statusline desk-statusline desk-statusline--path"
          : "k-statusline desk-statusline"
      }
      data-tone={tinted ? view.tone : undefined}
      {...focusScope}
    >
      {pathway ? <Pathway states={pathway} /> : <StatusTile icon={view.icon} tone={view.tone} />}
      <div className="k-statusline__text">
        <p className="k-statusline__title" {...focusHeading}>
          {view.title}
        </p>
        {meta ? <p className="k-statusline__meta">{meta}</p> : null}
      </div>
      {setup ? (
        <div className="desk-progress">
          <span className="k-num">
            {setup.done}／{setup.steps.length}
          </span>
          <div
            className="k-progress"
            role="progressbar"
            aria-label="設定進度"
            aria-valuemin={0}
            aria-valuemax={setup.steps.length}
            aria-valuenow={setup.done}
            aria-valuetext={`已完成 ${setup.done} 步，共 ${setup.steps.length} 步`}
          >
            <span style={{ width: `${(setup.done / setup.steps.length) * 100}%` }} />
          </div>
        </div>
      ) : view.action !== "none" ? (
        <ActionButton action={view.action} busyAction={busyAction} onAction={onAction} />
      ) : null}
    </div>
  );
}

/** Ready meta: uptime of the secure tunnel and when Desktop last heard from the service. */
export function readyMeta(startedAt: string | null, checkedAt: number | null, now: number) {
  return [formatUptime(startedAt, now), formatChecked(checkedAt, now)].filter(Boolean).join(" · ");
}

/**
 * What a page's status line shows, or null when it shows none. 總覽 always has one and only
 * error lines lead with the pathway. 疑難排解 always leads with the pathway, and says nothing
 * while everything works, because the sidebar chip is the only place that is stated.
 */
export function statusLineContent(
  page: "overview" | "diagnostics",
  view: DesktopView,
  snapshot: DesktopSnapshot,
  checkedAt: number | null,
  now: number,
): { meta: string; pathway: PathwayStates | null; progress: boolean } | null {
  if (page === "diagnostics" && view.state === "ready") return null;
  const setup = view.setup;
  const meta =
    view.state === "ready"
      ? readyMeta(snapshot.companion?.tunnel.startedAt ?? null, checkedAt, now)
      : page === "diagnostics" && setup
        ? `已完成 ${setup.done}／${setup.steps.length} 步，其餘步驟在總覽。`
        : view.meta;
  const pathway =
    page === "diagnostics" || view.failingHop ? pathwayStates(snapshot, view.failingHop) : null;
  return { meta, pathway, progress: page === "overview" };
}

/* ---------- 需注意 ---------- */

const KIND_TEXT: Record<CompanionPendingKind, { icon: PhosphorIcon; unit: string }> = {
  command: { icon: Terminal, unit: "個命令" },
  terminal: { icon: TerminalWindow, unit: "個終端機" },
  file_change: { icon: PencilSimple, unit: "個檔案變更" },
  import: { icon: Image, unit: "個圖片匯入" },
};
const MAX_ROWS = 3;

function AttentionCard({
  id,
  tone,
  icon,
  label,
  value,
  children,
  foot,
  footIcon,
}: {
  id: string;
  tone?: "brand" | "warning";
  icon: PhosphorIcon;
  label: string;
  value: ReactNode;
  children?: ReactNode;
  foot: string;
  footIcon?: PhosphorIcon;
}) {
  return (
    <article
      className="k-card desk-attn"
      data-tone={tone}
      data-size={children ? undefined : "compact"}
      aria-labelledby={id}
    >
      <h3 className="desk-attn__label" id={id}>
        <span className="k-kind desk-attn__kind" data-tone={tone}>
          <Icon icon={icon} />
        </span>
        {label}
      </h3>
      <div className="desk-attn__value" data-tone={tone}>
        {value}
      </div>
      {children}
      <p className="desk-attn__foot k-meta">
        {footIcon ? <Icon icon={footIcon} size="sm" /> : null}
        {foot}
      </p>
    </article>
  );
}

function PendingCard({ attention }: { attention: DesktopAttention }) {
  const total = attention.pending ?? 0;
  const remaining = attention.pendingRemainingMs;
  const groups = attention.pendingGroups;
  const hidden = groups.slice(MAX_ROWS).reduce((sum, group) => sum + group.count, 0);
  return (
    <AttentionCard
      id="attn-pending"
      tone="brand"
      icon={Tray}
      label="需確認"
      value={
        <>
          <span>{total} 件</span>
          {remaining !== null ? (
            <span
              className="k-countdown"
              data-urgency={countdownUrgency(remaining, APPROVAL_SOON_MS)}
            >
              <Icon icon={Timer} size="sm" />
              {remaining > 0 ? `最快 ${formatCountdown(remaining)}` : "已到期"}
            </span>
          ) : null}
        </>
      }
      foot="請在瀏覽器側欄審核"
      footIcon={SidebarSimple}
    >
      <ul className="desk-attn__list">
        {groups.slice(0, MAX_ROWS).map((group) => {
          const kind = group.kind ? KIND_TEXT[group.kind] : null;
          return (
            <li key={`${group.kind ?? "any"}:${group.workspaceId}`}>
              <Icon icon={kind?.icon ?? Tray} size="sm" />
              <span>
                {group.count} {kind?.unit ?? "件"}
              </span>
              <WorkspaceTag id={group.workspaceId} name={group.workspaceName} />
            </li>
          );
        })}
        {hidden ? <li className="k-meta">另有 {hidden} 件</li> : null}
      </ul>
    </AttentionCard>
  );
}

const LEVEL_LABEL = { full: "全自主", files: "檔案自主" } as const;

function GrantCard({ grants }: { grants: AttentionGrant[] }) {
  const [grant, ...others] = grants;
  if (!grant) return null;
  return (
    <AttentionCard
      id="attn-grant"
      tone="warning"
      icon={grant.level === "full" ? Lightning : PencilSimple}
      label={`${LEVEL_LABEL[grant.level]} · ${grant.workspaceName ?? "已移除的專案"}`}
      value={formatRemaining(grant.remainingMs)}
      foot="要提早收回，請到瀏覽器側欄"
      footIcon={SidebarSimple}
    >
      {grant.level === "full" ? (
        <ul className="desk-attn__facts" aria-label="風險">
          <li>
            <Icon icon={Desktop} size="sm" />
            主機權限
          </li>
          <li>
            <Icon icon={ArrowSquareOut} size="sm" />
            可操作工作區外
          </li>
          <li>
            <Icon icon={Globe} size="sm" />
            可連網
          </li>
        </ul>
      ) : (
        <p className="desk-attn__text">工作區內的檔案變更直接套用；命令仍要核准。</p>
      )}
      {grant.expiresAt || others.length ? (
        <p className="desk-attn__text">
          {grant.expiresAt ? "到期後改回逐步確認。" : ""}
          {others.length ? `另有 ${others.length} 個專案也開啟自主。` : ""}
        </p>
      ) : null}
    </AttentionCard>
  );
}

function UnknownGrantCard() {
  return (
    <AttentionCard
      id="attn-grant"
      icon={Question}
      label="自主權限"
      value="權限待確認"
      foot="請在瀏覽器側欄查看操作模式"
      footIcon={SidebarSimple}
    >
      <p className="desk-attn__text">這個工作台的授權無法從 Desktop 讀取。</p>
    </AttentionCard>
  );
}

function RecentCallCard({ at, now }: { at: string; now: number }) {
  return (
    <AttentionCard
      id="attn-recent"
      icon={ChatCircleDots}
      label="最近 ChatGPT 呼叫"
      value={formatRelative(at, now) ?? ""}
      foot="內容請在瀏覽器側欄的動態查看"
      footIcon={SidebarSimple}
    />
  );
}

/** 需注意: counts and grant metadata only, never argv, cwd, diffs or approve buttons. */
export function AttentionSection({
  attention,
  grantsReadable,
  now,
}: {
  attention: DesktopAttention;
  /** False while the workbench cannot be asked at all; then nothing is claimed about grants. */
  grantsReadable: boolean;
  now: number;
}) {
  const cards: ReactNode[] = [];
  if (attention.pending) cards.push(<PendingCard key="pending" attention={attention} />);
  if (attention.grants === null && grantsReadable) cards.push(<UnknownGrantCard key="grant" />);
  else if (attention.grants?.length)
    cards.push(<GrantCard key="grant" grants={attention.grants} />);
  if (attention.lastMcpRequestAt)
    cards.push(<RecentCallCard key="recent" at={attention.lastMcpRequestAt} now={now} />);
  if (!cards.length) return null;
  return (
    <Section id="attention-title" title="需注意">
      <div className="desk-grid">{cards}</div>
    </Section>
  );
}

/* ---------- First-run checklist ---------- */

export type SetupHandlers = {
  busy: boolean;
  mcpCommand: string;
  mcpCommandError: string;
  profileMissing: boolean;
  onAddProject: () => void;
  onOpenExternal: (target: ExternalTarget) => void;
  onCopyCommand: () => void;
  onAcknowledgeProfile: () => void;
  onRestartTunnel: () => void;
  onConfigureKey: (trigger: HTMLButtonElement) => void;
  onPair: () => void;
  onOpenConnectors: () => void;
};

function Primary({
  icon,
  label,
  busy,
  onClick,
}: {
  icon?: PhosphorIcon;
  label: string;
  busy: boolean;
  onClick: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <button
      className="k-btn k-btn--primary"
      type="button"
      {...waitable(busy, (event) => onClick(event.currentTarget))}
    >
      {icon ? <Icon icon={icon} /> : null}
      {label}
    </button>
  );
}

function HelpLink({
  label,
  target,
  onOpen,
}: {
  label: string;
  target: ExternalTarget;
  onOpen: (target: ExternalTarget) => void;
}) {
  return (
    <button className="k-btn k-btn--quiet" type="button" onClick={() => onOpen(target)}>
      {label}
      <Icon icon={ArrowSquareOut} size="sm" />
    </button>
  );
}

function stepBody(
  id: SetupStepId,
  h: SetupHandlers,
): { text: ReactNode; extra?: ReactNode; actions: ReactNode } {
  switch (id) {
    case "workspace":
      return {
        text: "選擇本機資料夾；檔案留在原處，不會被搬移或上傳。",
        actions: (
          <Primary
            icon={FolderPlus}
            label="加入專案資料夾"
            busy={h.busy}
            onClick={h.onAddProject}
          />
        ),
      };
    case "tunnel_client":
      return {
        text: "安全通道由 OpenAI 官方的 tunnel-client 建立。下載後放進 PATH，Kairomes 會自動找到它。",
        actions: (
          <>
            <Primary
              icon={DownloadSimple}
              label="下載 tunnel-client"
              busy={h.busy}
              onClick={() => h.onOpenExternal("tunnel_releases")}
            />
            <HelpLink label="安裝說明" target="tunnel_guide" onOpen={h.onOpenExternal} />
          </>
        ),
      };
    case "profile":
      return {
        text: h.profileMissing ? (
          <>
            安全通道找不到名為 {PROFILE_NAME} 的 profile。用 tunnel-client 建立它並把這行填入{" "}
            <code className="desk-flag">--mcp-command</code>，再重新啟動安全通道。
          </>
        ) : (
          <>
            用 tunnel-client 建立名為 {PROFILE_NAME} 的 profile，並把這行填入{" "}
            <code className="desk-flag">--mcp-command</code>。只需設定一次。
          </>
        ),
        extra: (
          <div className="desk-command">
            <p className="k-label" id="mcp-command-label">
              本機 MCP 指令
            </p>
            <div className="desk-command__row">
              <code className="k-codebox desk-command__value">
                {h.mcpCommand || "正在取得安裝位置…"}
              </code>
              <button
                className="k-btn k-btn--secondary k-btn--sm"
                type="button"
                disabled={!h.mcpCommand}
                onClick={h.onCopyCommand}
              >
                <Icon icon={Copy} size="sm" />
                複製指令
              </button>
            </div>
            {h.mcpCommandError ? (
              <p className="k-error" role="alert">
                {h.mcpCommandError}
              </p>
            ) : (
              <p className="k-hint">指令不含金鑰或配對資訊；日常由 Desktop 管理安全通道。</p>
            )}
          </div>
        ),
        actions: (
          <>
            {h.profileMissing ? (
              <Primary label="重新啟動安全通道" busy={h.busy} onClick={h.onRestartTunnel} />
            ) : (
              <Primary
                icon={Check}
                label="我已建立 profile"
                busy={h.busy}
                onClick={h.onAcknowledgeProfile}
              />
            )}
            <HelpLink label="建立說明" target="tunnel_guide" onOpen={h.onOpenExternal} />
          </>
        ),
      };
    case "key":
      return {
        text: "安全通道用這把金鑰向 ChatGPT 證明身分。金鑰交給 Windows 認證管理員保管，之後不會再顯示。",
        actions: (
          <>
            <Primary icon={Key} label="設定金鑰" busy={h.busy} onClick={h.onConfigureKey} />
            <HelpLink label="金鑰從哪裡取得？" target="runtime_keys" onOpen={h.onOpenExternal} />
          </>
        ),
      };
    case "panel":
      return {
        text: "在 Chrome 或 Edge 安裝 Kairomes 擴充功能，到連線設定貼上它的 Extension ID，再把配對連結貼到側欄。",
        actions: <Primary icon={Plug} label="前往配對" busy={false} onClick={h.onPair} />,
      };
    case "verify":
      return {
        text: "在 ChatGPT 的連接器設定重新整理 Kairomes，再請 ChatGPT 列出你的專案；收到呼叫後這一步會自動打勾。",
        actions: <Primary label="開啟 ChatGPT 設定" busy={h.busy} onClick={h.onOpenConnectors} />,
      };
  }
}

function Step({
  step,
  index,
  handlers,
}: {
  step: SetupStep;
  index: number;
  handlers: SetupHandlers;
}) {
  const titleId = `setup-step-${step.id}`;
  const mark = (
    <span className="k-step__mark" aria-hidden="true">
      {step.state === "done" ? <Icon icon={Check} size="sm" /> : index + 1}
    </span>
  );
  const status =
    step.state === "done" ? "已完成" : step.state === "current" ? "目前步驟" : "尚未開始";
  if (step.state !== "current")
    return (
      <li className="k-step" data-state={step.state} aria-labelledby={titleId}>
        {mark}
        <span className="k-step__title" id={titleId}>
          {step.title}
          <span className="k-sr-only">，{status}</span>
        </span>
        <span className="k-step__meta">{step.meta}</span>
      </li>
    );
  const body = stepBody(step.id, handlers);
  return (
    <li className="k-step" data-state="current" aria-current="step" aria-labelledby={titleId}>
      {mark}
      <div className="desk-step__body">
        {/* When a step is done, focus moves to the next step's title (useFocusRescue). */}
        <h3 className="k-step__title" id={titleId} {...focusHeading}>
          {step.title}
          <span className="k-sr-only">，{status}</span>
        </h3>
        <p className="k-step__desc">{body.text}</p>
        {body.extra}
        <div className="k-step__actions">{body.actions}</div>
      </div>
      <span />
    </li>
  );
}

export function SetupChecklist({
  steps,
  handlers,
}: {
  steps: SetupStep[];
  handlers: SetupHandlers;
}) {
  return (
    <ol className="k-card k-steps desk-steps" aria-label="設定步驟" {...focusScope}>
      {steps.map((step, index) => (
        <Step key={step.id} step={step} index={index} handlers={handlers} />
      ))}
    </ol>
  );
}

/* ---------- Page ---------- */

export function OverviewPage({
  view,
  statusLine,
  attention,
  grantsReadable,
  now,
  setupHandlers,
  projects,
}: {
  view: DesktopView;
  statusLine: ReactNode;
  attention: DesktopAttention;
  grantsReadable: boolean;
  now: number;
  setupHandlers: SetupHandlers;
  projects: ProjectGridProps | null;
}) {
  return (
    <>
      {statusLine}
      {view.setup ? (
        <SetupChecklist steps={view.setup.steps} handlers={setupHandlers} />
      ) : (
        <>
          <AttentionSection attention={attention} grantsReadable={grantsReadable} now={now} />
          {projects ? (
            <Section
              id="overview-projects-title"
              title="專案"
              trailing={
                <button
                  className="k-btn k-btn--secondary k-btn--sm"
                  type="button"
                  {...waitable(projects.addWaiting, projects.onAdd)}
                >
                  <Icon icon={Plus} size="sm" />
                  新增專案
                </button>
              }
            >
              <ProjectGrid {...projects} />
            </Section>
          ) : null}
        </>
      )}
    </>
  );
}

/** First paint before any status: neutral shapes only, never a setup prompt (X14). */
export function OverviewSkeleton() {
  return (
    <div className="desk-skeleton">
      <p className="k-sr-only">正在讀取 Kairomes 狀態…</p>
      <div className="k-statusline desk-statusline" aria-hidden="true">
        <span className="k-kind" />
        <div className="k-statusline__text">
          <span className="k-skeleton desk-skeleton__title" />
          <span className="k-skeleton desk-skeleton__meta" />
        </div>
      </div>
      <div className="desk-grid" aria-hidden="true">
        <div className="k-card desk-skeleton__card" />
        <div className="k-card desk-skeleton__card" />
        <div className="k-card desk-skeleton__card" />
      </div>
    </div>
  );
}
