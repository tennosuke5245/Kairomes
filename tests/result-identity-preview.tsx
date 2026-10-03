import type {
  CommandResult,
  FileChange,
  FileChangeResult,
  McpCall,
  ToolData,
} from "@kairomes/protocol";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { WorkbenchBridge } from "../apps/widget/src/bridge.ts";
import {
  CommandOutput,
  CommandPanel,
  useCommandOutput,
} from "../apps/widget/src/command-panel.tsx";
import { FileChangePanel } from "../apps/widget/src/file-change-panel.tsx";
import { DiffPreview, McpImagePreview } from "../apps/widget/src/overview-panel.tsx";
import "../apps/widget/src/styles.css";

// Fixed memory-only fixture. It never creates a bridge, fetches or runs a command.
type Target = "A" | "B";
type Pending = {
  kind: "diff" | "command" | "media";
  target: Target;
  resolve(value: ToolData | string): void;
  reject(error: Error): void;
};
const pending: Pending[] = [];
type PendingCancel = { kind: "command" | "change"; target: Target; reject(error: Error): void };
const pendingCancels: PendingCancel[] = [];
const cancelCounts = { command: 0, change: 0 };
const workspace = "10000000-0000-4000-8000-000000000001";
const targetId = (target: Target) =>
  target === "A" ? "10000000-0000-4000-8000-00000000000a" : "10000000-0000-4000-8000-00000000000b";
const targetFor = (id: unknown): Target => {
  if (id === targetId("A")) return "A";
  if (id === targetId("B")) return "B";
  throw new Error("未知合成目標。");
};
function waitFor(kind: Pending["kind"], target: Target) {
  return new Promise<ToolData | string>((resolve, reject) =>
    pending.push({ kind, target, resolve, reject }),
  );
}
const bridge = {
  mode: "workbench",
  async call(name, args) {
    if (name !== "command_poll" && name !== "file_change_poll")
      throw new Error("合成 fixture 僅允許讀取結果。");
    return (await waitFor(
      name === "command_poll" ? "command" : "diff",
      targetFor(name === "command_poll" ? args?.command_id : args?.change_id),
    )) as ToolData;
  },
  async loadMcpMedia(id) {
    return (await waitFor("media", targetFor(id))) as string;
  },
} as WorkbenchBridge;

function change(target: Target): FileChange {
  return {
    id: targetId(target),
    request_id: targetId(target),
    workspace_id: workspace,
    summary: `合成變更 ${target}`,
    state: "applied",
    created_at: 0,
    applied_at: 2,
    expires_at: 100,
    message: null,
    files: [],
  };
}
function media(target: Target): Extract<McpCall["content"][number], { type: "image" }> {
  return {
    type: "image",
    media_id: targetId(target),
    mime_type: "image/png",
    width: 1,
    height: 1,
    byte_size: 67,
  };
}
function command(target: Target): CommandResult {
  return {
    kind: "command",
    command: {
      id: targetId(target),
      request_id: targetId(target),
      workspace_id: workspace,
      cwd: "",
      argv: ["synthetic"],
      timeout_ms: 1000,
      state: "succeeded",
      created_at: 0,
      started_at: 1,
      ended_at: 2,
      expires_at: 100,
      exit_code: 0,
      signal: null,
      message: null,
    },
    stdout: `命令內容 ${target}`,
    stderr: "",
    stdout_cursor: 6,
    stderr_cursor: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    has_more: false,
    output_complete: true,
  };
}
let created = 0,
  revoked = 0;
const createdUrls = new Set<string>();
const revoke = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url) => {
  if (createdUrls.delete(url)) revoked++;
  revoke(url);
};
function imageUrl() {
  // Fixed transparent PNG; no repository or external image source is read.
  const bytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==",
    ),
    (character) => character.charCodeAt(0),
  );
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  createdUrls.add(url);
  created++;
  return url;
}
function finish(target: Target, fail = false, wrong = false) {
  for (let index = pending.length - 1; index >= 0; index--) {
    const item = pending[index];
    if (!item || item.target !== target) continue;
    pending.splice(index, 1);
    if (fail) item.reject(new Error(`合成 ${target} 載入失敗`));
    else if (item.kind === "media") item.resolve(imageUrl());
    else if (item.kind === "command")
      item.resolve(command(wrong ? (target === "A" ? "B" : "A") : target));
    else {
      const source = wrong ? (target === "A" ? "B" : "A") : target;
      const result: FileChangeResult = {
        kind: "file_change",
        change: change(source),
        diff: `+差異內容 ${source}`,
        diff_truncated: false,
      };
      item.resolve(result);
    }
  }
}
function CommandFixture({ target }: { target: Target }) {
  const { result, error } = useCommandOutput(bridge, targetId(target));
  return <CommandOutput result={result} error={error} />;
}
function useFixtureProbe() {
  const read = () => ({
    created,
    revoked,
    pending: pending.length,
    cancelling: pendingCancels.length,
    commandCancels: cancelCounts.command,
    changeCancels: cancelCounts.change,
  });
  const [probe, setProbe] = useState(read);
  useEffect(() => {
    const update = () => {
      const next = read();
      setProbe((previous) =>
        Object.keys(next).every(
          (key) => next[key as keyof typeof next] === previous[key as keyof typeof previous],
        )
          ? previous
          : next,
      );
    };
    update();
    // Captures promise settlement and child effect cleanup, not just button events.
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  }, []);
  return probe;
}
function Fixture() {
  const [target, setTarget] = useState<Target>("A");
  const [visible, setVisible] = useState(true);
  const [, refresh] = useState(0);
  const probe = useFixtureProbe();
  const update = (action: () => void) => {
    action();
    setTimeout(() => refresh((value) => value + 1), 0);
  };
  return (
    <main style={{ maxWidth: 700, padding: 12 }}>
      <nav aria-label="合成測試控制">
        <button type="button" data-control="select-a" onClick={() => update(() => setTarget("A"))}>
          切到 A
        </button>
        <button type="button" data-control="select-b" onClick={() => update(() => setTarget("B"))}>
          切到 B
        </button>
        <button type="button" data-control="finish-a" onClick={() => update(() => finish("A"))}>
          完成 A
        </button>
        <button type="button" data-control="finish-b" onClick={() => update(() => finish("B"))}>
          完成 B
        </button>
        <button
          type="button"
          data-control="fail"
          onClick={() => update(() => finish(target, true))}
        >
          目前失敗
        </button>
        <button
          type="button"
          data-control="wrong"
          onClick={() => update(() => finish(target, false, true))}
        >
          回錯身份
        </button>
        <button
          type="button"
          data-control="media-toggle"
          onClick={() => update(() => setVisible((value) => !value))}
        >
          切換圖片掛載
        </button>
      </nav>
      <output
        data-fixture-probe
        data-target={target}
        data-created={probe.created}
        data-revoked={probe.revoked}
        data-pending={probe.pending}
      >
        目標 {target} · 圖片 {probe.created}/{probe.revoked}
      </output>
      <section data-panel="diff">
        <h1>差異 {target}</h1>
        <DiffPreview bridge={bridge} change={change(target)} />
      </section>
      <section data-panel="command">
        <h1>命令 {target}</h1>
        <CommandFixture target={target} />
      </section>
      <section data-panel="media">
        <h1>圖片 {target}</h1>
        {visible && (
          <McpImagePreview bridge={bridge} media={media(target)} label={`合成圖片 ${target}`} />
        )}
      </section>
    </main>
  );
}

