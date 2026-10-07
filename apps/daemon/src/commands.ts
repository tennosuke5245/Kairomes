import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  type AccessGrant,
  type ActivitySource,
  type Command,
  type CommandApproval,
  CommandInputs,
  type CommandResult,
  commandActive,
  KairomesError,
  publicError,
  type z,
} from "@kairomes/protocol";
import { resolveChecked, type WorkspaceRegistry } from "@kairomes/workspace-core";
import { denialReason } from "./approval-decision.ts";
import { commandRunner } from "./command-runner.ts";
import { ChangeWatchers, type PollWait } from "./poll-wait.ts";
import { createProcessGuard } from "./process-guard.ts";
import { OutputBuffer, shellEnvironment } from "./terminal.ts";

type Input = z.infer<typeof CommandInputs.command_request>;
type Job = {
  view: Command;
  source: ActivitySource;
  inputHash: string;
  fingerprint: string;
  cwd: string;
  identity: string;
  executable: string;
  executableIdentity: string;
  stdout: OutputBuffer;
  stderr: OutputBuffer;
  grantId?: string;
  proc?: Bun.Subprocess;
  guard?: Awaited<ReturnType<typeof createProcessGuard>>;
  readers?: Promise<void>[];
  finishing?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  cancelReaders?: (() => Promise<void>)[];
  lostOutput?: boolean;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const limits = { active: 4, retained: 24, requests: 4096, pending: 300000 };

export class CommandManager {
  private jobs = new Map<string, Job>();
  // Tombstones outlive output eviction: an uncertain retry must never execute twice.
  private requests = new Map<string, { hash: string; id: string }>();
  private closed = false;
  private sweep?: ReturnType<typeof setInterval>;
  private maintenance?: Promise<void>;
  private readonly watchers = new ChangeWatchers();
  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly access: (workspaceId: string) => AccessGrant | undefined,
    private readonly changed: (
      command: Command,
      source: ActivitySource,
      kind: "state" | "output",
    ) => void = () => {},
    private readonly now = Date.now,
  ) {}

  /** "output" marks a notification for new stdout/stderr only; the view itself is unchanged. */
  private notify(job: Job, kind: "state" | "output" = "state") {
    this.changed(structuredClone(job.view), job.source, kind);
    this.watchers.wake(job.view.id);
  }
  private get(id: string) {
    const job = this.jobs.get(id);
    if (!job)
      throw new KairomesError(
        "COMMAND_NOT_FOUND",
        "此命令已不在保留清單內；請勿因結果不明而直接重跑。",
      );
    return job;
  }
  private async checked(workspaceId: string, relative: string) {
    const root = this.registry.get(workspaceId);
    const cwd = await resolveChecked(root, relative);
    const info = await stat(cwd, { bigint: true });
    if (!info.isDirectory()) throw new KairomesError("NOT_DIRECTORY", "命令起始位置必須是資料夾。");
    return { cwd, identity: `${root.dev}:${root.ino}:${info.dev}:${info.ino}` };
  }
  private async resolveExecutable(program: string, cwd: string) {
    if (!program) throw new KairomesError("COMMAND_EXECUTABLE", "請指定執行檔。");
    // Bun's Windows npm shim is a .cmd file; execute this running Bun directly.
    const executable = /^(bun|bun\.cmd|bun\.exe)$/i.test(program)
      ? process.execPath
      : path.isAbsolute(program)
        ? program
        : /[\\/]/.test(program)
          ? path.resolve(cwd, program)
          : Bun.which(program);
    if (!executable)
      throw new KairomesError(
        "COMMAND_EXECUTABLE",
        "找不到執行檔；請確認程式已安裝或提供完整路徑。",
      );
    if (process.platform === "win32" && /\.(cmd|bat|ps1)$/i.test(executable))
      throw new KairomesError(
        "COMMAND_EXECUTABLE",
        '請使用原生執行檔。Bun 腳本可用 argv: ["bun", "run", "腳本名稱"]；批次檔需明確指定 cmd.exe，PowerShell 腳本需指定 powershell.exe。',
      );
    const info = await stat(executable, { bigint: true });
    if (!info.isFile()) throw new KairomesError("COMMAND_EXECUTABLE", "指定的程式不是檔案。");
    return {
      executable,
      executableIdentity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`,
    };
  }
  private replay(input: Input, inputHash: string) {
    const previous = this.requests.get(input.request_id);
    if (!previous) return;
    if (previous.hash !== inputHash)
      throw new KairomesError("COMMAND_CONFLICT", "同一 request_id 不能用於不同的命令。");
    return this.get(previous.id);
  }
  async request(raw: Input, source: ActivitySource = "local-ui"): Promise<CommandResult> {
    const input = CommandInputs.command_request.parse(raw);
    const inputHash = hash(input);
    const prior = this.replay(input, inputHash);
    if (prior) return this.poll(prior.view.id, 0, 0);
    if (Buffer.byteLength(JSON.stringify(input)) > 16000)
      throw new KairomesError("COMMAND_SIZE", "命令參數過長。");
    const checked = await this.checked(input.workspace_id, input.cwd);
    const program = await this.resolveExecutable(input.argv[0] ?? "", checked.cwd);
    const raced = this.replay(input, inputHash);
    if (raced) return this.poll(raced.view.id, 0, 0);
    if (this.closed) throw new KairomesError("COMMAND_CLOSED", "命令服務已關閉。");
    if (
      [...this.jobs.values()].filter((j) => commandActive(j.view) || !!j.proc).length >=
      limits.active
    )
      throw new KairomesError("COMMAND_LIMIT", "最多同時保留 4 個等待或執行中的命令。");
    if (this.requests.size >= limits.requests)
      throw new KairomesError("COMMAND_LIMIT", "本次服務的命令數量已達上限，請重新啟動工作台。");
    while (this.jobs.size >= limits.retained) {
      const retired = [...this.jobs.values()].find((j) => !commandActive(j.view) && !j.proc);
      if (!retired) throw new KairomesError("COMMAND_LIMIT", "命令仍在清理，請稍後再試。");
      this.jobs.delete(retired.view.id);
    }
    const view: Command = {
      id: crypto.randomUUID(),
      request_id: input.request_id,
      workspace_id: input.workspace_id,
      cwd: input.cwd,
      argv: [...input.argv],
      timeout_ms: input.timeout_ms,
      state: "pending",
      created_at: this.now(),
      started_at: null,
      ended_at: null,
      expires_at: this.now() + limits.pending,
      exit_code: null,
      signal: null,
      message: null,
    };
    const fingerprint = hash({ id: view.id, inputHash, ...checked, ...program });
    const job: Job = {
      view,
      source,
      inputHash,
      fingerprint,
      ...checked,
      ...program,
      stdout: new OutputBuffer(),
      stderr: new OutputBuffer(),
    };
    this.jobs.set(view.id, job);
    this.requests.set(input.request_id, { hash: inputHash, id: view.id });
    this.notify(job);
    this.sweep ??= setInterval(() => {
      void this.maintain();
    }, 100);
    this.sweep.unref();
    const grant = this.access(input.workspace_id);
    if (grant) {
      job.grantId = grant.id;
      await this.decide(view.id, fingerprint, true);
    }
    return this.result(job, 0, 0);
  }
  list(): Command[] {
    return [...this.jobs.values()].map((j) => structuredClone(j.view));
  }
  approvals(): CommandApproval[] {
    return [...this.jobs.values()].map((j) => ({
      ...structuredClone(j.view),
      fingerprint: j.fingerprint,
      absolute_cwd: j.cwd,
      executable: j.executable,
      workspace_name:
        this.registry.list().find((w) => w.id === j.view.workspace_id)?.name ?? "已解除掛載",
    }));
  }

  /**
   * Administrative method. Only the trusted Extension or local approval page calls it. A denial
   * may carry the user's reason, which the model reads back as denial_reason.
   */
  async decide(id: string, fingerprint: string, approve: boolean, reason?: string) {
    const denial = denialReason(approve, reason);
    const job = this.get(id);
    if (job.view.state !== "pending" || job.finishing || fingerprint !== job.fingerprint)
      throw new KairomesError("APPROVAL_MISMATCH", "命令已處理或審批內容不一致，請更新狀態。");
    if (this.now() >= job.view.expires_at) {
      await this.finish(job, "expired");
      throw new KairomesError("APPROVAL_EXPIRED", "命令請求已過期。");
    }
    if (!approve) {
      if (denial) job.view.denial_reason = denial;
      await this.finish(job, "denied");
      return;
    }
    job.view.state = "starting";
    job.view.started_at = this.now();
    job.view.expires_at = this.now() + job.view.timeout_ms;
    const grant = job.grantId ? this.access(job.view.workspace_id) : undefined;
    if (job.grantId && grant?.id !== job.grantId) {
      await this.finish(job, "cancelled");
      return;
    }
    if (grant?.expires_at !== null && grant?.expires_at !== undefined)
      job.view.expires_at = Math.min(job.view.expires_at, grant.expires_at);
    this.notify(job);
    try {
      const checked = await this.checked(job.view.workspace_id, job.view.cwd);
      const program = await this.resolveExecutable(job.executable, checked.cwd);
      if (
        checked.identity !== job.identity ||
        checked.cwd !== job.cwd ||
        program.executableIdentity !== job.executableIdentity
      )
        throw new KairomesError(
          "COMMAND_CHANGED",
          "核准前的工作目錄或執行檔已改變，請重新提出命令。",
        );
      const guard = await createProcessGuard();
      await this.validate(job);
      if (job.finishing || this.closed) {
        guard.close();
        return;
      }
      job.guard = guard;
      let sent = false;
      const proc = Bun.spawn(
        [process.execPath, "--no-env-file", "--no-install", "-e", commandRunner],
        {
          cwd: this.registry.dataDirectory,
          env: shellEnvironment(),
          windowsHide: true,
          detached: process.platform !== "win32",
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          ipc: (message: unknown, child) => {
            if (!message || typeof message !== "object" || !("type" in message) || job.finishing)
              return;
            if (message.type === "ready" && !sent) {
              if (this.closed || this.revoked(job)) {
                void this.finish(job, "cancelled");
                return;
              }
              if (this.now() >= job.view.expires_at) {
                void this.finish(job, this.expiryState(job));
                return;
              }
              sent = true;
              child.send({
                argv: [job.executable, ...job.view.argv.slice(1)],
                cwd: job.cwd,
                env: { ...shellEnvironment(), TERM: "dumb", NO_COLOR: "1" },
              });
            } else if (message.type === "started") {
              job.view.state = "running";
              this.notify(job);
            } else if (
              message.type === "result" &&
              "code" in message &&
              typeof message.code === "number"
            ) {
              job.view.exit_code = message.code;
              job.view.signal =
                "signal" in message && typeof message.signal === "string" ? message.signal : null;
              void this.finish(
                job,
                this.now() >= job.view.expires_at
                  ? this.expiryState(job)
                  : this.revoked(job)
                    ? "cancelled"
                    : message.code === 0 && !job.view.signal
                      ? "succeeded"
                      : "failed",
              );
            } else if (message.type === "launch-error") {
              job.view.message = "無法啟動指定程式。";
              void this.finish(job, "failed");
            }
          },
        },
      );
      job.proc = proc;
      job.readers = [
        this.read(proc.stdout, job.stdout, job),
        this.read(proc.stderr, job.stderr, job),
      ];
      // No event-loop yield between creating the helper and attaching its job.
      guard.attach(proc.pid);
      job.timer = setTimeout(
        () => void this.finish(job, this.expiryState(job)),
        Math.max(1, job.view.expires_at - this.now()),
      );
      void proc.exited.then(() => {
        if (!job.finishing) {
          job.view.message = "命令執行器提前結束。";
          void this.finish(job, "failed");
        }
      });
    } catch (error) {
      job.view.message = publicError(error).message;
      await this.finish(job, "failed");
    }
  }
  private async read(stream: ReadableStream<Uint8Array>, buffer: OutputBuffer, job: Job) {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    job.cancelReaders ??= [];
    job.cancelReaders.push(async () => {
      job.lostOutput = true;
      job.view.message ??= "部分輸出未能完整讀取。";
      await reader.cancel().catch(() => {});
    });
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        buffer.append(decoder.decode(part.value, { stream: true }));
        this.notify(job, "output");
      }
    } catch {
      job.lostOutput = true;
      job.view.message ??= "部分命令輸出未能完整讀取。";
    } finally {
      buffer.append(decoder.decode());
      reader.releaseLock();
    }
  }
  private revoked(job: Job) {
    return !!job.grantId && this.access(job.view.workspace_id)?.id !== job.grantId;
  }
  private expiryState(job: Job): "expired" | "timed_out" {
    return job.view.state === "pending" ||
      (job.grantId && job.view.expires_at < (job.view.started_at ?? 0) + job.view.timeout_ms)
      ? "expired"
      : "timed_out";
  }
  private finish(job: Job, state: Command["state"]): Promise<void> {
    if (job.finishing) return job.finishing;
    // Set the promise before any callbacks from process exit can re-enter cleanup.
    job.finishing = Promise.resolve().then(async () => {
      clearTimeout(job.timer);
      try {
        job.guard?.close();
      } catch {
        job.view.message ??= "程序群組回收未能確認。";
      } finally {
        job.guard = undefined;
        const proc = job.proc;
        if (proc) {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
          await proc.exited;
          let drainTimer: ReturnType<typeof setTimeout> | undefined;
          const drained = await Promise.race([
            Promise.all(job.readers ?? []).then(() => true),
            new Promise<false>((resolve) => {
              drainTimer = setTimeout(() => resolve(false), 1000);
            }),
          ]);
          clearTimeout(drainTimer);
          if (!drained) {
            await Promise.all((job.cancelReaders ?? []).map((cancel) => cancel()));
            await Promise.all(job.readers ?? []);
          }
          job.proc = undefined;
        }
        job.view.state = state;
        job.view.ended_at = this.now();
        this.notify(job);
      }
    });
    return job.finishing;
  }
  private async validate(job: Job) {
    if (!commandActive(job.view) || job.finishing) return;
    if (this.now() >= job.view.expires_at) {
      await this.finish(job, this.expiryState(job));
      return;
    }
    if (this.closed || this.revoked(job)) {
      await this.finish(job, "cancelled");
      return;
    }
    try {
      const checked = await this.checked(job.view.workspace_id, job.view.cwd);
      if (checked.cwd !== job.cwd || checked.identity !== job.identity)
        throw new Error("Workspace changed");
    } catch {
      await this.finish(job, "cancelled");
    }
  }
  async maintain() {
    if (this.maintenance) return this.maintenance;
    this.maintenance = Promise.all([...this.jobs.values()].map((j) => this.validate(j)))
      .then(() => {})
      .finally(() => {
        this.maintenance = undefined;
      });
    return this.maintenance;
  }
  async adoptAccess(workspaceId: string) {
    const grant = this.access(workspaceId);
    if (!grant) return;
    const adopting: Job[] = [];
    for (const job of this.jobs.values()) {
      if (job.view.workspace_id !== workspaceId || !commandActive(job.view) || job.finishing)
        continue;
      if (this.now() >= job.view.expires_at) continue;
      // Retag all active jobs synchronously, before a sweep can see the replaced grant.
      job.grantId = grant.id;
      adopting.push(job);
      if (job.view.state !== "pending") {
        job.view.expires_at =
          grant.expires_at === null
            ? (job.view.started_at ?? this.now()) + job.view.timeout_ms
            : Math.min((job.view.started_at ?? this.now()) + job.view.timeout_ms, grant.expires_at);
        clearTimeout(job.timer);
        job.timer = setTimeout(
          () => void this.finish(job, this.expiryState(job)),
          Math.max(1, job.view.expires_at - this.now()),
        );
        this.notify(job);
      }
    }
    await Promise.all(
      adopting.map(async (job) => {
        await this.validate(job);
        if (job.finishing || this.access(workspaceId)?.id !== grant.id) return;
        if (job.view.state === "pending") await this.decide(job.view.id, job.fingerprint, true);
      }),
    );
  }
  private result(job: Job, out: number, err: number): CommandResult {
    const stdout = job.stdout.read(out),
      stderr = job.stderr.read(err);
    return {
      kind: "command",
      command: structuredClone(job.view),
      stdout: stdout.output,
      stderr: stderr.output,
      stdout_cursor: stdout.cursor,
      stderr_cursor: stderr.cursor,
      stdout_truncated: stdout.truncated || !!job.lostOutput,
      stderr_truncated: stderr.truncated || !!job.lostOutput,
      has_more: stdout.has_more || stderr.has_more,
      output_complete: !commandActive(job.view),
    };
  }
  /**
   * With `wait`, a poll that finds no unread output while the command is still active waits for
   * the next output or state change (cancel, revoke and unmount all finish the job).
   */
  async poll(id: string, out: number, err: number, wait?: PollWait) {
    const job = this.get(id);
    await this.validate(job);
    const result = this.result(job, out, err);
    if (!wait || this.closed || !commandActive(job.view) || result.stdout || result.stderr)
      return result;
    if (!(await wait(this.watchers.subscribe(id)))) return result;
    await this.validate(job);
    return this.result(job, out, err);
  }
  async cancel(id: string) {
    const job = this.get(id);
    if (commandActive(job.view)) await this.finish(job, "cancelled");
    return this.result(job, 0, 0);
  }
  async cancelWorkspace(workspaceId: string) {
    await Promise.all(
      [...this.jobs.values()]
        .filter((j) => j.view.workspace_id === workspaceId)
        .map((j) => this.cancel(j.view.id)),
    );
  }
  async close() {
    this.closed = true;
    clearInterval(this.sweep);
    this.watchers.wakeAll();
    await Promise.all([...this.jobs.keys()].map((id) => this.cancel(id)));
  }
}
