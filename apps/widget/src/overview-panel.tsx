import {
  type ActivityEntry,
  type ActivitySnapshot,
  type Artifact,
  type ArtifactImport,
  artifactImportLabels,
  type Command,
  commandLabels,
  type FileChange,
  type FileResult,
  fileChangeLabels,
  type McpCall,
  type SearchResult,
  terminalLabels,
} from "@kairomes/protocol";
import {
  ArrowRightIcon,
  FileIcon,
  FilesIcon,
  FolderOpenIcon,
  ImageIcon,
  InfoIcon,
  PlugsConnectedIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { activityLabel, activityTitle } from "./activity-model.ts";
import { latestFocus } from "./activity-panel.tsx";
import { ArtifactPreview } from "./artifact-panel.tsx";
import type { WorkbenchBridge } from "./bridge.ts";
import { CommandOutput, useCommandOutput } from "./command-panel.tsx";
import { requireFileChangeResult } from "./result-identity.ts";
import { TerminalOutputPreview } from "./terminal-output.tsx";

function CommandPreview({ bridge, command }: { bridge: WorkbenchBridge; command: Command }) {
  const { result, error } = useCommandOutput(bridge, command.id, 4000);
  return <CommandOutput result={result} error={error} />;
}

export function DiffPreview({ bridge, change }: { bridge: WorkbenchBridge; change: FileChange }) {
  const identity = `${change.workspace_id}:${change.id}`;
  const [state, setState] = useState({ identity, diff: "", truncated: false, error: "" });
  const { diff, truncated, error } =
    state.identity === identity ? state : { diff: "", truncated: false, error: "" };
  useEffect(() => {
    let stopped = false;
    setState({ identity, diff: "", truncated: false, error: "" });
    void bridge
      .call("file_change_poll", { change_id: change.id })
      .then((data) => {
        if (stopped) return;
        const result = requireFileChangeResult(data, {
          id: change.id,
          workspaceId: change.workspace_id,
        });
        setState({ identity, diff: result.diff, truncated: result.diff_truncated, error: "" });
      })
      .catch((cause) => {
        if (!stopped)
          setState({
            identity,
            diff: "",
            truncated: false,
            error: cause instanceof Error ? cause.message : "無法取得差異。",
          });
      });
    return () => {
      stopped = true;
    };
  }, [bridge, change.id, change.workspace_id, identity]);
  if (error) return <p className="inspector-error">{error}</p>;
  if (!diff) return <p className="inspector-muted">正在整理技術差異…</p>;
  const occurrences = new Map<string, number>();
  const lines = diff
    .split("\n")
    .slice(0, 160)
    .map((line) => {
      const occurrence = (occurrences.get(line) ?? 0) + 1;
      occurrences.set(line, occurrence);
      return { key: `${line}:${occurrence}`, line };
    });
  return (
    <section className="signal-diff" aria-label="技術差異">
      {lines.map(({ key, line }, index) => (
        <div
          className={
            line.startsWith("+") && !line.startsWith("+++")
              ? "added"
              : line.startsWith("-") && !line.startsWith("---")
                ? "removed"
                : line.startsWith("@@")
                  ? "range"
                  : "context"
          }
          key={key}
        >
          <span>{index + 1}</span>
          <code>{line || " "}</code>
        </div>
      ))}
      {(truncated || diff.split("\n").length > 160) && <p>僅顯示部分差異。</p>}
    </section>
  );
}

export function McpImagePreview({
  bridge,
  media,
  label,
}: {
  bridge: WorkbenchBridge;
  media: Extract<McpCall["content"][number], { type: "image" }>;
  label: string;
}) {
  const identity = media.media_id;
  const [preview, setPreview] = useState({ identity, source: "", error: "" });
  const { source, error } = preview.identity === identity ? preview : { source: "", error: "" };
  useEffect(() => {
    let stopped = false;
    let objectUrl = "";
    setPreview({ identity, source: "", error: "" });
    if (!bridge.loadMcpMedia) return;
    void bridge
      .loadMcpMedia(media.media_id)
      .then((url) => {
        objectUrl = url;
        if (stopped) URL.revokeObjectURL(url);
        else setPreview({ identity, source: url, error: "" });
      })
      .catch((cause) => {
        if (!stopped)
          setPreview({
            identity,
            source: "",
            error: cause instanceof Error ? cause.message : "無法載入 MCP 圖片預覽。",
          });
      });
    return () => {
      stopped = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bridge, media.media_id, identity]);
  return (
    <figure className="mcp-media-preview">
      {source ? (
        <img src={source} alt={`${label} 的 MCP 圖片結果`} />
      ) : (
        <div className="mcp-media-placeholder">
          <ImageIcon />
          <span>{error || "正在載入本機預覽…"}</span>
        </div>
      )}
      <figcaption>
        {media.width.toLocaleString()} × {media.height.toLocaleString()} · {media.mime_type}
      </figcaption>
    </figure>
  );
}

function McpCallSummary({ value, bridge }: { value: McpCall; bridge: WorkbenchBridge }) {
  const label = value.tool.title ?? value.tool.name;
  const images = value.content.filter(
    (item): item is Extract<McpCall["content"][number], { type: "image" }> => item.type === "image",
  );
  const text = value.content.filter(
    (item): item is Extract<McpCall["content"][number], { type: "text" }> => item.type === "text",
  );
  return (
    <>
      <div className="inspector-status-row">
        <span className={`inspector-status state-${value.is_error ? "failed" : "completed"}`}>
          {value.is_error ? "工具回報錯誤" : "呼叫完成"}
        </span>
        <span>{value.duration_ms.toLocaleString()} ms</span>
      </div>
      <section className="inspector-section">
        <h2>呼叫的工具</h2>
        <p>{value.tool.server_name}</p>
        <code className="inspector-command">{label}</code>
      </section>
      {images.length > 0 && (
        <section className="inspector-section">
          <h2>圖片結果</h2>
          <div className="mcp-media-grid">
            {images.map((media) => (
              <McpImagePreview key={media.media_id} bridge={bridge} media={media} label={label} />
            ))}
          </div>
        </section>
      )}
      {text.length > 0 && (
        <section className="inspector-section">
          <h2>文字結果</h2>
          <pre className="result-excerpt">{text.map((item) => item.text).join("\n\n")}</pre>
        </section>
      )}
      {value.truncated && (
        <div className="inspector-callout">
          <InfoIcon weight="fill" />
          <span>下游結果超過安全顯示上限，Kairomes 已省略部分內容。</span>
        </div>
      )}
      <details className="inspector-technical">
        <summary>呼叫參數</summary>
        <pre className="mcp-arguments-preview">
          {JSON.stringify(value.arguments_preview, null, 2)}
        </pre>
      </details>
      {value.structured_content && (
        <details className="inspector-technical">
          <summary>結構化結果</summary>
          <pre className="mcp-arguments-preview">
            {JSON.stringify(value.structured_content, null, 2)}
          </pre>
        </details>
      )}
    </>
  );
}

const operationLabel = { edit: "修改", write: "寫入", delete: "刪除" } as const;

export interface OverviewContext {
  entry?: ActivityEntry;
  file: FileResult | null;
  search: SearchResult | null;
  artifact: Artifact | null;
  mcpCall: McpCall | null;
  loadedResultId?: string;
}

export function OverviewPanel({
  snapshot,
  bridge,
  file: liveFile,
  search: liveSearch,
  artifact: liveArtifact,
  mcpCall: liveMcpCall,
  onSelect,
  onFiles,
  workspaceName,
  loadedResultId: liveResultId,
  selectedEntry,
  pausedOverview,
  workspaceId,
}: {
  snapshot?: ActivitySnapshot;
  bridge: WorkbenchBridge;
  file: FileResult | null;
  search: SearchResult | null;
  artifact: Artifact | null;
  mcpCall: McpCall | null;
  onSelect(entry: ActivityEntry): void;
  onFiles(): void;
  workspaceName(id?: string): string;
  loadedResultId?: string;
  selectedEntry?: ActivityEntry;
  pausedOverview?: OverviewContext;
  workspaceId?: string | null;
}) {
  const held = selectedEntry ? undefined : pausedOverview;
  const file = held ? held.file : liveFile;
  const search = held ? held.search : liveSearch;
  const artifact = held ? held.artifact : liveArtifact;
  const mcpCall = held ? held.mcpCall : liveMcpCall;
  const loadedResultId = held ? held.loadedResultId : liveResultId;
  const current =
    selectedEntry ?? (pausedOverview ? pausedOverview.entry : latestFocus(snapshot, workspaceId));
  const session = snapshot?.sessions.find((item) => item.id === current?.sessionId);
  const command = snapshot?.commands?.find((item) => item.id === current?.commandId);
  const change = snapshot?.changes?.find((item) => item.id === current?.changeId);
  const artifactImport = snapshot?.imports?.find((item) => item.id === current?.importId);
  const fileMatches =
    !!current?.resultId &&
    current.resultId === loadedResultId &&
    current.tool === "file_read" &&
    file?.workspace_id === current.workspaceId &&
    file?.path === current.path;
  const searchMatches =
    !!current?.resultId &&
    current.resultId === loadedResultId &&
    current.tool === "file_search" &&
    search?.workspace_id === current.workspaceId;
  const artifactMatches =
    !!current?.resultId &&
    current.resultId === loadedResultId &&
    (current.tool === "artifact_preview" || current.tool === "artifact_import_request") &&
    artifact?.workspace_id === current.workspaceId &&
    artifact?.path === current.path;
  const isArtifact =
    current?.tool === "artifact_preview" || current?.tool === "artifact_import_request";
  const isMcp = current?.tool === "mcp_tool_call" || current?.tool === "mcp_read_call";
  const mcpMatches = !!current?.resultId && current.resultId === loadedResultId && isMcp;

  return (
    <section className="overview-panel signal-overview" aria-label="目前動作摘要">
      <header className="inspector-heading">
        <span>摘要</span>
        <small>{isMcp ? "MCP 工具" : workspaceName(current?.workspaceId)}</small>
      </header>
      {!current ? (
        <div className="inspector-empty">
          <span>
            <FolderOpenIcon weight="duotone" />
          </span>
          <button type="button" onClick={onFiles}>
            <FolderOpenIcon /> 瀏覽專案
          </button>
        </div>
      ) : (
        <>
          <div className="inspector-title">
            <span className={`inspector-kind kind-${current.kind}`}>
              {change ? (
                <FilesIcon />
              ) : command || session ? (
                <TerminalWindowIcon />
              ) : isArtifact ? (
                <ImageIcon />
              ) : isMcp ? (
                <PlugsConnectedIcon />
              ) : (
                <FileIcon />
              )}
            </span>
            <div>
              <h1>{activityTitle(current)}</h1>
            </div>
          </div>
          {current.message && <p className="inspector-error">{current.message}</p>}

          {mcpMatches && mcpCall ? (
            <McpCallSummary value={mcpCall} bridge={bridge} />
          ) : artifactImport ? (
            <ArtifactImportSummary
              value={artifactImport}
              artifact={artifactMatches ? artifact : null}
              bridge={bridge}
              current={current}
              onSelect={onSelect}
            />
          ) : change ? (
            <>
              <div className="inspector-status-row">
                <span className={`inspector-status state-${change.state}`}>
                  {fileChangeLabels[change.state]}
                </span>
                <span>{change.files.length} 個檔案</span>
              </div>
              {change.summary && !current.title.includes(change.summary) && (
                <section className="inspector-section">
                  <h2>變更原因</h2>
                  <p>{change.summary}</p>
                </section>
              )}
              <section className="inspector-section">
                <h2>檔案</h2>
                <div className="inspector-files">
                  {change.files.slice(0, 3).map((item) => (
                    <div key={`${item.operation}:${item.path}`}>
                      <FileIcon />
                      <span>{item.path}</span>
                      <small>{operationLabel[item.operation]}</small>
                    </div>
                  ))}
                  {change.files.length > 3 && <p>另有 {change.files.length - 3} 個檔案</p>}
                </div>
              </section>
              <button type="button" className="inspector-primary" onClick={() => onSelect(current)}>
                查看變更 <ArrowRightIcon />
              </button>
              <details className="inspector-technical" key={current.id}>
                <summary>技術細節</summary>
                <DiffPreview bridge={bridge} change={change} />
              </details>
            </>
          ) : command ? (
            <>
              <div className="inspector-status-row">
                <span className={`inspector-status state-${command.state}`}>
                  {command.state === "succeeded" ? "已結束" : commandLabels[command.state]}
                </span>
                {command.exit_code !== null && <span>Exit {command.exit_code}</span>}
              </div>
              <section className="inspector-section">
                <h2>命令</h2>
                <code className="inspector-command">{command.argv.join(" ")}</code>
              </section>
              <button type="button" className="inspector-primary" onClick={() => onSelect(current)}>
                查看結果 <ArrowRightIcon />
              </button>
              <details className="inspector-technical">
                <summary>最近輸出</summary>
                <CommandPreview bridge={bridge} command={command} />
              </details>
            </>
          ) : session ? (
            <>
              <div className="inspector-status-row">
                <span className={`inspector-status state-${session.state}`}>
                  {terminalLabels[session.state]}
                </span>
                <span>{session.shell}</span>
              </div>
              <section className="inspector-section">
                <h2>位置</h2>
                <code className="inspector-command">{session.cwd || "/"}</code>
              </section>
              <button type="button" className="inspector-primary" onClick={() => onSelect(current)}>
                開啟終端機 <ArrowRightIcon />
              </button>
              <details className="inspector-technical">
                <summary>最近輸出</summary>
                <TerminalOutputPreview key={session.id} bridge={bridge} session={session} />
              </details>
            </>
          ) : (
            <>
              <div className="inspector-status-row">
                <span className={`inspector-status state-${current.state}`}>
                  {activityLabel(current)}
                </span>
                {current.path && <span>{current.path}</span>}
              </div>
              {fileMatches && file && (
                <section className="inspector-section">
                  <h2>內容預覽</h2>
                  <p className="result-version">版本 {file.version.slice(0, 12)} · 執行時讀取</p>
                  {file.redacted && <p>已遮罩已知密鑰格式。</p>}
                  <pre className="result-excerpt">
                    {file.content.split("\n").slice(0, 16).join("\n")}
                  </pre>
                </section>
              )}
              {searchMatches && search && (
                <section className="inspector-section">
                  <h2>搜尋結果</h2>
                  <p>
                    找到 {search.matches.length} 筆{search.truncated ? "，僅顯示部分結果" : ""}
                    {search.skipped_files > 0 ? `；略過 ${search.skipped_files} 個檔案` : ""}。
                  </p>
                </section>
              )}
              {artifactMatches && artifact && (
                <section className="inspector-section artifact-inspector-preview">
                  <h2>預覽</h2>
                  <ArtifactPreview artifact={artifact} bridge={bridge} compact />
                </section>
              )}
              <button type="button" className="inspector-primary" onClick={() => onSelect(current)}>
                {isArtifact ? "開啟圖片" : "查看詳情"} <ArrowRightIcon />
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}

function ArtifactImportSummary({
  value,
  artifact,
  bridge,
  current,
  onSelect,
}: {
  value: ArtifactImport;
  artifact: Artifact | null;
  bridge: WorkbenchBridge;
  current: ActivityEntry;
  onSelect(entry: ActivityEntry): void;
}) {
  return (
    <>
      <div className="inspector-status-row">
        <span className={`inspector-status state-${value.state}`}>
          {artifactImportLabels[value.state]}
        </span>
        <span>{(value.byte_size / 1024).toFixed(1)} KiB</span>
      </div>
      <section className="inspector-section">
        <h2>目的檔案</h2>
        <p>{value.summary}</p>
        <code className="inspector-command">{value.path}</code>
      </section>
      <section className="inspector-section">
        <h2>已驗證內容</h2>
        <p>
          {value.mime_type} · {value.width.toLocaleString()} × {value.height.toLocaleString()}
        </p>
      </section>
      {value.state === "pending" && (
        <div className="inspector-callout">
          <InfoIcon weight="fill" />
          <span>請在原生側欄核准。</span>
        </div>
      )}
      {artifact && (
        <section className="inspector-section artifact-inspector-preview">
          <h2>安全預覽</h2>
          <ArtifactPreview artifact={artifact} bridge={bridge} compact />
        </section>
      )}
      {value.state === "applied" && current.resultId && (
        <button type="button" className="inspector-primary" onClick={() => onSelect(current)}>
          開啟圖片 <ArrowRightIcon />
        </button>
      )}
    </>
  );
}
