import { ArrowLeft, CircleNotch, Copy } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type {
  HandoffBaseline,
  HandoffFields,
  HandoffPreview,
} from "../../../packages/protocol/src/handoff.ts";
import { handoffCoverageTruncated } from "../../../packages/protocol/src/handoff.ts";
import type { AgentSession, HandoffSnapshot } from "../../daemon/src/agent-sessions.ts";
import { handoffRequest } from "./api.ts";
import { copyHandoffContent, handoffError } from "./handoff-copy.ts";
import { HandoffRequestGuard } from "./handoff-session.ts";
import type { WorkspaceSummary } from "./model.ts";

type StartResult = { draft_id: string; sessions: AgentSession[]; nextCursor: string | null };
const emptyFields: HandoffFields = {
  goal: "",
  next_action: "",
  completed: "",
  decisions: "",
  unknowns: "",
};
function sourceStatusLabel(status: string) {
  const labels: Record<string, string> = {
    idle: "閒置",
    notLoaded: "未載入",
    inProgress: "進行中",
    active: "進行中",
    running: "進行中",
    systemError: "來源異常",
    error: "來源異常",
    unavailable: "無法核對",
    unknown: "未知",
  };
  return labels[status] ?? "未知";
}

export function HandoffFlow({
  workspace,
  onClose,
  request = handoffRequest,
}: {
  workspace: WorkspaceSummary;
  onClose: () => void;
  request?: typeof handoffRequest;
}) {
  const [stage, setStage] = useState<"source" | "brief">("source");
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sourceListed, setSourceListed] = useState(false);
  const [snapshot, setSnapshot] = useState<Omit<HandoffSnapshot, "workspace"> | null>(null);
  const [fields, setFields] = useState<HandoffFields>(emptyFields);
  const [paths, setPaths] = useState("");
  const [baseline, setBaseline] = useState<HandoffBaseline | null>(null);
  const [sourceStopped, setSourceStopped] = useState(false);
  const [permissionsChecked, setPermissionsChecked] = useState(false);
  const [preview, setPreview] = useState<HandoffPreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const draft = useRef<string | null>(null);
  const guard = useRef(new HandoffRequestGuard());
  const title = useRef<HTMLHeadingElement>(null);
  const previewField = useRef<HTMLTextAreaElement>(null);

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
    setBusy(false);
    setError("");
    title.current?.focus();
    return () => {
      guard.current.close();
      const draftId = draft.current;
      draft.current = null;
      if (draftId) void request({ action: "cancel", draft_id: draftId }).catch(() => undefined);
    };
  }, [request, workspace.id]);

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
  const run = async (operation: (active: () => boolean) => Promise<void>) => {
    const active = guard.current.begin();
    setBusy(true);
    setError("");
    try {
      await operation(active);
    } catch (caught) {
      if (active()) setError(handoffError(caught).message);
    } finally {
      if (active()) setBusy(false);
    }
  };
  const start = (provider: "codex" | "manual") =>
    void run(async (active) => {
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
        requestAnimationFrame(() => active() && title.current?.focus());
      }
    });
  const selectSource = (session: AgentSession) =>
    void run(async (active) => {
      const draftId = draft.current;
      if (!draftId) return;
      const result = await request<{ snapshot: Omit<HandoffSnapshot, "workspace"> }>({
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
      requestAnimationFrame(() => active() && title.current?.focus());
    });
  const update = (key: keyof HandoffFields, value: string) => {
    setFields((old) => ({ ...old, [key]: value }));
    invalidate();
  };
  const checkAndPreview = () =>
    void run(async (active) => {
      const draftId = draft.current;
      if (!draftId) return;
      invalidate();
      const checked = await request<HandoffBaseline>({
        action: "baseline",
        draft_id: draftId,
        paths: paths
          .split(/\r?\n/)
          .map((p) => p.trim())
          .filter(Boolean),
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
      if (active()) setPreview(result);
    });
  const copy = () =>
    void run(async (active) => {
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
        invalidate,
        fallback: () => {
          setReviewed(false);
          setCopied(false);
          previewField.current?.focus();
          previewField.current?.select();
        },
        active,
      });
      if (copied) setCopied(true);
    });
  const reselect = () =>
    void run(async (active) => {
      const draftId = draft.current;
      draft.current = null;
      clearSource();
      setStage("source");
      requestAnimationFrame(() => active() && title.current?.focus());
      if (draftId) await request({ action: "cancel", draft_id: draftId });
    });

  return (
    <section className="handoff-page" aria-labelledby="handoff-title" aria-busy={busy}>
      <div className="handoff-heading">
        <button className="button secondary" type="button" onClick={onClose}>
          <ArrowLeft /> 專案
        </button>
        <div>
          <h2 ref={title} tabIndex={-1} id="handoff-title">
            {stage === "source" ? "選來源" : "接續內容"}
          </h2>
          <span>
            {workspace.name}
            {snapshot ? ` · ${snapshot.source.title}` : ""}
          </span>
        </div>
        {busy ? <CircleNotch className="spin" aria-label="正在核對" /> : null}
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {stage === "source" ? (
        <>
          <div className="button-row">
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={() => start("codex")}
            >
              讀取 Codex 紀錄
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => start("manual")}
            >
              手動建立摘要
            </button>
          </div>
          <section className="handoff-sources" aria-label="同專案來源紀錄">
            {sessions.map((session) => (
              <button
                className="handoff-source"
                type="button"
                disabled={busy}
                key={session.id}
                onClick={() => selectSource(session)}
              >
                <strong>{session.title}</strong>
                <span>
                  {new Date(session.updatedAt * 1000).toLocaleString()} ·{" "}
                  {sourceStatusLabel(session.sourceStatus)}
                </span>
              </button>
            ))}
            {sourceListed && !sessions.length && !busy ? (
              <p>此頁沒有同專案紀錄，可手動建立摘要。</p>
            ) : null}
          </section>
          {cursor ? (
            <button
              className="button secondary"
              disabled={busy}
              type="button"
              onClick={() =>
                void run(async (active) => {
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
                  }
                })
              }
            >
              下一頁
            </button>
          ) : null}
        </>
      ) : (
        <>
          {snapshot ? (
            <details className="handoff-details">
              <summary>
                來源參考 · 最近 {snapshot.coverage.recentTurnsRequested} turns
                {snapshot.partialTurns.length ? " · 有中斷" : ""}
                {snapshot.pendingTurns.length ? " · 有進行中" : ""}
                {handoffCoverageTruncated(snapshot.coverage) || snapshot.coverage.hasOlderTurns
                  ? " · 範圍有限"
                  : ""}
              </summary>
              <p>來源摘錄僅供參考；請刪除敏感內容再自行整理。</p>
              <pre>
                {[snapshot.lastUserRequest, snapshot.lastAgentResponse]
                  .filter(Boolean)
                  .join("\n\n") || "沒有可用文字"}
              </pre>
              <pre>
                {[...snapshot.completedTurns, ...snapshot.partialTurns]
                  .flatMap((turn) => turn.actions)
                  .map((action) => `${action.command} · exit ${action.exitCode ?? "unknown"}`)
                  .join("\n")}
              </pre>
              <p>歷史命令的執行時間與當時版本未知。</p>
            </details>
          ) : null}
          <div className="handoff-fields">
            <label>
              目標
              <textarea
                maxLength={500}
                value={fields.goal}
                disabled={busy}
                onChange={(event) => update("goal", event.target.value)}
              />
            </label>
            <label>
              下一步
              <textarea
                maxLength={500}
                value={fields.next_action}
                disabled={busy}
                onChange={(event) => update("next_action", event.target.value)}
              />
            </label>
            <details className="handoff-details">
              <summary>完成事項、決策與待驗證</summary>
              {(
                [
                  ["completed", "完成事項"],
                  ["decisions", "決策"],
                  ["unknowns", "待驗證"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <textarea
                    maxLength={1000}
                    value={fields[key]}
                    disabled={busy}
                    onChange={(event) => update(key, event.target.value)}
                  />
                </label>
              ))}
            </details>
            <label>
              相關文字檔 <span>最多 20 檔，每行一個相對路徑</span>
              <textarea
                className="handoff-paths"
                placeholder={"src/main.ts\nREADME.md"}
                value={paths}
                disabled={busy}
                onChange={(event) => {
                  setPaths(event.target.value);
                  setBaseline(null);
                  invalidate();
                }}
              />
            </label>
          </div>
          <label className="handoff-check">
            <input
              type="checkbox"
              checked={sourceStopped}
              disabled={busy}
              onChange={(event) => {
                setSourceStopped(event.target.checked);
                invalidate();
              }}
            />
            已在來源停止工作（人工聲明）
          </label>
          <label className="handoff-check">
            <input
              type="checkbox"
              checked={permissionsChecked}
              disabled={busy}
              onChange={(event) => {
                setPermissionsChecked(event.target.checked);
                invalidate();
              }}
            />
            已在原生側欄核對此專案有效權限
          </label>
          <details className="handoff-details">
            <summary>權限與並行限制</summary>
            <p>
              此步不收回授權。若要停用自動執行，請在原生側欄收回；會影響同實例其他工作。人工停止不保證排他寫入。
            </p>
          </details>
          <div className="button-row">
            <button
              className="button secondary"
              type="button"
              disabled={busy || !fields.goal.trim() || !fields.next_action.trim()}
              onClick={checkAndPreview}
            >
              {preview ? "重新核對" : "核對並預覽"}
            </button>
            <button className="text-link" type="button" onClick={reselect}>
              重新選來源
            </button>
          </div>
          {baseline ? (
            <details className="handoff-details">
              <summary>
                {baseline.complete ? "相關檔案已核對" : "基準不完整，僅供核對"} ·{" "}
                {baseline.files.length} 檔
              </summary>
              <ul>
                {baseline.files.map((file) => (
                  <li key={file.path}>
                    <strong>{file.path}</strong> ·{" "}
                    {file.version ? file.version.slice(0, 12) : file.reason}
                  </li>
                ))}
              </ul>
              <p>
                {baseline.git.state === "available"
                  ? `HEAD：${baseline.git.head ?? "無 commit"} · ${baseline.git.dirty.length} 個 dirty 記錄`
                  : "Git 無法核對"}
              </p>
              {baseline.git.dirty.length ? (
                <ul aria-label="本機 dirty 記錄">
                  {baseline.git.dirty.map((file) => (
                    <li key={`${file.status}:${file.previousPath ?? ""}:${file.path}`}>
                      <code>{file.status.trim()}</code> ·{" "}
                      {file.previousPath ? `${file.previousPath} → ` : ""}
                      {file.path}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p>未選入內容未核對；dirty 清單不是來源 Agent 的修改清單。</p>
            </details>
          ) : null}
          {preview ? (
            <section className="handoff-preview">
              <h3>將複製的完整內容</h3>
              {preview.blocked_reason ? (
                <p className="field-error" role="status">
                  {preview.blocked_reason}
                </p>
              ) : null}
              <textarea
                ref={previewField}
                readOnly
                value={preview.text}
                aria-label="將複製的接續內容"
              />
              <label className="handoff-check">
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={busy}
                  onChange={(event) => {
                    setReviewed(event.target.checked);
                    setCopied(false);
                  }}
                />
                已審閱分享內容
              </label>
              <button
                className="button primary"
                type="button"
                disabled={
                  busy || !reviewed || !sourceStopped || !permissionsChecked || !preview.complete
                }
                onClick={copy}
              >
                <Copy />
                複製接續內容
              </button>
              {copied ? <p role="status">已複製，請自行貼到 ChatGPT。</p> : null}
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}
