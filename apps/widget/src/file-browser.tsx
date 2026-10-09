import type { FileResult, SearchResult, Snapshot } from "@kairomes/protocol";
import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowUDownLeftIcon,
  CaretDownIcon,
  CaretRightIcon,
  FileCodeIcon,
  FolderIcon,
  FunnelSimpleIcon,
  HouseIcon,
  ImageIcon,
  MagnifyingGlassIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import { CopyButton, MetaLine, StatusLine, TechDetails, WorkspaceTag } from "./detail-parts.tsx";
import {
  FILE_PAGE,
  FILTER_MIN_ENTRIES,
  fileLines,
  fileMeta,
  fileRange,
  filterEntries,
  isImagePath,
  nextPageLine,
  pathCrumbs,
  splitPath,
} from "./file-model.ts";
import type { FilesTab } from "./files-state.ts";
import { moveTab } from "./host-model.ts";
import { useRovingList } from "./record-list.tsx";
import { groupMatches, HITS_PER_FILE, highlightSnippet, searchSummary } from "./search-model.ts";
import { iconProps } from "./ui-icons.tsx";

// The one file browser (C4), search view (C3) and file viewer (C5), shared by the workbench
// inspector and the ChatGPT host viewer. Request ids and result-identity guards stay with
// the caller; these components only render what they are given.

type Entry = Snapshot["entries"][number];

/** The project being browsed, named where the switcher does not (全部專案). */
export interface BrowsedProject {
  id: string;
  name: string;
  hue: number;
}

