import {
  ArrowCounterClockwise,
  ArrowLeft,
  CaretRight,
  ChatCircleText,
  Check,
  CheckCircle,
  CircleNotch,
  ClockCounterClockwise,
  Copy,
  PencilSimple,
  PencilSimpleLine,
  WarningCircle,
} from "@phosphor-icons/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type {
  HandoffBaseline,
  HandoffFields,
  HandoffPreview,
} from "../../../packages/protocol/src/handoff.ts";
import type { AgentSession, HandoffSnapshot } from "../../daemon/src/agent-sessions.ts";
import { handoffRequest } from "./api.ts";
import { Icon, NoticeSlot, StatePill, waitable } from "./components.tsx";
import { copyHandoffContent, handoffError } from "./handoff-copy.ts";
import {
  baselineSummary,
  briefReady,
  canCopyHandoff,
  coverageSummary,
  emptySourcesText,
  HANDOFF_COPIED_TEXT,
  type HandoffStage,
  type HandoffStep,
  handoffCopyBlocker,
  handoffStepHeading,
  handoffSteps,
  handoffTitle,
  relatedPaths,
  relatedPathsError,
  sessionUpdated,
  sourceStatusPill,
} from "./handoff-model.ts";
import { HandoffRequestGuard } from "./handoff-session.ts";
import type { WorkspaceSummary } from "./model.ts";
import { type Notice, nextNotice } from "./notice.ts";

type StartResult = { draft_id: string; sessions: AgentSession[]; nextCursor: string | null };
type SourceSnapshot = Omit<HandoffSnapshot, "workspace">;
/** Which request is in flight, so only its own control shows the spinner. */
type BusyOp = "codex" | "manual" | "list" | "check" | "copy" | "reselect" | `session:${string}`;

const emptyFields: HandoffFields = {
  goal: "",
  next_action: "",
  completed: "",
  decisions: "",
  unknowns: "",
};
const OPTIONAL_FIELDS = [
  ["completed", "完成事項"],
  ["decisions", "決策"],
  ["unknowns", "待驗證"],
] as const;

/** 選擇來源 → 整理內容 → 預覽並複製; done marks hold a Phosphor check, never a text glyph. */
export function HandoffStepper({ steps }: { steps: readonly HandoffStep[] }) {
  return (
    <ol className="k-stepper handoff-stepper" aria-label="接續步驟">
      {steps.flatMap((step, index) => {
        const item = (
          <li
            key={step.label}
            className="k-stepper__item"
            data-state={step.state === "done" ? "done" : undefined}
            aria-current={step.state === "current" ? "step" : undefined}
          >
            <span className="k-stepper__mark" aria-hidden="true">
              {step.state === "done" ? <Icon icon={Check} size="sm" /> : index + 1}
            </span>
            {step.label}
            {step.state === "done" ? <span className="k-sr-only">（已完成）</span> : null}
          </li>
        );
        return index
          ? [<li key={`${step.label}-sep`} className="k-stepper__sep" aria-hidden="true" />, item]
          : [item];
      })}
    </ol>
  );
}

