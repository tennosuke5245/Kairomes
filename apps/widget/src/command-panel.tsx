import { type Command, type CommandResult, commandActive } from "@kairomes/protocol";
import { toneFor } from "@kairomes/protocol/ui-state";
import { TerminalIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { WorkbenchBridge } from "./bridge.ts";
import {
  commandFacts,
  commandNeverRan,
  formatArgv,
  notRunReason,
  tailText,
  workspaceCwd,
} from "./command-model.ts";
import {
  ArgvText,
  CopyButton,
  CwdMeta,
  FactsStrip,
  InspectorHead,
  PendingNotice,
  StatusLine,
  TechDetails,
  WorkspaceTag,
} from "./detail-parts.tsx";
import { friendlyError } from "./errors.ts";
import { DONE_TAIL, LIVE_TAIL, OutputView } from "./output-view.tsx";
import { RecordList, type SubBack, SubBar, useListReturn } from "./record-list.tsx";
import { commandRecord } from "./record-model.ts";
import { commandEvidence, outputEvidence } from "./result-evidence.ts";
import { requireCommandResult } from "./result-identity.ts";
import { relativeTime } from "./time-format.ts";
import { workspaceHue } from "./timeline-model.ts";
import { ResultError } from "./tool-result.ts";
import { iconProps } from "./ui-icons.tsx";
import { useNow } from "./use-now.ts";

export function useCommandOutput(bridge: WorkbenchBridge, id: string, limit = 65536) {
  const [state, setState] = useState<{ id: string; result?: CommandResult; error: string }>({
    id,
    error: "",
  });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let out = 0,
      err = 0,
      stdout = "",
      stderr = "";
    let clippedOut = false,
      clippedErr = false,
      backoff = 1000;
    setState({ id, error: "" });
    const tail = (text: string) => tailText(text, limit).text;
    const poll = async () => {
      try {
        const data = await bridge.call("command_poll", {
          command_id: id,
          stdout_cursor: out,
          stderr_cursor: err,
        });
        if (stopped) return;
        const next = requireCommandResult(data, id);
        out = next.stdout_cursor;
        err = next.stderr_cursor;
        clippedOut ||= next.stdout_truncated || stdout.length + next.stdout.length > limit;
        clippedErr ||= next.stderr_truncated || stderr.length + next.stderr.length > limit;
        stdout = tail(stdout + next.stdout);
        stderr = tail(stderr + next.stderr);
        setState({
          id,
          result: {
            ...next,
            stdout,
            stderr,
            stdout_truncated: clippedOut,
            stderr_truncated: clippedErr,
          },
          error: "",
        });
        backoff = 1000;
        if (next.has_more || !next.output_complete)
          timer = setTimeout(() => void poll(), next.has_more ? 50 : 750);
      } catch (cause) {
        if (stopped) return;
        setState((previous) => ({
          id,
          result: previous.id === id ? previous.result : undefined,
          error: friendlyError(cause, "無法讀取命令結果。"),
        }));
        if (cause instanceof ResultError && cause.code === "COMMAND_NOT_FOUND") return;
        timer = setTimeout(() => void poll(), backoff);
        backoff = Math.min(5000, backoff * 2);
      }
    };
    if (id) void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bridge, id, limit]);
  return state.id === id
    ? { result: state.result, error: state.error }
    : { result: undefined, error: "" };
}

/**
 * The output of one command: error, then the `.k-output` tail (none while pending). A command
 * that never ran has no output, so it shows why instead.
 */