/** Breadcrumbs below the project root. Long paths collapse the middle into `…`. */
function Crumbs({
  path,
  project,
  disabled,
  onBrowse,
}: {
  path: string;
  project?: string;
  disabled: boolean;
  onBrowse(path: string): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const crumbs = pathCrumbs(path);
  const collapse = !expanded && crumbs.length > 3;
  const shown = collapse ? crumbs.slice(-2) : crumbs;
  const root = project ? `${project} 專案根目錄` : "專案根目錄";
  return (
    <nav className="fb-crumbs" aria-label="資料夾路徑">
      <ol className="k-crumbs">
        <li>
          {crumbs.length ? (
            <button
              type="button"
              aria-label={root}
              title={root}
              disabled={disabled}
              onClick={() => onBrowse("")}
            >
              <HouseIcon {...iconProps("md")} />
            </button>
          ) : (
            <span aria-current="page" className="fb-crumbs__root">
              <HouseIcon {...iconProps("md")} />
              <span className="k-sr-only">{root}</span>
            </span>
          )}
        </li>
        {collapse && (
          <li>
            <button
              type="button"
              aria-label="顯示完整路徑"
              title={crumbs
                .slice(0, -2)
                .map((crumb) => crumb.name)
                .join("/")}
              onClick={() => setExpanded(true)}
            >
              …
            </button>
          </li>
        )}
        {shown.map((crumb, index) => (
          <li key={crumb.path}>
            {index === shown.length - 1 ? (
              <span aria-current="page">{crumb.name}</span>
            ) : (
              <button type="button" disabled={disabled} onClick={() => onBrowse(crumb.path)}>
                {crumb.name}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function EntryIcon({ entry }: { entry: Entry }) {
  if (entry.kind === "directory")
    return <FolderIcon {...iconProps("lg")} className="k-icon k-row__lead" />;
  if (isImagePath(entry.path))
    return <ImageIcon {...iconProps("lg")} className="k-icon k-row__lead" />;
  return <FileCodeIcon {...iconProps("lg")} className="k-icon k-row__lead" />;
}

function FolderList({
  snapshot,
  busy,
  disabled,
  currentPath,
  onBrowse,
  onOpen,
}: {
  snapshot: Snapshot;
  busy: boolean;
  disabled: boolean;
  currentPath?: string;
  onBrowse(path: string): void;
  onOpen(entry: Entry): void;
}) {
  const [filter, setFilter] = useState({ path: snapshot.path, text: "" });
  const text = filter.path === snapshot.path ? filter.text : "";
  const list = useRef<HTMLUListElement>(null);
  const onKeyDown = useRovingList(list);
  const entries = filterEntries(snapshot.entries, text);
  return (
    <>
      {snapshot.entries.length >= FILTER_MIN_ENTRIES && (
        <label className="k-field fb-filter">
          <FunnelSimpleIcon {...iconProps("md")} />
          <input
            className="k-input"
            aria-label="篩選這個資料夾"
            placeholder={`篩選 ${snapshot.entries.length} 個項目`}
            value={text}
            onChange={(event) => setFilter({ path: snapshot.path, text: event.target.value })}
          />
        </label>
      )}
      {entries.length > 0 && (
        <ul
          ref={list}
          className="k-list k-card fb-list"
          aria-label="檔案與資料夾"
          onKeyDown={onKeyDown}
        >
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className="k-row fb-row"
                data-roving-item=""
                aria-current={entry.path === currentPath ? "true" : undefined}
                disabled={disabled || busy}
                onClick={() => (entry.kind === "directory" ? onBrowse(entry.path) : onOpen(entry))}
              >
                <EntryIcon entry={entry} />
                <span className="k-row__title">{entry.name}</span>
                {entry.kind === "directory" && (
                  <span className="k-row__trail">
                    <CaretRightIcon {...iconProps("sm")} />
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!snapshot.entries.length && <p className="fb-note">這個資料夾沒有項目。</p>}
      {snapshot.entries.length > 0 && !entries.length && (
        <p className="fb-note">沒有符合「{text.trim()}」的項目。</p>
      )}
      {snapshot.truncated && (
        <p className="fb-note" data-tone="warning">
          只顯示前 {snapshot.entries.length} 個項目。
        </p>
      )}
    </>
  );
}

function SearchGroups({
  search,
  busy,
  disabled,
  onOpenHit,
}: {
  search: SearchResult;
  busy: boolean;
  disabled: boolean;
  onOpenHit(path: string, line: number): void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const groups = groupMatches(search.matches);
  const caseSensitive = search.case_sensitive ?? false;
  if (!groups.length) return <p className="fb-note">沒有符合「{search.query}」的結果。</p>;
  return (
    <div className="srch-groups">
      {groups.map((group) => {
        const expanded = open.has(group.path);
        const hits = expanded ? group.hits : group.hits.slice(0, HITS_PER_FILE);
        const rest = group.hits.length - hits.length;
        return (
          <section key={group.path} className="k-card srch-group" aria-label={group.path}>
            <div className="hit-file">
              <FileCodeIcon {...iconProps("md")} />
              <span className="hit-file__name">
                <span className="k-mono">{group.name}</span>
                {group.directory && <span className="hit-file__dir">{group.directory}</span>}
              </span>
              <span className="k-badge" data-tone="neutral">
                {group.hits.length}
                <span className="k-sr-only"> 筆</span>
              </span>
            </div>
            {hits.map((hit) => (
              <button
                type="button"
                key={`${hit.line}:${hit.text}`}
                className="hit"
                disabled={disabled || busy}
                aria-label={`${group.path} 第 ${hit.line} 行`}
                onClick={() => onOpenHit(group.path, hit.line)}
              >
                <span className="hit__ln">{hit.line}</span>
                <span className="k-snippet">
                  {highlightSnippet(hit.text, search.query, { caseSensitive }).map(
                    (segment, index) =>
                      segment.mark ? (
                        // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional.
                        <mark key={index} className="k-mark">
                          {segment.text}
                        </mark>
                      ) : (
                        segment.text
                      ),
                  )}
                </span>
              </button>
            ))}
            {rest > 0 && (
              <div className="hit-more">
                <button
                  type="button"
                  className="k-btn k-btn--quiet k-btn--sm"
                  onClick={() => setOpen((prior) => new Set([...prior, group.path]))}
                >
                  顯示其餘 {rest} 筆
                  <CaretDownIcon {...iconProps("sm")} />
                </button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function FileBrowser({
  tab,
  onTab,
  snapshot,
  search,
  query,
  onQuery,
  caseSensitive,
  onCaseSensitive,
  onSearch,
  onClearSearch,
  onRefresh,
  project,
  busy,
  disabled,
  searchFieldRef,
  onBrowse,
  onOpenEntry,
  onOpenHit,
  currentPath,
  emptyText,
}: {
  tab: FilesTab;
  onTab(tab: FilesTab): void;
  snapshot: Snapshot | null;
  search: SearchResult | null;
  query: string;
  onQuery(value: string): void;
  caseSensitive: boolean;
  onCaseSensitive(value: boolean): void;
  onSearch(): void;
  /** 清除搜尋文字: empties the field and drops results that no longer match it. */
  onClearSearch(): void;
  /** Reloads the folder list (host viewer). */
  onRefresh?(): void;
  /** Named beside the tabs when the switcher does not hold one project. */
  project?: BrowsedProject;
  busy: boolean;
  disabled: boolean;
  searchFieldRef?: Ref<HTMLInputElement>;
  onBrowse(path: string): void;
  onOpenEntry(entry: Entry): void;
  onOpenHit(path: string, line: number): void;
  /** The file last opened, marked in its folder. */
  currentPath?: string;
  /** Shown instead of the list when there is no project to browse. */
  emptyText?: string;
}) {
  const id = useId();
  const tabs = useRef<HTMLDivElement>(null);
  const panelId = `${id}-panel`;
  const tabId = (value: FilesTab) => `${id}-${value}`;
  const summary = search && search.matches.length > 0 ? searchSummary(search) : "";
  return (
    <section className="fb" aria-label="專案檔案">
      {/* WAI-ARIA tabs with manual activation, like the host tabs: ←/→, Home and End move. */}
      <div
        ref={tabs}
        className="k-tabs fb-tabs"
        role="tablist"
        aria-label="檔案檢視"
        onKeyDown={(event) => {
          const buttons = [...(tabs.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
          const index = buttons.indexOf(event.target as HTMLElement);
          const next = index < 0 ? undefined : moveTab(event.key, index, buttons.length);
          if (next === undefined) return;
          event.preventDefault();
          buttons[next]?.focus();
        }}
      >
        {(["files", "search"] as const).map((value) => (
          <button
            key={value}
            id={tabId(value)}
            type="button"
            role="tab"
            className="k-tab"
            aria-selected={tab === value}
            aria-controls={panelId}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => onTab(value)}
          >
            {value === "files" ? "瀏覽" : "搜尋"}
          </button>
        ))}
        {project && (
          <span className="fb-project">
            <WorkspaceTag name={project.name} hue={project.hue} />
          </span>
        )}
        {onRefresh && (
          <button
            type="button"
            className="k-btn k-btn--quiet k-btn--icon k-btn--sm fb-refresh"
            aria-label="重新整理資料夾"
            title="重新整理資料夾"
            disabled={busy}
            onClick={onRefresh}
          >
            <ArrowClockwiseIcon {...iconProps("md")} />
          </button>
        )}
      </div>
      {tab === "files" ? (
        <div id={panelId} className="fb-body" role="tabpanel" aria-labelledby={tabId("files")}>
          {emptyText ? (
            <p className="fb-note">{emptyText}</p>
          ) : (
            <>
              {snapshot && (
                <Crumbs
                  path={snapshot.path}
                  project={project?.name}
                  disabled={disabled || busy}
                  onBrowse={onBrowse}
                />
              )}
              {busy && <StatusLine>正在讀取…</StatusLine>}
              {snapshot ? (
                <FolderList
                  key={snapshot.path}
                  snapshot={snapshot}
                  busy={busy}
                  disabled={disabled}
                  currentPath={currentPath}
                  onBrowse={onBrowse}
                  onOpen={onOpenEntry}
                />
              ) : (
                !busy && <StatusLine>正在讀取…</StatusLine>
              )}
            </>
          )}
        </div>
      ) : (
        <div id={panelId} className="fb-body" role="tabpanel" aria-labelledby={tabId("search")}>
          <form
            className="srch-form"
            onSubmit={(event) => {
              event.preventDefault();
              onSearch();
            }}
          >
            <label className="k-field srch-field">
              <MagnifyingGlassIcon {...iconProps("md")} />
              <input
                ref={searchFieldRef}
                className="k-input"
                type="search"
                enterKeyHint="search"
                aria-label="搜尋專案內容"
                placeholder="搜尋專案內容"
                maxLength={200}
                value={query}
                disabled={disabled}
                onChange={(event) => onQuery(event.target.value)}
              />
              {query && (
                <button
                  type="button"
                  className="k-btn k-btn--quiet k-btn--icon k-btn--sm srch-clear"
                  aria-label="清除搜尋文字"
                  onClick={(event) => {
                    // The button goes away with the text; focus stays in the field.
                    event.currentTarget.closest("label")?.querySelector("input")?.focus();
                    onClearSearch();
                  }}
                >
                  <XIcon {...iconProps("md")} />
                </button>
              )}
            </label>
            <button
              type="button"
              className="k-chip srch-case"
              aria-pressed={caseSensitive}
              disabled={disabled}
              onClick={() => onCaseSensitive(!caseSensitive)}
            >
              區分大小寫
            </button>
          </form>
          {/* Under the field, so it is read before the results; a no-match line says it alone. */}
          <p className="srch-summary" role="status">
            {summary}
          </p>
          {busy && <StatusLine>正在搜尋…</StatusLine>}
          {search ? (
            <SearchGroups
              key={`${search.query}:${search.case_sensitive ? 1 : 0}`}
              search={search}
              busy={busy}
              disabled={disabled}
              onOpenHit={onOpenHit}
            />
          ) : (
            !busy && <p className="fb-note">輸入文字後按 Enter 搜尋。</p>
          )}
        </div>
      )}
    </section>
  );
}

export function FileViewer({
  file,
  focusLine,
  historical = false,
  endsWithNewline,
  project,
  busy,
  disabled,
  backLabel,
  backRef,
  onBack,
  onReload,
  onPage,
  actions,
}: {
  file: FileResult;
  /** A search hit: highlighted and scrolled into view. */
  focusLine?: number;
  historical?: boolean;
  /** Whether the file ends with a newline, once a read of its last line told (fileLineCount). */
  endsWithNewline?: boolean;
  /** Named in the meta line when the switcher does not hold one project. */
  project?: BrowsedProject;
  busy: boolean;
  disabled: boolean;
  backLabel?: string;
  backRef?: Ref<HTMLButtonElement>;
  onBack?(): void;
  onReload?(): void;
  onPage(start: number): void;
  /** Extra actions after the built-in ones (the host viewer's 請 ChatGPT 說明). */
  actions?: ReactNode;
}) {
  const [wrap, setWrap] = useState(false);
  const focusRow = useRef<HTMLDivElement>(null);
  const lines = fileLines(file, focusLine);
  const range = fileRange(file, endsWithNewline);
  const next = nextPageLine(file, endsWithNewline);
  const { directory, name } = splitPath(file.path);
  useEffect(() => {
    if (focusLine === undefined) return;
    focusRow.current?.scrollIntoView?.({ block: "center" });
  }, [focusLine]);
  return (
    <section className="fv" aria-label={`檔案內容 ${file.path}`}>
      <header className="fv-head">
        {onBack && (
          <button
            ref={backRef}
            type="button"
            className="k-btn k-btn--quiet k-btn--icon fv-back"
            aria-label={backLabel}
            title={backLabel}
            onClick={onBack}
          >
            <ArrowLeftIcon {...iconProps("lg")} />
          </button>
        )}
        <div className="fv-title">
          <h2 className="fv-path">
            {directory && <span className="fv-path__dir">{directory}/</span>}
            <span className="fv-path__name">{name}</span>
          </h2>
          <MetaLine
            items={[
              project && <WorkspaceTag name={project.name} hue={project.hue} />,
              ...fileMeta(file, { historical, endsWithNewline }),
            ]}
            className="fv-meta"
          />
        </div>
      </header>
      <div className="fv-actions">
        <CopyButton label="複製路徑" text={() => file.path} />
        <CopyButton label={range.whole ? "複製內容" : "複製這頁"} text={() => file.content} />
        <button
          type="button"
          className="k-btn k-btn--quiet k-btn--sm"
          aria-pressed={wrap}
          onClick={() => setWrap((value) => !value)}
        >
          <ArrowUDownLeftIcon {...iconProps("sm")} />
          換行
        </button>
        {onReload && (
          <button
            type="button"
            className="k-btn k-btn--quiet k-btn--sm"
            disabled={disabled || busy}
            onClick={onReload}
          >
            重新讀取
          </button>
        )}
        {actions}
      </div>
      {busy && <StatusLine>正在讀取…</StatusLine>}
      <div
        key={`${file.path}:${file.start_line}:${file.version}`}
        className="fv-code"
        data-wrap={wrap ? "on" : undefined}
      >
        {lines.map((line) => (
          <div
            key={line.number}
            ref={line.focus ? focusRow : undefined}
            className="fv-line"
            data-focus={line.focus ? "" : undefined}
          >
            <span className="fv-ln" aria-hidden="true">
              {line.number}
            </span>
            <span className="fv-tx">{line.text || " "}</span>
          </div>
        ))}
      </div>
      {(file.start_line > 1 || next !== null) && (
        <nav className="fv-pager" aria-label="分頁">
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            disabled={disabled || busy || file.start_line <= 1}
            onClick={() => onPage(Math.max(1, file.start_line - FILE_PAGE))}
          >
            上一頁
          </button>
          <span className="k-meta">
            第 {range.start}–{range.end} 行
          </span>
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            disabled={disabled || busy || next === null}
            onClick={() => next !== null && onPage(next)}
          >
            下一頁
          </button>
        </nav>
      )}
      <TechDetails rows={[["版本", file.version]]} />
    </section>
  );
}