/** One row per Codex session of this project: title, relative time and the source state. */
export function SessionList({
  sessions,
  hasNextPage,
  busy,
  now,
  onSelect,
}: {
  sessions: readonly AgentSession[];
  hasNextPage: boolean;
  busy: BusyOp | null;
  now: number;
  onSelect: (session: AgentSession) => void;
}) {
  if (!sessions.length)
    return (
      <p className="handoff-sessions__empty" role="status">
        {emptySourcesText(hasNextPage)}
      </p>
    );
  return (
    <ul className="k-list">
      {sessions.map((session) => {
        const pill = sourceStatusPill(session.sourceStatus);
        const loading = busy === `session:${session.id}`;
        return (
          <li key={session.id}>
            <button
              className="k-row handoff-session"
              type="button"
              aria-busy={loading || undefined}
              {...waitable(busy !== null, () => onSelect(session))}
            >
              <span className="k-row__lead k-kind k-kind--sm">
                <Icon icon={loading ? CircleNotch : ChatCircleText} size="sm" spin={loading} />
              </span>
              <span className="k-row__title" title={session.title}>
                {session.title}
              </span>
              <span className="k-row__trail">
                <StatePill {...pill} />
              </span>
              <span className="k-row__meta">{sessionUpdated(session.updatedAt, now)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The baseline in one line, with the per-file versions, HEAD and dirty list behind it. */
export function BaselineDetails({ baseline }: { baseline: HandoffBaseline }) {
  const summary = baselineSummary(baseline);
  return (
    <details className="desk-advanced handoff-baseline">
      <summary>
        <Icon icon={CaretRight} size="sm" />
        <span
          className="handoff-baseline__state"
          data-tone={summary.complete ? "success" : "warning"}
        >
          <Icon icon={summary.complete ? CheckCircle : WarningCircle} />
          {summary.text}
        </span>
      </summary>
      <ul className="handoff-files">
        {baseline.files.map((file) => (
          <li key={file.path}>
            <code className="k-mono">{file.path}</code>
            <span className="k-meta">{file.version ? file.version.slice(0, 12) : file.reason}</span>
          </li>
        ))}
      </ul>
      <p className="handoff-note">
        {baseline.git.state === "available"
          ? `HEAD：${baseline.git.head ?? "無 commit"} · ${baseline.git.dirty.length} 個未提交的變更`
          : "無法用 Git 核對。"}
      </p>
      {baseline.git.dirty.length ? (
        <ul className="handoff-files" aria-label="本機未提交的變更">
          {baseline.git.dirty.map((file) => (
            <li key={`${file.status}:${file.previousPath ?? ""}:${file.path}`}>
              <code className="k-mono">{file.status.trim()}</code>
              <span className="k-wrap-any">
                {file.previousPath ? `${file.previousPath} → ` : ""}
                {file.path}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="handoff-note">未選入的內容沒有核對；未提交清單不是來源 Agent 的修改清單。</p>
    </details>
  );
}

export function HandoffFlow({
  workspace,
  onClose,
  request = handoffRequest,
  notify,
  slot,
}: {
  workspace: WorkspaceSummary;
  onClose: () => void;
  request?: typeof handoffRequest;
  /**
   * Routes the flow's messages to the host's one notice slot; null clears only the flow's own
   * message. Without it the flow keeps its own slot (standalone previews).
   */
  notify?: (notice: Notice | null) => void;
  /** The host's notice slot and live regions, placed under this page's header. */
  slot?: ReactNode;
}) {
  const [stage, setStage] = useState<HandoffStage>("source");
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sourceListed, setSourceListed] = useState(false);
  const [snapshot, setSnapshot] = useState<SourceSnapshot | null>(null);
  const [fields, setFields] = useState<HandoffFields>(emptyFields);
  const [paths, setPaths] = useState("");
  const [baseline, setBaseline] = useState<HandoffBaseline | null>(null);
  const [sourceStopped, setSourceStopped] = useState(false);
  const [permissionsChecked, setPermissionsChecked] = useState(false);
  const [preview, setPreview] = useState<HandoffPreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<BusyOp | null>(null);
  const [localNotice, setLocalNotice] = useState<Notice | null>(null);
  const draft = useRef<string | null>(null);
  const guard = useRef(new HandoffRequestGuard());
  const title = useRef<HTMLHeadingElement>(null);
  const stepTitle = useRef<HTMLHeadingElement>(null);
  const sessionsTitle = useRef<HTMLHeadingElement>(null);
  const previewField = useRef<HTMLTextAreaElement>(null);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  // Relative times on the source rows; a minute is fine-grained enough for 5 分鐘前.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!sourceListed) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [sourceListed]);

  /** One message at a time; null clears only this flow's message. */
  const say = useCallback((next: Notice | null) => {
    const host = notifyRef.current;
    if (host) host(next);
    else setLocalNotice((current) => (next ? nextNotice(current, next) : null));
  }, []);
  const dismissLocal = useCallback(() => setLocalNotice(null), []);

  useEffect(() => {
    guard.current.activate(workspace.id);
    setStage("source");
    setSourceListed(false);
    setSessions([]);
    setCursor(null);
    setSnapshot(null);
    setFields(emptyFields);
    setPaths("");
    setSourceStopped(false);
    setPermissionsChecked(false);
    setBaseline(null);
    setPreview(null);
    setReviewed(false);
    setCopied(false);
    setBusy(null);
    say(null);
    title.current?.focus();
    return () => {
      guard.current.close();
      say(null);
      const draftId = draft.current;
      draft.current = null;
      if (draftId) void request({ action: "cancel", draft_id: draftId }).catch(() => undefined);
    };
  }, [request, workspace.id, say]);

  const invalidate = () => {
    setBaseline(null);
    setPreview(null);
    setReviewed(false);
    setCopied(false);
  };
  const clearSource = () => {
    setSourceListed(false);
    setSessions([]);
    setCursor(null);
    setSnapshot(null);
    setFields(emptyFields);
    setPaths("");
    setSourceStopped(false);
    setPermissionsChecked(false);
    invalidate();
  };
  /** Moving forward lands on the new step's heading, so a screen reader hears where it is. */
  const focusStep = (active: () => boolean = () => true) =>
    requestAnimationFrame(() => active() && stepTitle.current?.focus());
  /** A listed or paged source list: focus goes to its heading, above the new rows. */
  const focusSessions = (active: () => boolean) =>
    requestAnimationFrame(() => active() && sessionsTitle.current?.focus());
  const run = async (op: BusyOp, operation: (active: () => boolean) => Promise<void>) => {
    const active = guard.current.begin();
    setBusy(op);
    say(null);
    try {
      await operation(active);
    } catch (caught) {
      if (active()) say({ tone: "danger", text: handoffError(caught).message, source: "handoff" });
    } finally {
      if (active()) setBusy(null);
    }
  };
  const start = (provider: "codex" | "manual") =>
    void run(provider, async (active) => {
      clearSource();
      const oldDraft = draft.current;
      draft.current = null;
      if (oldDraft) await request({ action: "cancel", draft_id: oldDraft });
      if (!active()) return;
      const requestedDraft = crypto.randomUUID();
      draft.current = requestedDraft;
      const result = await request<StartResult>({
        action: "start",
        workspace_id: workspace.id,
        provider,
        draft_id: requestedDraft,
      });
      if (!active()) {
        await request({ action: "cancel", draft_id: result.draft_id });
        return;
      }
      draft.current = result.draft_id;
      setSessions(result.sessions);
      setCursor(result.nextCursor);
      setSourceListed(provider === "codex");
      if (provider === "manual") {
        setStage("brief");
        focusStep(active);
      } else focusSessions(active);
    });
  const selectSource = (session: AgentSession) =>
    void run(`session:${session.id}`, async (active) => {
      const draftId = draft.current;
      if (!draftId) return;
      const result = await request<{ snapshot: SourceSnapshot }>({
        action: "snapshot",
        draft_id: draftId,
        session_id: session.id,
      });
      if (!active()) return;
      setSnapshot(result.snapshot);
      setFields(emptyFields);
      setPaths("");
      setSourceStopped(false);
      setPermissionsChecked(false);
      invalidate();
      setStage("brief");
      focusStep(active);
    });
  const nextPage = () =>
    void run("list", async (active) => {
      const draftId = draft.current;
      if (!draftId || !cursor) return;
      const page = await request<Omit<StartResult, "draft_id">>({
        action: "list",
        draft_id: draftId,
        cursor,
      });
      if (active()) {
        setSessions(page.sessions);
        setCursor(page.nextCursor);
        // 下一頁 is gone on the last page; the list heading is where the new rows start.
        focusSessions(active);
      }
    });
  const update = (key: keyof HandoffFields, value: string) => {
    setFields((old) => ({ ...old, [key]: value }));
    invalidate();
  };
  const checkAndPreview = () =>
    void run("check", async (active) => {
      const draftId = draft.current;
      if (!draftId) return;
      invalidate();
      const checked = await request<HandoffBaseline>({
        action: "baseline",
        draft_id: draftId,
        paths: relatedPaths(paths),
      });
      if (!active()) return;
      setBaseline(checked);
      const result = await request<HandoffPreview>({
        action: "preview",
        draft_id: draftId,
        fields,
        source_stopped: sourceStopped,
        permissions_checked: permissionsChecked,
      });
      if (!active()) return;
      setPreview(result);
      setStage("preview");
      focusStep(active);
    });
  const copy = () =>
    void run("copy", async (active) => {
      const draftId = draft.current;
      if (!draftId || !preview || !reviewed) return;
      setCopied(false);
      const copied = await copyHandoffContent(preview, {
        prepare: () =>
          request<{ text: string; digest: string }>({
            action: "prepare",
            draft_id: draftId,
            content_digest: preview.digest,
            source_stopped: true,
            permissions_checked: true,
          }),
        writeText: (text) => navigator.clipboard.writeText(text),
        // The reviewed content no longer stands: back to the form to check again.
        invalidate: () => {
          invalidate();
          setStage("brief");
          focusStep(active);
        },
        fallback: () => {
          setReviewed(false);
          setCopied(false);
          previewField.current?.focus();
          previewField.current?.select();
        },
        active,
      });
      if (copied) {
        setCopied(true);
        say({ tone: "success", text: HANDOFF_COPIED_TEXT, source: "handoff" });
      }
    });
  const reselect = () =>
    void run("reselect", async (active) => {
      const draftId = draft.current;
      draft.current = null;
      clearSource();
      setStage("source");
      requestAnimationFrame(() => active() && title.current?.focus());
      if (draftId) await request({ action: "cancel", draft_id: draftId });
    });
  /** Back to the form: the reviewed preview no longer stands, so 核對並預覽 runs again. */
  const edit = () => {
    invalidate();
    setStage("brief");
    focusStep();
  };

  const pending = busy !== null;
  // A preview step without a preview (it was just invalidated) shows the form instead.
  const view: HandoffStage = stage === "preview" && !preview ? "brief" : stage;
  const steps = handoffSteps(view, copied);
  const pathsError = relatedPathsError(paths);
  const ready = briefReady(fields) && !pathsError;
  const copyBlocker = preview
    ? handoffCopyBlocker({ preview, sourceStopped, permissionsChecked })
    : null;
  const spinner = (op: BusyOp, fallback: ReactNode = null) =>
    busy === op ? <Icon icon={CircleNotch} spin /> : fallback;

  return (
    <section className="handoff-page" aria-labelledby="handoff-title" aria-busy={pending}>
      <header className="handoff-head">
        <button
          className="k-btn k-btn--quiet k-btn--sm handoff-back"
          type="button"
          onClick={onClose}
        >
          <Icon icon={ArrowLeft} />
          返回專案
        </button>
        <h1 className="k-page-title handoff-title" ref={title} tabIndex={-1} id="handoff-title">
          {handoffTitle(workspace.name)}
        </h1>
        <HandoffStepper steps={steps} />
        {slot ?? <NoticeSlot notice={localNotice} onDismiss={dismissLocal} />}
      </header>

      {view === "source" ? (
        <section className="handoff-step" aria-labelledby="handoff-step-title">
          <h2 className="k-sr-only" id="handoff-step-title" ref={stepTitle} tabIndex={-1}>
            {handoffStepHeading("source")}
          </h2>
          <div className="handoff-choices">
            <button
              className="k-card handoff-choice"
              type="button"
              data-selected={sourceListed || undefined}
              aria-busy={busy === "codex" || undefined}
              {...waitable(pending, () => start("codex"))}
            >
              <span className="k-kind">
                <Icon icon={ClockCounterClockwise} size="lg" />
              </span>
              <span className="handoff-choice__text">
                <span className="handoff-choice__title">讀取 Codex 紀錄</span>
                <span className="handoff-choice__desc">
                  列出這個專案最近的 Codex 對話，選一筆當參考。
                </span>
              </span>
              {spinner("codex", <Icon icon={CaretRight} />)}
            </button>
            <button
              className="k-card handoff-choice"
              type="button"
              aria-busy={busy === "manual" || undefined}
              {...waitable(pending, () => start("manual"))}
            >
              <span className="k-kind">
                <Icon icon={PencilSimpleLine} size="lg" />
              </span>
              <span className="handoff-choice__text">
                <span className="handoff-choice__title">手動建立摘要</span>
                <span className="handoff-choice__desc">不讀取紀錄，直接寫下目標與下一步。</span>
              </span>
              {spinner("manual", <Icon icon={CaretRight} />)}
            </button>
          </div>
          {sourceListed ? (
            <section className="k-card handoff-sessions" aria-labelledby="handoff-sessions-title">
              <div className="k-card__head">
                <h3
                  className="k-card__title"
                  id="handoff-sessions-title"
                  ref={sessionsTitle}
                  tabIndex={-1}
                >
                  這個專案的 Codex 紀錄
                </h3>
              </div>
              <SessionList
                sessions={sessions}
                hasNextPage={cursor !== null}
                busy={busy}
                now={now}
                onSelect={selectSource}
              />
              {cursor ? (
                <div className="handoff-sessions__foot">
                  <button
                    className="k-btn k-btn--secondary k-btn--sm"
                    type="button"
                    aria-busy={busy === "list" || undefined}
                    {...waitable(pending, nextPage)}
                  >
                    {spinner("list")}
                    下一頁
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}
        </section>
      ) : null}

      {view === "brief" ? (
        <section className="handoff-step handoff-form" aria-labelledby="handoff-step-title">
          <h2 className="k-sr-only" id="handoff-step-title" ref={stepTitle} tabIndex={-1}>
            {handoffStepHeading("brief")}
          </h2>
          {snapshot ? (
            <details className="desk-advanced handoff-ref">
              <summary>
                <Icon icon={CaretRight} size="sm" />
                <span className="handoff-ref__title">
                  來源參考：{snapshot.source.title}
                  <span className="k-meta"> · {coverageSummary(snapshot)}</span>
                </span>
              </summary>
              <p className="handoff-note">來源摘錄只供參考；整理時請刪掉敏感內容。</p>
              <pre className="k-codebox handoff-excerpt">
                {[snapshot.lastUserRequest, snapshot.lastAgentResponse]
                  .filter(Boolean)
                  .join("\n\n") || "沒有可用的文字。"}
              </pre>
              {[...snapshot.completedTurns, ...snapshot.partialTurns].some(
                (turn) => turn.actions.length,
              ) ? (
                <pre className="k-codebox handoff-excerpt">
                  {[...snapshot.completedTurns, ...snapshot.partialTurns]
                    .flatMap((turn) => turn.actions)
                    .map(
                      (action) =>
                        `${action.command ?? action.type} · 結束碼 ${action.exitCode ?? "不明"}`,
                    )
                    .join("\n")}
                </pre>
              ) : null}
              <p className="handoff-note">歷史命令的執行時間與當時的版本不明。</p>
            </details>
          ) : null}
          <div className="handoff-field">
            <label className="handoff-label" htmlFor="handoff-goal">
              目標
            </label>
            <textarea
              id="handoff-goal"
              className="k-textarea"
              maxLength={500}
              required
              value={fields.goal}
              disabled={pending}
              onChange={(event) => update("goal", event.target.value)}
            />
          </div>
          <div className="handoff-field">
            <label className="handoff-label" htmlFor="handoff-next">
              下一步
            </label>
            <textarea
              id="handoff-next"
              className="k-textarea"
              maxLength={500}
              required
              value={fields.next_action}
              disabled={pending}
              onChange={(event) => update("next_action", event.target.value)}
            />
          </div>
          <details className="desk-advanced">
            <summary>
              <Icon icon={CaretRight} size="sm" />
              完成事項、決策與待驗證（選填）
            </summary>
            <div className="handoff-optional__fields">
              {OPTIONAL_FIELDS.map(([key, label]) => (
                <div className="handoff-field" key={key}>
                  <label className="handoff-label" htmlFor={`handoff-${key}`}>
                    {label}
                  </label>
                  <textarea
                    id={`handoff-${key}`}
                    className="k-textarea"
                    maxLength={1000}
                    value={fields[key]}
                    disabled={pending}
                    onChange={(event) => update(key, event.target.value)}
                  />
                </div>
              ))}
            </div>
          </details>
          <div className="handoff-field">
            <label className="handoff-label" htmlFor="handoff-paths">
              相關文字檔
            </label>
            <textarea
              id="handoff-paths"
              className="k-textarea k-input--mono handoff-paths"
              placeholder={"src/main.ts\nREADME.md"}
              value={paths}
              disabled={pending}
              aria-invalid={pathsError ? true : undefined}
              aria-describedby="handoff-paths-hint"
              onChange={(event) => {
                setPaths(event.target.value);
                invalidate();
              }}
            />
            {pathsError ? (
              <p className="k-error" id="handoff-paths-hint">
                {pathsError}
              </p>
            ) : (
              <p className="k-hint" id="handoff-paths-hint">
                每行一個相對路徑，最多 20 個；預覽前會核對版本。
              </p>
            )}
          </div>
          <fieldset className="handoff-attest">
            <legend className="handoff-label">複製前的確認</legend>
            <label className="handoff-check">
              <input
                className="k-check"
                type="checkbox"
                checked={sourceStopped}
                disabled={pending}
                onChange={(event) => {
                  setSourceStopped(event.target.checked);
                  invalidate();
                }}
              />
              已在來源停止工作（人工聲明）
            </label>
            <label className="handoff-check">
              <input
                className="k-check"
                type="checkbox"
                checked={permissionsChecked}
                disabled={pending}
                onChange={(event) => {
                  setPermissionsChecked(event.target.checked);
                  invalidate();
                }}
              />
              已在瀏覽器側欄核對這個專案目前的權限
            </label>
            <details className="desk-advanced">
              <summary>
                <Icon icon={CaretRight} size="sm" />
                權限與並行限制
              </summary>
              <p className="handoff-note">
                接續不會收回授權。要停用自動執行，請到瀏覽器側欄收回；這會影響同一個 Kairomes
                的其他工作。人工停止不保證只有一方寫入。
              </p>
            </details>
          </fieldset>
          <div className="handoff-actions">
            <button
              className="k-btn k-btn--primary"
              type="button"
              disabled={!ready}
              aria-busy={busy === "check" || undefined}
              aria-describedby={
                !briefReady(fields)
                  ? "handoff-ready-hint"
                  : pathsError
                    ? "handoff-paths-hint"
                    : undefined
              }
              {...waitable(pending, checkAndPreview)}
            >
              {spinner("check")}
              核對並預覽
            </button>
            <button className="k-btn k-btn--quiet" type="button" {...waitable(pending, reselect)}>
              {spinner("reselect", <Icon icon={ArrowCounterClockwise} />)}
              重新選來源
            </button>
          </div>
          {briefReady(fields) ? null : (
            <p className="k-hint handoff-hint" id="handoff-ready-hint">
              填好目標與下一步，就能核對並預覽。
            </p>
          )}
        </section>
      ) : null}

      {view === "preview" && preview ? (
        <section className="handoff-step handoff-form" aria-labelledby="handoff-step-title">
          <h2 className="k-sr-only" id="handoff-step-title" ref={stepTitle} tabIndex={-1}>
            {handoffStepHeading("preview")}
          </h2>
          {baseline ? <BaselineDetails baseline={baseline} /> : null}
          {preview.blocked_reason ? (
            <div className="k-notice" data-tone="warning" role="status">
              <Icon icon={WarningCircle} size="lg" />
              <div className="k-notice__body">{preview.blocked_reason}</div>
            </div>
          ) : null}
          <div className="handoff-field">
            <label className="handoff-label" htmlFor="handoff-preview">
              將複製的完整內容
            </label>
            <textarea
              id="handoff-preview"
              className="k-codebox handoff-codebox"
              ref={previewField}
              readOnly
              value={preview.text}
            />
          </div>
          <label className="handoff-check">
            <input
              className="k-check"
              type="checkbox"
              checked={reviewed}
              disabled={pending}
              onChange={(event) => {
                setReviewed(event.target.checked);
                setCopied(false);
              }}
            />
            已審閱分享內容
          </label>
          <div className="handoff-actions">
            <button
              className="k-btn k-btn--primary"
              type="button"
              disabled={
                !canCopyHandoff({
                  busy: false,
                  reviewed,
                  sourceStopped,
                  permissionsChecked,
                  preview,
                })
              }
              aria-busy={busy === "copy" || undefined}
              aria-describedby={copyBlocker ? "handoff-copy-hint" : undefined}
              {...waitable(pending, copy)}
            >
              {spinner("copy", <Icon icon={Copy} />)}
              複製接續內容
            </button>
            <button className="k-btn k-btn--quiet" type="button" {...waitable(pending, edit)}>
              <Icon icon={PencilSimple} />
              返回修改
            </button>
          </div>
          {copyBlocker ? (
            <p className="k-hint handoff-hint" id="handoff-copy-hint">
              {copyBlocker}
            </p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