export function CommandOutput({
  command = undefined,
  result,
  error,
  tail,
}: {
  /** The live record; it decides whether the command ever ran before a result loads. */
  command?: Command;
  result?: CommandResult;
  error: string;
  tail?: number;
}) {
  const record = command ?? result?.command;
  if (record && commandNeverRan(record))
    return (
      <p className="insp-reason" data-tone={toneFor("command", record.state).dataTone}>
        {notRunReason(record)}
      </p>
    );
  const running = !!result && commandActive(result.command);
  const evidence = result ? outputEvidence(result, !!error) : undefined;
  // A finished run is labelled as a run-time result: exit 0 never vouches for current files.
  const status = running
    ? evidence
    : [evidence === "輸出完整" ? undefined : evidence, "執行時結果"].filter(Boolean).join(" · ");
  return (
    <>
      {error && (
        <p className="k-notice" data-tone="danger" role="alert">
          <WarningCircleIcon {...iconProps("lg")} />
          <span className="k-notice__body">{error}</span>
        </p>
      )}
      {!result ? (
        !error && <StatusLine>正在讀取輸出…</StatusLine>
      ) : result.command.state === "pending" ? null : (
        <OutputView
          stdout={result.stdout}
          stderr={result.stderr}
          tail={tail ?? (running ? LIVE_TAIL : DONE_TAIL)}
          status={status}
          evidence={commandEvidence(result, !!error) ? "complete" : "unconfirmed"}
          numbered={!result.stdout_truncated && !result.stderr_truncated}
          empty={result.output_complete ? "沒有輸出。" : "等待輸出…"}
        />
      )}
    </>
  );
}

function CommandDetail({
  command,
  result,
  error,
  now,
  workspaceName,
  actionError,
  cancelBusy,
  onCancel,
}: {
  command: Command;
  result?: CommandResult;
  error: string;
  now: number;
  workspaceName?: (id: string) => string | undefined;
  actionError: string;
  cancelBusy: boolean;
  /** Cancel is the only negative action the workbench offers for a command. */
  onCancel?(): void;
}) {
  const argv = formatArgv(command.argv);
  const workspace = workspaceName?.(command.workspace_id);
  const reason = command.message?.trim();
  const state = toneFor("command", command.state);
  return (
    <>
      <InspectorHead
        icon="command"
        verb="執行"
        code={<ArgvText argv={command.argv} />}
        state={state}
        meta={[
          workspace && <WorkspaceTag name={workspace} hue={workspaceHue(command.workspace_id)} />,
          relativeTime(command.created_at, now),
          <CwdMeta key="cwd" cwd={workspaceCwd(command.cwd)} />,
        ]}
        actions={
          <>
            <CopyButton text={() => argv} label="複製指令" iconOnly />
            {onCancel && (
              <button
                type="button"
                className="k-btn k-btn--danger-quiet k-btn--sm"
                disabled={cancelBusy}
                onClick={onCancel}
              >
                {cancelBusy ? "取消中…" : "取消命令"}
              </button>
            )}
          </>
        }
      />
      <div className="insp-body">
        {actionError && (
          <p className="k-notice" data-tone="danger" role="alert">
            <WarningCircleIcon {...iconProps("lg")} />
            <span className="k-notice__body">{actionError}</span>
          </p>
        )}
        {command.state === "pending" && <PendingNotice />}
        {reason &&
          (state.tone === "danger" || state.tone === "warning") &&
          !commandNeverRan(command) && (
            <p className="insp-reason" data-tone={state.dataTone}>
              {reason}
            </p>
          )}
        <FactsStrip facts={commandFacts(command, result, now)} />
        <CommandOutput command={command} result={result} error={error} />
        <TechDetails rows={[["命令編號", command.id]]} />
      </div>
    </>
  );
}

