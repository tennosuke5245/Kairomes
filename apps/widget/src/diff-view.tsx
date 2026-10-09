import type { FileChange } from "@kairomes/protocol";
import { diffPathParts } from "@kairomes/protocol/diff-lines";
import { ArrowUDownLeftIcon, CaretDownIcon, WarningIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkbenchBridge } from "./bridge.ts";
import { StatusLine } from "./detail-parts.tsx";
import {
  DIFF_STATUS,
  diffNumbered,
  diffSections,
  diffSign,
  diffTotals,
  parseChangeDiff,
} from "./diff-model.ts";
import { friendlyError } from "./errors.ts";
import { requireFileChangeResult } from "./result-identity.ts";
import { iconProps } from "./ui-icons.tsx";

/**
 * The one diff renderer (overview and file-change detail): a `.k-diff` section per file with
 * a status pill, +N −M, old and new line gutters (none for exact replacements, which carry no
 * line numbers) and hunk labels. Wrap is on by default. A truncated diff says so, and its
 * counts read 至少, so it is never presented as complete.
 */
export function DiffView({
  diff,
  truncated,
  budget = 400,
  totals = true,
  fileCount,
  focusPath,
}: {
  diff: string;
  truncated: boolean;
  /** 2 個檔案 · +A −D in the bar; off where a stats strip already says it. */
  totals?: boolean;
  /** Rows rendered before each file offers 顯示其餘 N 行. */
  budget?: number;
  /** Files in the change; a cut diff may not reach all of them. */
  fileCount?: number;
  /** A file chosen in a list: its section is scrolled into view once the diff renders. */
  focusPath?: string;
}) {
  const parsed = useMemo(() => parseChangeDiff(diff, truncated), [diff, truncated]);
  const [wrap, setWrap] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const sections = diffSections(parsed, budget, expanded);
  const focused = useRef<HTMLElement>(null);
  // The first file already sits under the change's head, so only later files scroll.
  const focusKey = sections.find(
    (section, index) => index > 0 && section.file.path === focusPath,
  )?.key;
  useEffect(() => {
    if (focusKey) focused.current?.scrollIntoView?.({ block: "start" });
  }, [focusKey]);
  return (
    <div className="wb-diff">
      <div className="wb-diff__bar">
        <span className="k-meta">{totals ? diffTotals(parsed, fileCount) : ""}</span>
        <button
          type="button"
          className="k-btn k-btn--quiet k-btn--sm"
          aria-pressed={wrap}
          onClick={() => setWrap((value) => !value)}
        >
          <ArrowUDownLeftIcon {...iconProps("sm")} />
          換行
        </button>
      </div>
      {parsed.truncated && (
        <p className="k-notice wb-diff__notice" data-tone="warning" role="status">
          <WarningIcon {...iconProps("lg")} />
          <span className="k-notice__body">差異只顯示部分內容。</span>
        </p>
      )}
      {sections.map(({ key, file, lines, hidden }) => {
        const status = DIFF_STATUS[file.status];
        const path = diffPathParts(file.path);
        return (
          <section
            key={key}
            ref={key === focusKey ? focused : undefined}
            className="k-diff"
            data-wrap={wrap ? undefined : "off"}
            data-numbers={diffNumbered(file) ? undefined : "off"}
            aria-label={file.path || "差異"}
          >
            <div className="k-diff__head">
              <span className="k-diff__path">
                {file.previousPath && (
                  <span className="k-diff__dir">
                    {file.previousPath}
                    {" → "}
                  </span>
                )}
                <span className="k-diff__dir">{path.directory}</span>
                <span className="k-diff__file">{path.name || "差異"}</span>
              </span>
              <span className="k-pill" data-tone={status.tone}>
                {status.label}
              </span>
              <span className="k-diff__stat">
                {file.truncated && <span className="wb-diff__partial">至少</span>}
                <span className="k-diff__plus">+{file.additions}</span>
                <span className="k-diff__minus">−{file.deletions}</span>
              </span>
            </div>
            {file.binary ? (
              <p className="wb-diff__binary">二進位檔案，沒有文字差異。</p>
            ) : (
              <div className="k-diff__body">
                {lines.map((line, index) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: diff rows have no identity beyond their position.
                    key={index}
                    className="k-diff__line"
                    data-kind={line.kind === "context" ? undefined : line.kind}
                  >
                    <span className="k-diff__ln k-diff__ln--old">{line.oldLine}</span>
                    <span className="k-diff__ln">{line.newLine}</span>
                    <span className="k-diff__sign" aria-hidden="true">
                      {diffSign(line.kind)}
                    </span>
                    <span className="k-diff__code">
                      {line.kind === "hunk" ? (line.label ?? line.text) : line.text || " "}
                    </span>
                  </div>
                ))}
                {file.truncated && <p className="wb-diff__cut">後續差異未提供。</p>}
              </div>
            )}
            {hidden > 0 && (
              <button
                type="button"
                className="k-diff__more"
                onClick={() => setExpanded((prior) => new Set([...prior, key]))}
              >
                <CaretDownIcon {...iconProps("sm")} />
                顯示其餘 {hidden} 行
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Loads one change's diff once (identity-checked) and renders it with DiffView. */
export function DiffPreview({
  bridge,
  change,
  budget = 80,
}: {
  bridge: WorkbenchBridge;
  change: FileChange;
  budget?: number;
}) {
  const identity = `${change.workspace_id}:${change.id}`;
  const [state, setState] = useState({
    identity,
    diff: "",
    truncated: false,
    error: "",
    done: false,
  });
  const current =
    state.identity === identity
      ? state
      : { identity, diff: "", truncated: false, error: "", done: false };
  useEffect(() => {
    let stopped = false;
    setState({ identity, diff: "", truncated: false, error: "", done: false });
    void bridge
      .call("file_change_poll", { change_id: change.id })
      .then((data) => {
        if (stopped) return;
        const result = requireFileChangeResult(data, {
          id: change.id,
          workspaceId: change.workspace_id,
        });
        setState({
          identity,
          diff: result.diff,
          truncated: result.diff_truncated,
          error: "",
          done: true,
        });
      })
      .catch((cause) => {
        if (!stopped)
          setState({
            identity,
            diff: "",
            truncated: false,
            error: friendlyError(cause, "無法取得差異。"),
            done: true,
          });
      });
    return () => {
      stopped = true;
    };
  }, [bridge, change.id, change.workspace_id, identity]);
  if (current.error)
    return (
      <p className="k-notice" data-tone="danger" role="alert">
        <span className="k-notice__body">{current.error}</span>
      </p>
    );
  if (!current.done) return <StatusLine>正在取得差異…</StatusLine>;
  if (!current.diff) return <StatusLine>沒有可顯示的差異。</StatusLine>;
  return (
    <DiffView
      diff={current.diff}
      truncated={current.truncated}
      budget={budget}
      fileCount={change.files.length}
    />
  );
}
