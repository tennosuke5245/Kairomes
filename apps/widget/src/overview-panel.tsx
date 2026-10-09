import {
  type ActivityEntry,
  type ActivitySnapshot,
  type Artifact,
  type ArtifactImport,
  type Command,
  commandActive,
  type FileResult,
  type McpCall,
  type SearchResult,
} from "@kairomes/protocol";
import { imageTypeName } from "@kairomes/protocol/image-path";
import {
  CircleNotchIcon,
  FolderOpenIcon,
  ImageIcon,
  InfoIcon,
  TrayIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { latestFocus } from "./activity-panel.tsx";
import { ArtifactPreview, artifactCaption } from "./artifact-panel.tsx";
import type { WorkbenchBridge } from "./bridge.ts";
import { commandFacts, type Fact, terminalFacts, workspaceCwd } from "./command-model.ts";
import { CommandOutput, useCommandOutput } from "./command-panel.tsx";
import {
  ArgvText,
  CwdMeta,
  Disclosure,
  FactsStrip,
  InspectorHead,
  PendingNotice,
  TechDetails,
  WorkspaceTag,
} from "./detail-parts.tsx";
import { DiffPreview } from "./diff-view.tsx";
import { friendlyError } from "./errors.ts";
import { fileLines, fileMeta, formatDimensions } from "./file-model.ts";
import { LIVE_TAIL } from "./output-view.tsx";
import { searchSummary } from "./search-model.ts";
import { TerminalOutputPreview } from "./terminal-output.tsx";
import { formatDuration } from "./time-format.ts";
import { timelineRow } from "./timeline-model.ts";
import { iconProps } from "./ui-icons.tsx";
import { useNow } from "./use-now.ts";

/** Lines of a file read shown in the overview before 開啟檔案. */
const EXCERPT_LINES = 12;

function CommandSummary({ bridge, command }: { bridge: WorkbenchBridge; command: Command }) {
  const { result, error } = useCommandOutput(bridge, command.id, 4000);
  const current =
    result?.command.id === command.id && commandActive(command) ? result.command : command;
  const now = useNow(commandActive(current));
  return (
    <>
      <FactsStrip facts={commandFacts(current, result, now)} />
      <CommandOutput command={current} result={result} error={error} tail={LIVE_TAIL} />
    </>
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
            error: friendlyError(cause, "無法載入 MCP 圖片預覽。"),
          });
      });
    return () => {
      stopped = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bridge, media.media_id, identity]);
  return (
    <figure className="artifact-preview compact">
      <div className="artifact-stage">
        {source ? (
          <img
            src={source}
            alt={`${label} 的 MCP 圖片結果`}
            width={media.width}
            height={media.height}
          />
        ) : (
          <div className="artifact-loading" role="status">
            <ImageIcon {...iconProps("lg")} />
            <span>{error || "正在載入本機預覽…"}</span>
          </div>
        )}
      </div>
      <p className="artifact-caption">
        {formatDimensions(media.width, media.height)} · {imageTypeName(media.mime_type)}
      </p>
    </figure>
  );
}

function McpCallSummary({
  value,
  bridge,
  reason,
}: {
  value: McpCall;
  bridge: WorkbenchBridge;
  /** Already shown above as the row's reason; a text block saying the same is not repeated. */
  reason?: string;
}) {
  const label = value.tool.title ?? value.tool.name;
  const images = value.content.filter(
    (item): item is Extract<McpCall["content"][number], { type: "image" }> => item.type === "image",
  );
  const text = value.content.filter(
    (item): item is Extract<McpCall["content"][number], { type: "text" }> =>
      item.type === "text" && item.text.trim() !== reason?.trim(),
  );
  const facts: Fact[] = [
    { label: "伺服器", value: value.tool.server_name },
    { label: "耗時", value: formatDuration(value.duration_ms) },
  ];
  return (
    <>
      <FactsStrip facts={facts} />
      {images.length > 0 && (
        <div className="mcp-media-grid">
          {images.map((media) => (
            <McpImagePreview key={media.media_id} bridge={bridge} media={media} label={label} />
          ))}
        </div>
      )}
      {text.length > 0 && (
        <pre className="k-codebox insp-pre">{text.map((item) => item.text).join("\n\n")}</pre>
      )}
      {value.truncated && (
        <p className="k-notice" data-tone="warning" role="status">
          <InfoIcon {...iconProps("lg")} />
          <span className="k-notice__body">結果超過顯示上限，已省略部分內容。</span>
        </p>
      )}
      <Disclosure summary="呼叫參數">
        <pre className="k-codebox insp-pre">{JSON.stringify(value.arguments_preview, null, 2)}</pre>
      </Disclosure>
      {value.structured_content && (
        <Disclosure summary="結構化結果">
          <pre className="k-codebox insp-pre">
            {JSON.stringify(value.structured_content, null, 2)}
          </pre>
        </Disclosure>
      )}
    </>
  );
}

