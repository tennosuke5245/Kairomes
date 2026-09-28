import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  type AccessGrant,
  type ActivitySource,
  type Inputs,
  KairomesError,
  type TerminalResult,
  type TerminalSession,
  type z,
} from "@kairomes/protocol";
import { resolveChecked, type WorkspaceRegistry } from "@kairomes/workspace-core";
import { createProcessGuard } from "./process-guard.ts";

export const TERMINAL_LIMITS = {
  active: 4,
  retained: 16,
  buffer: 262144,
  page: 4096,
  pendingMs: 5 * 60_000,
  grantMs: 15 * 60_000,
  persistentGrantSessionMs: 4 * 60 * 60_000,
  inputIds: 16384,
} as const;
const activeStates = new Set<TerminalSession["state"]>(["pending", "starting", "running"]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Cursors are UTF-16 offsets, not bytes. Pages never split a surrogate pair. */
export class OutputBuffer {
  private data = "";
  private offset = 0;
  get end() {
    return this.offset + this.data.length;
  }
  append(value: string) {
    this.data += value;
    let remove = Math.max(0, this.data.length - TERMINAL_LIMITS.buffer);
    if (remove && /[\uDC00-\uDFFF]/u.test(this.data[remove] ?? "")) remove++;
    this.data = this.data.slice(remove);
    this.offset += remove;
  }
  read(cursor: number) {
    if (cursor > this.end)
      throw new KairomesError("INVALID_CURSOR", "輸出游標超出此終端機的範圍。");
    const start = Math.max(cursor, this.offset) - this.offset;
    if (/[\uDC00-\uDFFF]/u.test(this.data[start] ?? ""))
      throw new KairomesError("INVALID_CURSOR", "請使用前一次讀取回傳的完整游標。");
    let end = Math.min(this.data.length, start + TERMINAL_LIMITS.page);
    if (end < this.data.length && /[\uDC00-\uDFFF]/u.test(this.data[end] ?? "")) end--;
    return {
      output: this.data.slice(start, end),
      cursor: this.offset + end,
      truncated: cursor < this.offset,
      has_more: end < this.data.length,
    };
  }
}

type Session = {
  accessGrantId?: string;
  source: ActivitySource;
  view: TerminalSession;
  spec: string;
  fingerprint: string;
  cwd: string;
  argv: string[];
  buffer: OutputBuffer;
  decoder: TextDecoder;
  inputs: Map<string, string>;
  proc?: Bun.Subprocess;
  guard?: Awaited<ReturnType<typeof createProcessGuard>>;
  cleanup?: Promise<void>;
  ptyEnded?: Promise<void>;
};

export function shellEnvironment(source = process.env): Record<string, string> {
  const env: Record<string, string> = { TERM: "xterm-256color", COLORTERM: "truecolor" };
  for (const [name, value] of Object.entries(source)) {
    if (
      value &&
      /^(path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|localappdata|appdata|lang|lc_all)$/i.test(
        name,
      )
    )
      env[name] = value;
  }
  return env;
}

function shellCommand(shell: TerminalSession["shell"]): string[] {
  if (process.platform === "win32") {
    const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    if (shell === "powershell")
      return [
        path.join(system, "WindowsPowerShell", "v1.0", "powershell.exe"),
        "-NoLogo",
        "-NoProfile",
        "-NoExit",
      ];
    if (shell === "cmd") return [path.join(system, "cmd.exe"), "/d", "/q"];
  } else {
    if (shell === "bash") return ["/bin/bash", "--noprofile", "--norc", "-i"];
    if (shell === "sh") return ["/bin/sh", "-i"];
  }
  throw new KairomesError("UNSUPPORTED_SHELL", "此平台不支援選定的 shell。");
}

export class TerminalManager {
  private sessions = new Map<string, Session>();
  private accessGrants = new Map<
    string,
    AccessGrant & { owner: string; identity: string; valid(): boolean }
  >();
  private disposed = false;
  private sweeper?: ReturnType<typeof setInterval>;
  private maintenance = false;
  readonly available: boolean;

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly now = Date.now,
    private readonly changed: (
      session: TerminalSession,
      source: ActivitySource,
      kind: "state" | "input" | "output",
    ) => void = () => {},
    private readonly accessChanged: () => void = () => {},
  ) {
    try {
      const terminal = new Bun.Terminal({ cols: 80, rows: 24 });
      terminal.close();
      this.available = true;
    } catch {
      this.available = false;
    }
  }

  private get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new KairomesError("TERMINAL_NOT_FOUND", "此服務中找不到指定的終端機。");
    return session;
  }

  private async checkedCwd(workspaceId: string, relative: string) {
    const root = this.registry.get(workspaceId);
    const cwd = await resolveChecked(root, relative);
    const info = await stat(cwd, { bigint: true });
    if (!info.isDirectory())
      throw new KairomesError("NOT_DIRECTORY", "終端機起始位置必須是資料夾。");
    return { cwd, identity: `${root.dev}:${root.ino}:${info.dev}:${info.ino}` };
  }

  async request(
    args: z.infer<typeof Inputs.terminal_start>,
    source: ActivitySource = "local-ui",
  ): Promise<TerminalResult> {
    if (!this.available || this.disposed)
      throw new KairomesError("TERMINAL_UNAVAILABLE", "本機終端機目前無法使用。");
    const shell = args.shell ?? (process.platform === "win32" ? "powershell" : "bash");
    const argv = shellCommand(shell);
    const checked = await this.checkedCwd(args.workspace_id, args.cwd);
    // Check after all awaits so parallel requests cannot oversubscribe capacity.
    if (this.disposed) throw new KairomesError("TERMINAL_UNAVAILABLE", "本機服務已關閉。");
    if (
      this.list().filter((session) => activeStates.has(session.state)).length >=
      TERMINAL_LIMITS.active
    )
      throw new KairomesError("TERMINAL_LIMIT", "最多同時保留 4 個等待批准或執行中的終端機。");
    while (this.sessions.size >= TERMINAL_LIMITS.retained) {
      const retired = [...this.sessions.entries()].find(
        ([, session]) => !activeStates.has(session.view.state) && !session.proc,
      );
      if (!retired) throw new KairomesError("TERMINAL_LIMIT", "終端機正在清理，請稍後再試。");
      this.sessions.delete(retired[0]);
    }
    const id = crypto.randomUUID();
    const spec = JSON.stringify({ id, workspace: args.workspace_id, ...checked, argv });
    const session: Session = {
      source,
      view: {
        id,
        workspace_id: args.workspace_id,
        cwd: args.cwd,
        shell,
        mode: "host-pty",
        state: "pending",
        created_at: this.now(),
        expires_at: this.now() + TERMINAL_LIMITS.pendingMs,
        cols: args.cols,
        rows: args.rows,
        exit_code: null,
      },
      spec,
      fingerprint: digest(spec),
      cwd: checked.cwd,
      argv,
      buffer: new OutputBuffer(),
      decoder: new TextDecoder(),
      inputs: new Map(),
    };
    this.sessions.set(id, session);
    this.notify(session);
    this.sweeper ??= setInterval(() => {
      void this.maintain();
    }, 1000);
    this.sweeper.unref();
    const grant = this.currentAccess(args.workspace_id, "full");
    if (grant) {
      session.accessGrantId = grant.id;
      await this.decide(id, session.fingerprint, true);
    }
    return this.result(session, 0);
  }

  private currentAccess(workspaceId: string, required: AccessGrant["level"] = "files") {
    const grant = this.accessGrants.get(workspaceId);
    if (
      !grant ||
      this.disposed ||
      (required === "full" && grant.level !== "full") ||
      (grant.expires_at !== null && this.now() >= grant.expires_at) ||
      !grant.valid()
    )
      return;
    try {
      const root = this.registry.get(workspaceId);
      if (`${root.dev}:${root.ino}` === grant.identity) return grant;
    } catch {
      /* Unmounted workspaces cannot retain authority. */
    }
  }

  access(): AccessGrant[] {
    return [...this.accessGrants.values()]
      .filter((grant) => this.currentAccess(grant.workspace_id, grant.level)?.id === grant.id)
      .map(({ id, workspace_id, workspace_name, level, expires_at }) => ({
        id,
        workspace_id,
        workspace_name,
        level,
        expires_at,
      }));
  }

  private sessionDeadline(grant: AccessGrant) {
    return grant.expires_at ?? this.now() + TERMINAL_LIMITS.persistentGrantSessionMs;
  }

  /** Extension-only administration; no MCP/UI route may delegate this authority. */
  async enableAccess(
    workspaceId: string,
    level: AccessGrant["level"],
    minutes: 15 | 60 | 240 | null,
    owner: string,
    valid: () => boolean,
  ) {
    if (
      !["files", "full"].includes(level) ||
      (minutes !== null && ![15, 60, 240].includes(minutes)) ||
      !valid() ||
      this.disposed
    )
      throw new KairomesError("ACCESS_INVALID", "授權時間或配對狀態無效。");
    const root = this.registry.get(workspaceId);
    const grant = {
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      workspace_name: root.name,
      level,
      expires_at: minutes === null ? null : this.now() + minutes * 60_000,
      owner,
      identity: `${root.dev}:${root.ino}`,
      valid,
    };
    this.accessGrants.set(workspaceId, grant);
    this.accessChanged();
    this.sweeper ??= setInterval(() => {
      void this.maintain();
    }, 1000);
    this.sweeper.unref();
    // Full access covers existing and future host sessions. Switching to file-only access
    // immediately revokes shells that inherited the previous full-access grant.
    const pending: Session[] = [];
    for (const session of this.sessions.values()) {
      if (session.view.workspace_id !== workspaceId || !activeStates.has(session.view.state))
        continue;
      if (level !== "full") {
        if (session.accessGrantId) await this.stop(session.view.id);
        continue;
      }
      session.accessGrantId = grant.id;
      if (session.view.state === "pending") pending.push(session);
      else session.view.expires_at = this.sessionDeadline(grant);
      this.notify(session);
    }
    for (const session of pending) {
      if (this.currentAccess(workspaceId, "full")?.id !== grant.id) break;
      if (session.view.state === "pending" && this.now() < session.view.expires_at)
        await this.decide(session.view.id, session.fingerprint, true);
    }
  }

  async disableAccess(workspaceId: string) {
    this.accessGrants.delete(workspaceId);
    this.accessChanged();
    // Revoke before awaiting process cleanup, so no new request can inherit authority.
    await Promise.all(
      [...this.sessions.values()]
        .filter((s) => s.view.workspace_id === workspaceId && activeStates.has(s.view.state))
        .map((s) => this.stop(s.view.id)),
    );
  }

  async revokeAccessOwner(owner: string) {
    await Promise.all(
      [...this.accessGrants.values()]
        .filter((g) => g.owner === owner)
        .map((g) => this.disableAccess(g.workspace_id)),
    );
  }

  list(): TerminalSession[] {
    return [...this.sessions.values()].map((session) => ({ ...session.view }));
  }

  private notify(
    session: Session,
    kind: "state" | "input" | "output" = "state",
    source = session.source,
  ) {
    this.changed({ ...session.view }, source, kind);
  }

  approvals() {
    return [...this.sessions.values()].map((session) => ({
      ...session.view,
      fingerprint: session.fingerprint,
      absolute_cwd: session.cwd,
      command: session.argv,
      workspace_name:
        this.registry.list().find((workspace) => workspace.id === session.view.workspace_id)
          ?.name ?? "已解除掛載",
    }));
  }

  /** Local administration only. Never register this method as an outward MCP tool. */
  async decide(id: string, fingerprint: string, approve: boolean): Promise<void> {
    const session = this.get(id);
    if (
      session.view.state !== "pending" ||
      session.fingerprint !== fingerprint ||
      digest(session.spec) !== fingerprint
    )
      throw new KairomesError("APPROVAL_MISMATCH", "此審批已處理或內容不一致，請重新整理。");
    if (this.now() >= session.view.expires_at) {
      session.view.state = "expired";
      this.notify(session);
      throw new KairomesError("APPROVAL_EXPIRED", "終端機請求已過期。");
    }
    if (!approve) {
      session.view.state = "denied";
      this.notify(session);
      return;
    }
    // Consume approval synchronously, before filesystem checks or process launch.
    session.view.state = "starting";
    const access = this.currentAccess(session.view.workspace_id, "full");
    if (session.accessGrantId && access?.id !== session.accessGrantId) {
      session.view.state = "stopped";
      this.notify(session);
      return;
    }
    session.view.expires_at =
      session.accessGrantId && access
        ? this.sessionDeadline(access)
        : this.now() + TERMINAL_LIMITS.grantMs;
    this.notify(session);
    try {
      const checked = await this.checkedCwd(session.view.workspace_id, session.view.cwd);
      if (
        JSON.stringify({
          id,
          workspace: session.view.workspace_id,
          ...checked,
          argv: session.argv,
        }) !== session.spec
      )
        throw new KairomesError("WORKSPACE_CHANGED", "批准前工作目錄已改變，請建立新的請求。");
      const guard = await createProcessGuard();
      if (
        session.accessGrantId &&
        this.currentAccess(session.view.workspace_id, "full")?.id !== session.accessGrantId
      )
        session.view.state = "stopped";
      if (this.now() >= session.view.expires_at) session.view.state = "expired";
      if (this.disposed || session.view.state !== "starting") {
        guard.close();
        this.notify(session);
        return;
      }
      session.guard = guard;
      let endPty = () => {};
      session.ptyEnded = new Promise<void>((resolve) => {
        endPty = resolve;
      });
      const proc = Bun.spawn(session.argv, {
        cwd: session.cwd,
        env: shellEnvironment(),
        detached: process.platform !== "win32",
        windowsHide: true,
        terminal: {
          cols: session.view.cols,
          rows: session.view.rows,
          exit: () => endPty(),
          data: (_terminal, data) => {
            session.buffer.append(session.decoder.decode(data, { stream: true }));
            this.notify(session, "output");
          },
        },
      });
      session.proc = proc;
      // No input is accepted until the shell belongs to its process group/job.
      guard.attach(proc.pid);
      session.view.state = "running";
      this.notify(session);
      void proc.exited
        .then(async (code) => {
          session.view.exit_code = code;
          await this.cleanup(session);
          if (session.view.state === "running") session.view.state = "exited";
          this.notify(session);
        })
        .catch(() => {
          session.view.state = "failed";
          this.notify(session);
        });
    } catch (error) {
      session.view.state = "failed";
      this.notify(session);
      await this.cleanup(session);
      throw error;
    }
  }

  private result(session: Session, cursor: number): TerminalResult {
    const page = session.buffer.read(cursor);
    return {
      kind: "terminal",
      session: { ...session.view },
      ...page,
      text: stripVTControlCharacters(page.output),
    };
  }

  private async validateSession(session: Session) {
    if (!activeStates.has(session.view.state)) return;
    if (
      session.accessGrantId &&
      this.currentAccess(session.view.workspace_id, "full")?.id !== session.accessGrantId
    ) {
      await this.stop(
        session.view.id,
        this.now() >= session.view.expires_at ? "expired" : "stopped",
      );
      return;
    }
    if (this.now() >= session.view.expires_at) {
      await this.stop(session.view.id, "expired");
      return;
    }
    try {
      const checked = await this.checkedCwd(session.view.workspace_id, session.view.cwd);
      const spec = JSON.stringify({
        id: session.view.id,
        workspace: session.view.workspace_id,
        ...checked,
        argv: session.argv,
      });
      if (spec !== session.spec) throw new Error("Changed workspace");
      if (this.now() >= session.view.expires_at) await this.stop(session.view.id, "expired");
    } catch {
      await this.stop(session.view.id);
    }
  }

  async poll(id: string, cursor: number): Promise<TerminalResult> {
    const session = this.get(id);
    await this.validateSession(session);
    return this.result(session, cursor);
  }

  async input(
    id: string,
    data: string,
    inputId: string,
    source: ActivitySource = "local-ui",
  ): Promise<TerminalResult> {
    const session = this.get(id);
    await this.validateSession(session);
    if (session.view.state !== "running" || !session.proc?.terminal)
      throw new KairomesError("TERMINAL_NOT_RUNNING", "終端機尚未獲得本機批准，或已停止。");
    const hash = digest(data);
    const prior = session.inputs.get(inputId);
    if (prior && prior !== hash)
      throw new KairomesError("INPUT_CONFLICT", "相同 input_id 不能傳送不同內容。");
    if (!prior) {
      if (session.inputs.size >= TERMINAL_LIMITS.inputIds)
        throw new KairomesError("INPUT_LIMIT", "此工作階段已達輸入次數上限，請建立新的終端機。");
      session.proc.terminal.write(data);
      session.inputs.set(inputId, hash);
      this.notify(session, "input", source);
    }
    return this.result(session, session.buffer.end);
  }

  async resize(id: string, cols: number, rows: number): Promise<TerminalResult> {
    const session = this.get(id);
    await this.validateSession(session);
    if (session.view.state === "running") {
      session.proc?.terminal?.resize(cols, rows);
      session.view.cols = cols;
      session.view.rows = rows;
    }
    return this.result(session, session.buffer.end);
  }

  async stop(id: string, state: "stopped" | "expired" = "stopped"): Promise<TerminalResult> {
    const session = this.get(id);
    if (activeStates.has(session.view.state)) session.view.state = state;
    await this.cleanup(session);
    this.notify(session);
    return this.result(session, session.buffer.end);
  }

  private cleanup(session: Session): Promise<void> {
    if (session.cleanup) return session.cleanup;
    session.cleanup = (async () => {
      session.guard?.close();
      session.guard = undefined;
      const proc = session.proc;
      if (proc) {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        await proc.exited;
        if (session.ptyEnded) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            session.ptyEnded,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 250);
            }),
          ]);
          if (timer) clearTimeout(timer);
        }
        // Kill before close: older ConPTY implementations can block on a live child.
        proc.terminal?.close();
        session.proc = undefined;
      }
      session.buffer.append(session.decoder.decode());
    })();
    return session.cleanup;
  }

  async maintain() {
    if (this.maintenance || this.disposed) return;
    this.maintenance = true;
    try {
      for (const [id, grant] of this.accessGrants) {
        if (this.currentAccess(id)?.id !== grant.id) {
          this.accessGrants.delete(id);
          this.accessChanged();
        }
      }
      await Promise.all(
        [...this.sessions.values()].map((session) => this.validateSession(session)),
      );
    } finally {
      this.maintenance = false;
    }
  }

  async close() {
    this.disposed = true;
    this.accessGrants.clear();
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }
}