function CancelFixture() {
  const [target, setTarget] = useState<Target>("A");
  const [seq, setSeq] = useState(1);
  const probe = useFixtureProbe();
  const [state] = useState(() => {
    const targets = ["A", "B"] as const;
    const commands = targets.map((name) => ({
      ...command(name).command,
      argv: ["synthetic", name],
      state: "pending" as const,
      exit_code: null,
      started_at: null,
      ended_at: null,
    }));
    const changes = targets.map((name) => ({
      ...change(name),
      state: "pending" as const,
      applied_at: null,
      files: [
        {
          operation: "edit" as const,
          path: `source-${name}.txt`,
          before_version: "a".repeat(64),
          after_version: "b".repeat(64),
        },
      ],
    }));
    const cancelBridge = {
      mode: "workbench",
      async call(name, args) {
        if (name === "command_poll") {
          const selected = commands.find((item) => item.id === args?.command_id);
          if (!selected) throw new Error("未知合成命令。");
          return {
            ...command(targetFor(selected.id)),
            command: selected,
            stdout: "",
            stderr: "",
            stdout_cursor: 0,
            stderr_cursor: 0,
            output_complete: false,
          };
        }
        if (name === "file_change_poll") {
          const selected = changes.find((item) => item.id === args?.change_id);
          if (!selected) throw new Error("未知合成變更。");
          return {
            kind: "file_change",
            change: selected,
            diff: `+待核對 ${targetFor(selected.id)}`,
            diff_truncated: false,
          };
        }
        if (name === "command_cancel" || name === "file_change_cancel") {
          const kind = name === "command_cancel" ? "command" : "change";
          const selected = targetFor(kind === "command" ? args?.command_id : args?.change_id);
          cancelCounts[kind]++;
          // Only an explicit fixture control rejects this in-memory pending call.
          return await new Promise<ToolData>((_resolve, reject) =>
            pendingCancels.push({ kind, target: selected, reject }),
          );
        }
        throw new Error("合成取消 fixture 不支援此操作。");
      },
    } as WorkbenchBridge;
    return { commands, changes, bridge: cancelBridge };
  });
  const select = (next: Target) => {
    setTarget(next);
    setSeq((value) => value + 1);
  };
  const reject = (next: Target) => {
    for (let index = pendingCancels.length - 1; index >= 0; index--) {
      const item = pendingCancels[index];
      if (item?.target !== next) continue;
      pendingCancels.splice(index, 1);
      item.reject(new Error(`合成 ${next} 取消結果待確認`));
    }
  };
  const focus = { id: targetId(target), seq };
  return (
    <main style={{ maxWidth: 700, padding: 12 }}>
      <nav aria-label="合成取消測試控制">
        <button type="button" data-control="select-a" onClick={() => select("A")}>
          切到 A
        </button>
        <button type="button" data-control="select-b" onClick={() => select("B")}>
          切到 B
        </button>
        <button type="button" data-control="reject-a" onClick={() => reject("A")}>
          A 取消失敗
        </button>
        <button type="button" data-control="reject-b" onClick={() => reject("B")}>
          B 取消失敗
        </button>
      </nav>
      <output
        data-fixture-probe
        data-mode="cancel"
        data-target={target}
        data-command-cancels={probe.commandCancels}
        data-change-cancels={probe.changeCancels}
        data-cancelling={probe.cancelling}
      >
        目標 {target} · 取消 {probe.commandCancels}/{probe.changeCancels}
      </output>
      <section data-panel="command">
        <CommandPanel
          bridge={state.bridge}
          workspaceId={workspace}
          liveCommands={state.commands}
          focus={focus}
        />
      </section>
      <section data-panel="diff">
        <FileChangePanel
          bridge={state.bridge}
          workspaceId={workspace}
          liveChanges={state.changes}
          focus={focus}
        />
      </section>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing synthetic fixture root");
createRoot(root).render(
  new URLSearchParams(location.search).get("cancel") === "1" ? <CancelFixture /> : <Fixture />,
);