/**
 * What an image import waits for, as text only: the image and the decision both belong to the
 * trusted side panel, so this view has no upload or approve control.
 */
function ImportStateNotice({ value }: { value: ArtifactImport }) {
  if (value.state === "pending") return <PendingNotice />;
  if (value.state === "awaiting_file")
    return (
      <p className="k-notice" data-tone="brand" role="status">
        <TrayIcon {...iconProps("lg")} />
        {/* The pill above already says 等待圖片; the notice only adds where to act. */}
        <span className="k-notice__body">請在 Kairomes 側欄提供圖片</span>
      </p>
    );
  if (value.state === "preparing" || value.state === "applying")
    return (
      <p className="k-notice" data-tone="running" role="status">
        <CircleNotchIcon {...iconProps("lg")} className="k-icon k-spin" />
        <span className="k-notice__body">
          {value.state === "preparing" ? "正在接收並核對圖片…" : "正在寫入圖片…"}
        </span>
      </p>
    );
  return null;
}

/** The written file, only when it is this import's own target and verified version. */
export function importedArtifact(value: ArtifactImport, loaded: Artifact | null) {
  if (value.state !== "applied" || value.write_outcome !== "written_verified") return null;
  const candidate = loaded ?? value.artifact;
  return candidate &&
    candidate.workspace_id === value.workspace_id &&
    candidate.path === value.path &&
    candidate.version === value.version
    ? candidate
    : null;
}