export function CommandPanel({
  bridge,
  workspaceId,
  liveCommands,
  focus,
  workspaceName,
  onSubBack,
}: {
  bridge: WorkbenchBridge;
  /** Scope of the list; null lists every project (rows then carry a workspace tag). */
  workspaceId: string | null;
  liveCommands?: Command[];
  /** An empty id opens the list; any other id opens that command's detail. */
  focus?: { id: string; seq: number };
  workspaceName?: (id: string) => string | undefined;
  /** The workbench heading takes over the way back to 全部命令. */
  onSubBack?(value: SubBack | undefined): void;
}) {
  const [listed, setListed] = useState<Command[]>([]);
  const [selected, setSelected] = useState(focus?.id ?? "");
  const [listMode, setListMode] = useState(!focus?.id);
  const [fromList, setFromList] = useState(false);
  const listReturn = useListReturn({
    open: fromList && !listMode,
    label: "返回全部命令",
    back: () => setListMode(true),
    onSubBack,
  });
  const [listError, setListError] = useState("");
  const [actionError, setActionError] = useState({ id: "", message: "" });
  const [busyId, setBusyId] = useState("");
  useEffect(() => {
    if (!focus) return;
    setSelected(focus.id);
    setListMode(!focus.id);
    setFromList(false);
  }, [focus]);
  const hasLive = liveCommands !== undefined;
  useEffect(() => {
    if (hasLive) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await bridge.call("command_list");
        if (stopped) return;
        if (data.kind === "commands") setListed(data.commands);
        setListError("");
      } catch (cause) {
        if (!stopped) setListError(friendlyError(cause, "無法讀取命令清單。"));
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bridge, hasLive]);
  const commands = (liveCommands ?? listed)
    .filter((c) => !workspaceId || c.workspace_id === workspaceId)
    .sort((a, b) => b.created_at - a.created_at);
  const selectedCommand = selected ? commands.find((c) => c.id === selected) : undefined;
  const id = listMode ? "" : (selectedCommand?.id ?? "");
  const currentActionError = actionError.id === id ? actionError.message : "";
  const { result, error } = useCommandOutput(bridge, id);
  // A final SSE snapshot can arrive before the next output page. Never briefly
  // show "waiting for approval" again after cancellation has been confirmed.
  const current =
    selectedCommand && !commandActive(selectedCommand)
      ? selectedCommand
      : (result?.command ?? selectedCommand);
  const now = useNow(listMode ? commands.some(commandActive) : !!current && commandActive(current));
  const cancel = async () => {
    setBusyId(id);
    setActionError({ id, message: "" });
    try {
      await bridge.call("command_cancel", { command_id: id });
    } catch (cause) {
      setActionError({
        id,
        message: friendlyError(cause, "取消結果尚未確認，請等待狀態更新。"),
      });
    } finally {
      setBusyId("");
    }
  };
  return (
    <section ref={listReturn.container} className="wb-panel" aria-label="一次性命令">
      {listError && (
        <p className="k-notice wb-panel__notice" data-tone="danger" role="alert">
          <WarningCircleIcon {...iconProps("lg")} />
          <span className="k-notice__body">{listError}</span>
        </p>
      )}
      {listMode ? (
        <div className="insp-body">
          {commands.length ? (
            <RecordList
              label="命令"
              items={commands.map((command) => ({
                id: command.id,
                row: commandRecord(command, { now, workspaceName }),
              }))}
              currentId={selected}
              onOpen={(next) => {
                listReturn.opened(next);
                setSelected(next);
                setListMode(false);
                setFromList(true);
                setActionError({ id: next, message: "" });
              }}
            />
          ) : (
            <div className="k-empty wb-empty">
              <span className="k-empty__icon" aria-hidden="true">
                <TerminalIcon {...iconProps("xl")} />
              </span>
              <h3 className="k-empty__title">還沒有命令</h3>
              <p className="k-empty__text">ChatGPT 要執行命令時會列在這裡。</p>
            </div>
          )}
        </div>
      ) : (
        <>
          {listReturn.subBar && <SubBar {...listReturn.subBar} />}
          {!current ? (
            <div className="insp-body">
              <StatusLine>命令詳情已無法取得。</StatusLine>
            </div>
          ) : (
            <CommandDetail
              command={current}
              result={result}
              error={error}
              now={now}
              workspaceName={workspaceName}
              actionError={currentActionError}
              cancelBusy={!!busyId}
              onCancel={commandActive(current) ? () => void cancel() : undefined}
            />
          )}
        </>
      )}
    </section>
  );
}