function ArtifactImportSummary({
  value,
  artifact,
  bridge,
}: {
  value: ArtifactImport;
  artifact: Artifact | null;
  bridge: WorkbenchBridge;
}) {
  const written = importedArtifact(value, artifact);
  return (
    <>
      <ImportStateNotice value={value} />
      <FactsStrip
        facts={(value.mime_type === null ||
        value.byte_size === null ||
        value.width === null ||
        value.height === null
          ? []
          : artifactCaption({
              ...value,
              mime_type: value.mime_type,
              byte_size: value.byte_size,
              width: value.width,
              height: value.height,
            })
        ).map((part, index) => ({
          label: ["尺寸", "格式", "大小"][index] ?? "",
          value: part,
        }))}
      />
      {/* The inspector title already names the target path (匯入圖片 <path>). */}
      {written && <ArtifactPreview artifact={written} bridge={bridge} compact />}
    </>
  );
}

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
  const now = useNow(
    current?.state === "pending" ||
      current?.state === "awaiting_file" ||
      (!!command && commandActive(command)) ||
      session?.state === "running",
  );
  const loaded = !!current?.resultId && current.resultId === loadedResultId;
  const fileMatches =
    loaded &&
    current?.tool === "file_read" &&
    file?.workspace_id === current.workspaceId &&
    file?.path === current.path;
  const searchMatches =
    loaded && current?.tool === "file_search" && search?.workspace_id === current.workspaceId;
  const isArtifact =
    current?.tool === "artifact_preview" || current?.tool === "artifact_import_request";
  const artifactMatches =
    loaded &&
    isArtifact &&
    artifact?.workspace_id === current?.workspaceId &&
    artifact?.path === current?.path;
  const isMcp = current?.tool === "mcp_tool_call" || current?.tool === "mcp_read_call";
  const mcpMatches = loaded && isMcp;

  if (!current)
    return (
      <section className="wb-panel" aria-label="目前動作摘要">
        <div className="k-empty wb-empty">
          <span className="k-empty__icon" aria-hidden="true">
            <FolderOpenIcon {...iconProps("xl")} />
          </span>
          <h2 className="k-empty__title">還沒有動作</h2>
          <p className="k-empty__text">ChatGPT 讀取或修改專案時會顯示在這裡。</p>
          <button type="button" className="k-btn k-btn--secondary" onClick={onFiles}>
            <FolderOpenIcon {...iconProps("md")} />
            瀏覽專案
          </button>
        </div>
      </section>
    );

  const row = timelineRow(current, {
    snapshot,
    now,
    workspaceName: workspaceId ? undefined : (id) => workspaceName(id),
  });
  const cwd = command ? workspaceCwd(command.cwd) : session ? workspaceCwd(session.cwd) : undefined;
  const open = (label: string) => (
    <button
      type="button"
      className="k-btn k-btn--primary insp-open"
      onClick={() => onSelect(current)}
    >
      {label}
    </button>
  );
  let body: ReactNode;
  if (mcpMatches && mcpCall)
    body = <McpCallSummary value={mcpCall} bridge={bridge} reason={row.reason} />;
  else if (artifactImport)
    body = (
      <>
        <ArtifactImportSummary
          value={artifactImport}
          artifact={artifactMatches ? artifact : null}
          bridge={bridge}
        />
        {artifactImport.state === "applied" && current.resultId && open("開啟圖片")}
      </>
    );
  else if (change)
    body = (
      <>
        {change.state === "pending" && <PendingNotice />}
        <DiffPreview key={change.id} bridge={bridge} change={change} budget={60} />
        {open("查看變更")}
      </>
    );
  else if (command)
    body = (
      <>
        {command.state === "pending" && <PendingNotice />}
        <CommandSummary key={command.id} bridge={bridge} command={command} />
        {open("查看完整結果")}
      </>
    );
  else if (session)
    body = (
      <>
        {session.state === "pending" && <PendingNotice />}
        <FactsStrip facts={terminalFacts(session, now)} />
        <TerminalOutputPreview key={session.id} bridge={bridge} session={session} />
        {open("開啟終端機")}
      </>
    );
  else
    body = (
      <>
        {fileMatches && file && (
          <div className="insp-excerpt">
            <p className="insp-excerpt__meta">{fileMeta(file, { historical: true }).join(" · ")}</p>
            <div className="fv-code">
              {fileLines(file)
                .slice(0, EXCERPT_LINES)
                .map((line) => (
                  <div key={line.number} className="fv-line">
                    <span className="fv-ln" aria-hidden="true">
                      {line.number}
                    </span>
                    <span className="fv-tx">{line.text || " "}</span>
                  </div>
                ))}
            </div>
          </div>
        )}
        {searchMatches && search && <p className="insp-note">{searchSummary(search)}</p>}
        {artifactMatches && artifact && (
          <ArtifactPreview artifact={artifact} bridge={bridge} compact />
        )}
        {row.actionable &&
          open(
            isArtifact
              ? "開啟圖片"
              : current.tool === "file_read"
                ? "開啟檔案"
                : current.tool === "file_search"
                  ? "查看搜尋結果"
                  : "查看詳情",
          )}
        {fileMatches && file && <TechDetails rows={[["版本", file.version]]} />}
      </>
    );

  return (
    <section className="wb-panel" aria-label="目前動作摘要">
      <InspectorHead
        icon={row.icon}
        verb={row.verb}
        code={command?.argv.length ? <ArgvText argv={command.argv} /> : row.code}
        state={row.state}
        meta={[
          row.workspace && <WorkspaceTag name={row.workspace.name} hue={row.workspace.hue} />,
          row.time,
          cwd && <CwdMeta cwd={cwd} />,
        ]}
      />
      <div className="insp-body">
        {row.reason && (
          <p className="insp-reason" data-tone={row.state.dataTone}>
            {row.reason}
          </p>
        )}
        {body}
      </div>
    </section>
  );
}
