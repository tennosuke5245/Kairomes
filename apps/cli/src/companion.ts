import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  collectDiagnostics,
  createProcessGuard,
  loadMcpResultWidget,
  loadWidget,
  readWorkbenchConnection,
  startWorkbench,
  verifyWorkbenchConnection,
} from "@kairomes/daemon";
import {
  type CompanionAttention,
  type CompanionStatus,
  type CompanionTunnelState,
  type CompanionTunnelStatus,
  type CompanionWorkbenchState,
  type DiagnosticsReport,
  diagnosticSummary,
  HandoffInputSchema,
  KairomesError,
  McpMountFileSchema,
  parseVersion,
  publicError,
  type TunnelReason,
  VERSION,
  z,
} from "@kairomes/protocol";
import { WorkspaceRegistry } from "@kairomes/workspace-core";
import { HandoffBriefs } from "../../daemon/src/handoff-brief.ts";
import { openExternal } from "./browser.ts";
import { connectionSummary, healthVersion, pendingSummary } from "./companion-attention.ts";
import { companionPage } from "./companion-page.ts";
import { validExtensionId } from "./extension-id.ts";
import { HandoffStarts } from "./handoff-starts.ts";
import {
  nextTunnelRestartDelay,
  TUNNEL_RESTART_DELAYS_MS,
  TUNNEL_RESTART_WINDOW_MS,
  TunnelRunLog,
  tunnelExitReason,
  tunnelSpawnReason,
} from "./tunnel-status.ts";

const SETTINGS_FILE = "companion-settings.json";
const CONNECTION_FILE = "companion-connection.json";
const CHATGPT_CONNECTORS_URL = "https://chatgpt.com/#settings/Connectors";

const SettingsSchema = z
  .object({
    extensionId: z
      .string()
      .regex(/^[a-p]{32}$/)
      .optional(),
  })
  .strict();
type CompanionSettings = z.infer<typeof SettingsSchema>;

const ConnectionSchema = z
  .object({
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
    origin: z
      .string()
      .refine(
        (value) =>
          /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.test(value) &&
          Number(new URL(value).port) <= 65535,
      ),
    token: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type CompanionConnection = z.infer<typeof ConnectionSchema>;

type TunnelState = CompanionTunnelState;
type WorkbenchState = CompanionWorkbenchState;
type WorkbenchConnection = Awaited<ReturnType<typeof readWorkbenchConnection>>;

type BrowserOpener = (url: string) => Promise<void>;

function settingsPath(directory: string) {
  return path.join(directory, SETTINGS_FILE);
}

function connectionPath(directory: string) {
  return path.join(directory, CONNECTION_FILE);
}

async function safeSmallFile(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 4096)
    throw new KairomesError("COMPANION_STATE_INVALID", "Companion 本機狀態檔不安全或已損壞。");
  return stat;
}

async function readSettings(directory: string): Promise<CompanionSettings> {
  const file = settingsPath(directory);
  try {
    await safeSmallFile(file);
    return SettingsSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    if (error instanceof KairomesError) throw error;
    throw new KairomesError(
      "COMPANION_SETTINGS_INVALID",
      "Companion 設定無法讀取，請檢查本機狀態目錄。",
    );
  }
}

async function writeSettings(directory: string, settings: CompanionSettings) {
  await mkdir(directory, { recursive: true });
  const file = settingsPath(directory);
  try {
    await safeSmallFile(file);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const temporary = path.join(
    directory,
    `.companion-settings-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  await writeFile(temporary, JSON.stringify(SettingsSchema.parse(settings)), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    try {
      await rename(temporary, file);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error)) throw error;
      if (!["EEXIST", "EPERM"].includes(String(error.code))) throw error;
      await safeSmallFile(file);
      await unlink(file);
      await rename(temporary, file);
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readCompanionConnection(directory: string): Promise<CompanionConnection> {
  const file = connectionPath(directory);
  try {
    await safeSmallFile(file);
    return ConnectionSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    throw new KairomesError("COMPANION_UNAVAILABLE", "找不到執行中的 Kairomes Companion。");
  }
}

async function verifyCompanionConnection(connection: CompanionConnection) {
  const response = await fetch(`${connection.origin}/healthz`, {
    redirect: "error",
    signal: AbortSignal.timeout(2000),
  });
  const body = await response.json();
  if (!response.ok || body.instanceId !== connection.instanceId)
    throw new KairomesError("COMPANION_UNAVAILABLE", "Companion 狀態已過期。");
  return { version: healthVersion(body) };
}

/** For diagnostics outside the Companion: whether one runs for this data directory, and its version. */
export async function probeCompanion(
  directory: string,
): Promise<{ state: "running" | "unavailable"; version: string | null }> {
  try {
    const health = await verifyCompanionConnection(await readCompanionConnection(directory));
    return { state: "running", version: health.version };
  } catch {
    return { state: "unavailable", version: null };
  }
}

async function removeStaleConnection(directory: string) {
  const file = connectionPath(directory);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw new KairomesError("COMPANION_STATE_INVALID", "Companion 連線狀態不是檔案。");
    await unlink(file);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function acquireCompanionConnection(
  directory: string,
  connection: CompanionConnection,
): Promise<
  | { kind: "owned"; release: () => Promise<void> }
  | { kind: "existing"; connection: CompanionConnection }
> {
  await mkdir(directory, { recursive: true });
  const file = connectionPath(directory);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(ConnectionSchema.parse(connection)));
      } finally {
        await handle.close();
      }
      return {
        kind: "owned",
        release: async () => {
          try {
            const current = await readCompanionConnection(directory);
            if (current.instanceId === connection.instanceId) await unlink(file);
          } catch {
            // A local user may have already removed the bounded descriptor.
          }
        },
      };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
        throw error;
      try {
        const existing = await readCompanionConnection(directory);
        await verifyCompanionConnection(existing);
        return { kind: "existing", connection: existing };
      } catch {
        await removeStaleConnection(directory);
      }
    }
  }
  throw new KairomesError("COMPANION_START_FAILED", "無法建立 Companion 單一執行個體。");
}

function stripTerminalControls(value: string) {
  return [...stripVTControlCharacters(value)]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (character === "\t") return true;
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
}

class TunnelSupervisor {
  private child?: ReturnType<typeof Bun.spawn>;
  private guard?: Awaited<ReturnType<typeof createProcessGuard>>;
  private generation = 0;
  private state: TunnelState = "stopped";
  private exitCode?: number;
  private startedAt?: string;
  private logs: string[] = [];
  private importantLogs: string[] = [];
  private failureLogged = false;
  /** Classified process lines of the current run; lines of an earlier run never reach it. */
  private runLog?: TunnelRunLog;
  private reason?: TunnelReason;
  /** The user stopped the Tunnel; only an explicit start or restart lifts it. */
  private stoppedByUser = false;
  /** Times of automatic restarts; an explicit start or stop clears them. */
  private restarts: number[] = [];
  private retryTimer?: ReturnType<typeof setTimeout>;
  private nextRetryAt?: number;

  constructor(
    private readonly commandOverride?: readonly string[],
    private readonly tunnelApiKey?: string,
    private readonly restartDelays: readonly number[] = TUNNEL_RESTART_DELAYS_MS,
  ) {}

  /** The executable that start() would launch; null when tunnel-client is not installed. */
  executable(): string | null {
    return this.commandOverride?.[0] ?? Bun.which("tunnel-client");
  }

  snapshot(): CompanionTunnelStatus {
    const now = Date.now();
    const label = {
      missing: "尚未安裝",
      starting: "正在啟動",
      running: "執行中",
      stopped: "已停止",
      error: "需要處理",
    }[this.state];
    const exit =
      this.exitCode === undefined || this.exitCode === 0 ? "" : `（Exit ${this.exitCode}）`;
    const message =
      this.state === "missing"
        ? "PATH 中找不到官方 tunnel-client。安裝後按啟動即可重新檢查。"
        : this.state === "starting"
          ? "正在啟動官方 Tunnel profile：kairomes。"
          : this.state === "running"
            ? "官方 Tunnel 正在背景執行；關閉這個頁面不會中斷。"
            : this.state === "error"
              ? this.nextRetryAt
                ? `Tunnel 意外停止${exit}；稍後會自動重新啟動。`
                : `Tunnel 啟動後停止${exit}；展開最近訊息查看原因。`
              : "Tunnel 目前沒有執行。";
    const tail = this.logs.slice(-24);
    const important = this.importantLogs.filter((line) => !tail.includes(line));
    return {
      state: this.state,
      label,
      message,
      meta: this.startedAt
        ? `Profile · kairomes · ${new Date(this.startedAt).toLocaleTimeString("zh-TW")}`
        : "Profile · kairomes",
      logs: [...important, ...tail],
      startedAt: this.state === "running" ? (this.startedAt ?? null) : null,
      reason:
        this.state === "missing"
          ? "not_installed"
          : this.state === "error"
            ? (this.reason ?? "unknown")
            : null,
      restartCount: this.restarts.filter((time) => now - time < TUNNEL_RESTART_WINDOW_MS).length,
      nextRetryAt: this.nextRetryAt ? new Date(this.nextRetryAt).toISOString() : null,
    };
  }

  private rememberImportantLog(line: string) {
    let important = /^[A-Z][A-Z0-9_]+:\s/.test(line);
    try {
      const entry = JSON.parse(line);
      important =
        typeof entry === "object" &&
        entry !== null &&
        ["WARN", "ERROR"].includes(String(entry.level).toUpperCase());
    } catch {
      // Human-readable MCP startup errors are intentionally not JSON.
    }
    if (!important) return;
    this.failureLogged = true;
    if (!this.importantLogs.includes(line)) this.importantLogs.push(line);
    if (this.importantLogs.length > 6) this.importantLogs.splice(0, this.importantLogs.length - 6);
  }

  /**
   * Output of the current run is classified; Companion's own notes (no run) and late lines of
   * an earlier run are only recorded.
   */
  private addLog(value: string, run?: TunnelRunLog) {
    for (const line of value.split(/\r?\n/)) {
      let clean = stripTerminalControls(line);
      if (this.tunnelApiKey) clean = clean.replaceAll(this.tunnelApiKey, "[redacted]");
      clean = clean.slice(0, 500);
      if (clean) {
        this.logs.push(clean);
        if (run && run === this.runLog) {
          this.rememberImportantLog(clean);
          run.add(clean, Date.now());
        }
      }
    }
    if (this.logs.length > 80) this.logs.splice(0, this.logs.length - 80);
  }

  private async collect(stream: ReadableStream<Uint8Array> | null, run: TunnelRunLog) {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        this.addLog(lines.join("\n"), run);
      }
      pending += decoder.decode();
      this.addLog(pending, run);
    } catch {
      // Process exit can close the stream while a read is pending.
    } finally {
      reader.releaseLock();
    }
  }

  private cancelRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.nextRetryAt = undefined;
  }

  /**
   * Bounded automatic restart after an unexpected exit: 2 s, 10 s, then 30 s, at most three
   * within five minutes. Never after an explicit stop or quit (the generation changes) and
   * never for failures a restart cannot fix.
   */
  private scheduleRestart(generation: number) {
    const now = Date.now();
    this.restarts = this.restarts.filter((time) => now - time < TUNNEL_RESTART_WINDOW_MS);
    const delay = nextTunnelRestartDelay(
      this.reason ?? "unknown",
      this.restarts,
      now,
      this.restartDelays,
    );
    if (delay === undefined) return;
    this.nextRetryAt = now + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.nextRetryAt = undefined;
      if (generation !== this.generation || this.state !== "error") return;
      this.restarts.push(Date.now());
      void this.launch().catch(() => undefined);
    }, delay);
    this.retryTimer.unref?.();
  }

  /** Whether the user stopped the Tunnel and has not started it again since. */
  get pausedByUser() {
    return this.stoppedByUser;
  }

  /**
   * An explicit start: lifts a user stop, cancels a scheduled retry and resets the
   * automatic-restart budget. Automatic paths check pausedByUser before calling it.
   */
  async start() {
    this.stoppedByUser = false;
    if (this.state === "running" || this.state === "starting") return;
    this.cancelRetry();
    this.restarts = [];
    await this.launch();
  }

  private async launch() {
    if (this.state === "running" || this.state === "starting") return;
    const executable = this.executable();
    this.exitCode = undefined;
    this.reason = undefined;
    if (!executable) {
      this.state = "missing";
      return;
    }
    this.state = "starting";
    this.logs = [];
    this.importantLogs = [];
    this.failureLogged = false;
    const run = new TunnelRunLog(Date.now());
    this.runLog = run;
    const argv = this.commandOverride
      ? [...this.commandOverride]
      : process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)
        ? [
            process.env.ComSpec ?? "cmd.exe",
            "/d",
            "/s",
            "/c",
            `""${executable}" run --profile kairomes"`,
          ]
        : [executable, "run", "--profile", "kairomes"];
    const guard = await createProcessGuard();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      child = Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ...(this.tunnelApiKey ? { CONTROL_PLANE_API_KEY: this.tunnelApiKey } : {}),
          // Companion owns the user-facing tunnel lifecycle. Keep the tunnel's
          // diagnostic web UI and console in the background unless the user
          // explicitly opens diagnostics from Kairomes.
          OPEN_WEB_UI: "false",
        },
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      guard.attach(child.pid);
    } catch (error) {
      child?.kill();
      guard.close();
      this.state = "error";
      this.reason = tunnelSpawnReason(error);
      this.addLog(error instanceof Error ? error.message : "Tunnel 無法啟動。");
      return;
    }
    const generation = ++this.generation;
    this.child = child;
    this.guard = guard;
    this.state = "running";
    this.startedAt = new Date().toISOString();
    const drained = Promise.all([
      this.collect(child.stdout instanceof ReadableStream ? child.stdout : null, run),
      this.collect(child.stderr instanceof ReadableStream ? child.stderr : null, run),
    ]);
    void child.exited.then(async (code) => {
      const exitedAt = Date.now();
      if (generation !== this.generation) return;
      this.child = undefined;
      this.guard = undefined;
      guard.close();
      // Classify only after the final lines arrive; a lingering pipe cannot hold this up.
      await Promise.race([drained, Bun.sleep(500)]);
      if (generation !== this.generation) return;
      this.exitCode = code;
      this.state = code === 0 && !this.failureLogged ? "stopped" : "error";
      this.addLog(code === 0 ? "Tunnel 已停止。" : `Tunnel 已結束，Exit ${code}。`);
      if (this.state !== "error") return;
      this.reason = tunnelExitReason(code, run.reason(exitedAt));
      this.scheduleRestart(generation);
    });
  }

  /**
   * Stops the Tunnel. `byUser` records an explicit stop, so that status polls, workbench
   * recovery and other automatic paths leave it stopped until the user starts it again.
   */
  async stop(byUser = false) {
    if (byUser) this.stoppedByUser = true;
    this.cancelRetry();
    this.restarts = [];
    this.generation++;
    const child = this.child;
    const guard = this.guard;
    this.child = undefined;
    this.guard = undefined;
    if (guard) {
      try {
        guard.close();
      } catch {
        child?.kill();
      }
    } else child?.kill();
    if (child) {
      await Promise.race([
        child.exited.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    this.state = "stopped";
    this.exitCode = undefined;
    this.startedAt = undefined;
    this.failureLogged = false;
    this.runLog = undefined;
    this.reason = undefined;
    this.addLog("Tunnel 已由 Companion 停止。");
  }

  async restart() {
    await this.stop();
    await this.start();
  }
}

class CompanionRuntime {
  private readonly handoffStarts = new HandoffStarts();
  private handoffService?: Promise<{
    briefs: HandoffBriefs;
    registry: WorkspaceRegistry;
    instanceId: string;
  }>;
  private settings: CompanionSettings = {};
  private registry?: WorkspaceRegistry;
  private ownedWorkbench?: Awaited<ReturnType<typeof startWorkbench>>;
  private external = false;
  private workbenchState: WorkbenchState = "starting";
  private workbenchMessage = "正在建立安全的本機工作階段。";
  /** Version reported by the attached workbench; ours when Companion owns it. */
  private workbenchVersion: string | null = null;
  private tunnel: TunnelSupervisor;
  private workbenchRecovery?: Promise<boolean>;
  private closed = false;

  constructor(
    private readonly dataDirectory: string,
    private readonly opener: BrowserOpener,
    private readonly autoStartTunnel: boolean,
    tunnelCommand?: readonly string[],
    tunnelApiKey?: string,
    tunnelRestartDelaysMs?: readonly number[],
  ) {
    this.tunnel = new TunnelSupervisor(tunnelCommand, tunnelApiKey, tunnelRestartDelaysMs);
  }

  async initialize() {
    try {
      this.settings = await readSettings(this.dataDirectory);
    } catch (error) {
      this.workbenchMessage = publicError(error).message;
      this.settings = {};
    }
    await this.startWorkbench();
    if (this.autoStartTunnel && ["running", "external"].includes(this.workbenchState))
      await this.tunnel.start();
  }

  private async startWorkbench() {
    if (this.closed) return;
    this.workbenchState = "starting";
    this.workbenchMessage = "正在建立安全的本機工作階段。";
    this.external = false;
    this.workbenchVersion = null;
    const [html, mcpResultHtml] = await Promise.all([loadWidget(), loadMcpResultWidget()]);
    if (!html) {
      this.workbenchState = "error";
      this.workbenchMessage = "缺少工作台資源，請重新安裝或建置 Kairomes。";
      return;
    }
    let registry: WorkspaceRegistry | undefined;
    try {
      registry = await WorkspaceRegistry.open(this.dataDirectory);
      const workbench = await startWorkbench(registry, html, 0, this.settings.extensionId, {
        mcpResultHtml,
        openBrowser: this.opener,
      });
      this.registry = registry;
      this.ownedWorkbench = workbench;
      this.workbenchVersion = VERSION;
      this.workbenchState = "running";
      this.workbenchMessage = "工作台由 Companion 管理；完全退出時會安全關閉。";
    } catch (error) {
      registry?.close();
      const safe = publicError(error);
      if (safe.code === "WORKBENCH_RUNNING") {
        try {
          const connection = await readWorkbenchConnection(this.dataDirectory);
          const health = await verifyWorkbenchConnection(connection);
          this.external = true;
          this.workbenchState = "external";
          this.workbenchVersion = health.version;
          this.workbenchMessage =
            health.version === VERSION
              ? "偵測到另一個 CMD 啟動的工作台。Companion 不會強制關閉它；停止舊程序後可重新接管。"
              : `既有工作台版本 ${health.version ?? "未知"} 與 Kairomes ${VERSION} 不同；停止舊程序後按重新接管。`;
          return;
        } catch {
          // Fall through to the original safe startup error.
        }
      }
      this.workbenchState = "error";
      this.workbenchMessage = safe.message;
    }
  }

  private async closeOwnedWorkbench() {
    this.handoffStarts.cancelAll();
    await this.closeHandoff();
    const workbench = this.ownedWorkbench;
    const registry = this.registry;
    this.ownedWorkbench = undefined;
    this.registry = undefined;
    if (workbench) await workbench.close();
    registry?.close();
  }

  private async workbenchConnection() {
    const connection = await readWorkbenchConnection(this.dataDirectory);
    const health = await verifyWorkbenchConnection(connection);
    if (this.external) this.workbenchVersion = health.version;
    return connection;
  }

  private async recoverLostExternalWorkbench() {
    if (this.workbenchRecovery) return this.workbenchRecovery;
    if (!this.external) return false;
    this.workbenchRecovery = (async () => {
      try {
        await this.workbenchConnection();
        return false;
      } catch {
        this.external = false;
        this.workbenchState = "starting";
        this.workbenchMessage = "舊工作台已停止，正在由 Kairomes Desktop 自動接管。";
        await this.startWorkbench();
        return Boolean(this.ownedWorkbench);
      }
    })();
    try {
      return await this.workbenchRecovery;
    } finally {
      this.workbenchRecovery = undefined;
    }
  }

  private async ensureWorkbenchReady() {
    await this.recoverLostExternalWorkbench();
    if (!["running", "external"].includes(this.workbenchState))
      throw new KairomesError("WORKBENCH_UNAVAILABLE", this.workbenchMessage);
  }

  private async withRegistry<T>(
    operation: (registry: WorkspaceRegistry) => T | Promise<T>,
  ): Promise<T> {
    if (this.registry) return operation(this.registry);
    const registry = await WorkspaceRegistry.open(this.dataDirectory);
    try {
      return await operation(registry);
    } finally {
      registry.close();
    }
  }

  private async workbenchPost(connection: WorkbenchConnection, route: string, token: string) {
    try {
      const response = await fetch(`${connection.origin}${route}`, {
        method: "POST",
        redirect: "error",
        headers: {
          Origin: connection.origin,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: route === "/api/approvals" ? JSON.stringify({ action: "list" }) : "{}",
        signal: AbortSignal.timeout(1500),
      });
      return response.ok ? ((await response.json()) as unknown) : null;
    } catch {
      return null;
    }
  }

  /**
   * Counts and grant metadata for the Desktop dashboard. Pending counts come from the admin list
   * Companion already uses; grants are read in-process from an owned workbench only, so an
   * external one reports grantsKnown=false. Nothing here carries fingerprints, argv, cwd or diffs.
   */
  private async attention(connection: WorkbenchConnection | null): Promise<CompanionAttention> {
    const owned = this.external ? undefined : this.ownedWorkbench;
    const grants = owned ? owned.accessSummary() : null;
    if (!connection)
      return {
        pending: null,
        grants,
        grantsKnown: grants !== null,
        lastMcpRequestAt: null,
        pairedPanels: null,
      };
    const [approvals, link] = await Promise.all([
      this.workbenchPost(connection, "/api/approvals", connection.adminToken),
      this.workbenchPost(connection, "/api/connection", connection.uiToken),
    ]);
    return {
      pending: pendingSummary(approvals),
      grants,
      grantsKnown: grants !== null,
      ...connectionSummary(link),
    };
  }

  /** Automatic Tunnel start, which never overrides an explicit stop by the user. */
  private get tunnelWanted() {
    return this.autoStartTunnel && !this.tunnel.pausedByUser;
  }

  async status(): Promise<CompanionStatus> {
    // Desktop polls this in the background, so recovery restarts the Tunnel only when wanted.
    const recovered = await this.recoverLostExternalWorkbench();
    if (recovered && this.tunnelWanted) await this.tunnel.restart();
    const tunnel = this.tunnel.snapshot();
    const connection = await this.workbenchConnection().catch(() => null);
    const attention = await this.attention(connection);
    const lastSeen = attention.lastMcpRequestAt;
    const workspaces = await this.withRegistry((registry) => registry.list());
    const workbenchReady = ["running", "external"].includes(this.workbenchState);
    const connector =
      !workbenchReady || tunnel.state !== "running"
        ? {
            state: "blocked" as const,
            label: "尚未就緒",
            message: "先讓本機工作台與 Tunnel 都進入執行中。",
            meta: "不會假裝已連上 ChatGPT",
          }
        : lastSeen
          ? {
              state: "connected" as const,
              label: "最近有連線",
              message: "Kairomes 已收到 ChatGPT 的 MCP 請求。",
              meta: `最近呼叫 · ${new Date(lastSeen).toLocaleString("zh-TW")}`,
            }
          : {
              state: "waiting" as const,
              label: "等待 ChatGPT",
              message: "Tunnel 已執行；若工具尚未出現，請在 ChatGPT Connector 按重新整理。",
              meta: "尚未收到這次啟動後的 MCP 請求",
            };
    const overall =
      this.workbenchState === "starting" || tunnel.state === "starting"
        ? { tone: "busy" as const, label: "正在準備本機工具" }
        : connector.state === "connected"
          ? { tone: "good" as const, label: "ChatGPT 與本機工具已連線" }
          : workbenchReady && tunnel.state === "running"
            ? { tone: "busy" as const, label: "等待 ChatGPT 使用工具" }
            : { tone: "warn" as const, label: "有一件事情需要處理" };
    const workbenchLabel = {
      starting: "正在啟動",
      running: "執行中",
      external: "既有程序",
      stopped: "已停止",
      error: "需要處理",
    }[this.workbenchState];
    return {
      version: VERSION,
      workbenchVersion: workbenchReady ? this.workbenchVersion : null,
      versionMismatch: workbenchReady && this.workbenchVersion !== VERSION,
      overall,
      workspaces,
      workbench: {
        state: this.workbenchState,
        label: workbenchLabel,
        message: this.workbenchMessage,
        meta: this.registry
          ? `${workspaces.length} 個專案 · 本機隨機連接埠`
          : this.external
            ? "既有工作台保持原本生命週期"
            : "尚未建立工作台",
      },
      tunnel,
      connector,
      extension: { configured: Boolean(this.settings.extensionId) },
      attention,
    };
  }

  async addWorkspace(root: string, name?: string) {
    const workspace = await this.withRegistry((registry) => registry.add(root, name));
    return { workspace };
  }

  async renameWorkspace(workspaceId: string, name: string) {
    const workspace = await this.withRegistry((registry) => registry.rename(workspaceId, name));
    return { workspace };
  }

  /** Desktop only: the one Companion response that carries absolute project roots. */
  async workspaceDetails() {
    return { workspaces: await this.withRegistry((registry) => registry.details()) };
  }

  /**
   * MCP servers for the Companion page rail: enabled and configured counts only, read the way
   * the host reads mcp-servers.json. Null when the file cannot be read or is invalid.
   */
  async mcpSummary(): Promise<{ mcp: { enabled: number; total: number } | null }> {
    const file = path.join(this.dataDirectory, "mcp-servers.json");
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > 1024 * 1024) return { mcp: null };
      const parsed = McpMountFileSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
      if (!parsed.success) return { mcp: null };
      const servers = parsed.data.servers;
      return {
        mcp: { enabled: servers.filter((server) => server.enabled).length, total: servers.length },
      };
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      return { mcp: missing ? { enabled: 0, total: 0 } : null };
    }
  }

  /**
   * `expectedVersion` is the caller's own version: Desktop passes its own, so a Companion or
   * workbench left over from another version is reported with its fix, and the summary is
   * headed with Desktop's version. It defaults to this Companion's version.
   */
  async diagnostics(expectedVersion = VERSION): Promise<DiagnosticsReport> {
    const tunnel = this.tunnel.snapshot();
    const checks = await collectDiagnostics({
      dataDirectory: this.dataDirectory,
      companion: { state: "running", version: VERSION },
      workbench: { state: this.workbenchState, version: this.workbenchVersion },
      tunnel: { state: tunnel.state, reason: tunnel.reason, nextRetryAt: tunnel.nextRetryAt },
      registry: this.registry,
      which: (command) =>
        command === "tunnel-client" ? this.tunnel.executable() : Bun.which(command),
      expectedVersion,
    });
    return { checks, summary: diagnosticSummary(checks, expectedVersion) };
  }

  async handoff(input: unknown, signal: AbortSignal) {
    const action = HandoffInputSchema.parse(input);
    // Cleanup needs only the existing draft service. A lost workbench must not
    // prevent cancellation or cause a replacement workbench to start.
    if (action.action === "cancel") {
      this.handoffStarts.cancel(action.draft_id);
      const service = await this.handoffService?.catch(() => null);
      return service ? service.briefs.perform(action, signal) : { cancelled: true };
    }
    if (action.action === "start")
      return this.handoffStarts.run(action, signal, (check) => this.handoffBriefs(check));
    return (await this.handoffBriefs()).perform(action, signal);
  }

  private async handoffBriefs(checkStart: () => void = () => undefined) {
    const check = () => {
      if (this.closed) throw new KairomesError("HANDOFF_EXPIRED", "接續服務已停止。");
      checkStart();
    };
    check();
    await this.ensureWorkbenchReady();
    check();
    const { instanceId } = await this.workbenchConnection();
    check();
    const existing = await this.handoffService;
    check();
    if (existing && existing.instanceId !== instanceId) {
      await this.closeHandoff();
      check();
    }
    if (!this.handoffService) {
      const pending = WorkspaceRegistry.open(this.dataDirectory).then((registry) => {
        if (this.closed || this.handoffService !== pending) {
          registry.close();
          throw new KairomesError("HANDOFF_EXPIRED", "接續服務已停止。");
        }
        return { briefs: new HandoffBriefs(registry), registry, instanceId };
      });
      this.handoffService = pending;
      void pending.catch(() => {
        if (this.handoffService === pending) this.handoffService = undefined;
      });
    }
    const { briefs } = await this.handoffService;
    check();
    return briefs;
  }

  private async closeHandoff() {
    const service = this.handoffService;
    this.handoffService = undefined;
    if (!service) return;
    const resources = await service.catch(() => null);
    if (!resources) return;
    const { briefs, registry } = resources;
    try {
      await briefs.close();
    } finally {
      registry.close();
    }
  }

  async removeWorkspace(workspaceId: string) {
    await this.withRegistry((registry) => registry.remove(workspaceId));
    return { workspaceId };
  }

  async retryWorkbench() {
    if (this.external) {
      try {
        await this.workbenchConnection();
        throw new KairomesError(
          "WORKBENCH_RUNNING",
          "舊工作台仍在執行；請先在原 CMD 按 Ctrl+C，再按重新接管。",
        );
      } catch (error) {
        if (error instanceof KairomesError && error.code === "WORKBENCH_RUNNING") throw error;
      }
      this.external = false;
    }
    await this.closeOwnedWorkbench();
    await this.startWorkbench();
    if (this.tunnelWanted && this.workbenchState === "running") await this.tunnel.start();
  }

  async configureExtension(extensionId: string) {
    if (!validExtensionId(extensionId))
      throw new KairomesError("EXTENSION_ID_INVALID", "請貼上瀏覽器顯示的 32 位 Extension ID。");
    this.settings = { extensionId };
    await writeSettings(this.dataDirectory, this.settings);
    await this.recoverLostExternalWorkbench();
    if (this.external)
      throw new KairomesError(
        "WORKBENCH_RUNNING",
        "Extension ID 已保存。請先停止舊工作台，再按重新接管完成配對。",
      );
    await this.tunnel.stop();
    await this.closeOwnedWorkbench();
    await this.startWorkbench();
    if (this.workbenchState !== "running")
      throw new KairomesError("WORKBENCH_UNAVAILABLE", this.workbenchMessage);
    if (this.tunnelWanted) await this.tunnel.start();
    return this.createPairing();
  }

  async createPairing() {
    if (!this.settings.extensionId)
      throw new KairomesError("EXTENSION_ID_REQUIRED", "請先貼上並儲存 Extension ID。");
    await this.ensureWorkbenchReady();
    const connection = await this.workbenchConnection();
    const response = await fetch(`${connection.origin}/api/pairing/create`, {
      method: "POST",
      redirect: "error",
      headers: {
        Origin: connection.origin,
        Authorization: `Bearer ${connection.adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ extensionId: this.settings.extensionId }),
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (!response.ok)
      throw new KairomesError("PAIRING_FAILED", result.message ?? "無法產生配對連結。");
    // The link itself is a one-time credential: return it to the trusted caller, never log it.
    const expiresInSeconds = Number(result.expiresInSeconds);
    return {
      pairingUrl: String(result.pairingUrl),
      ...(Number.isSafeInteger(expiresInSeconds) && expiresInSeconds > 0 && expiresInSeconds <= 3600
        ? { expiresInSeconds }
        : {}),
    };
  }

  async openWorkbench() {
    await this.ensureWorkbenchReady();
    const connection = await this.workbenchConnection();
    await this.opener(`${connection.origin}/#session=${connection.uiToken}`);
  }

  async openConnectors() {
    await this.opener(CHATGPT_CONNECTORS_URL);
  }

  async startTunnel() {
    await this.ensureWorkbenchReady();
    await this.tunnel.start();
  }

  async stopTunnel() {
    await this.tunnel.stop(true);
  }

  async restartTunnel() {
    await this.ensureWorkbenchReady();
    await this.tunnel.restart();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.handoffStarts.close();
    await this.closeHandoff();
    await this.tunnel.stop();
    await this.closeOwnedWorkbench();
    this.workbenchState = "stopped";
    this.workbenchMessage = "Companion 已停止。";
  }
}

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open_workbench") }).strict(),
  z.object({ action: z.literal("open_connectors") }).strict(),
  z.object({ action: z.literal("retry_workbench") }).strict(),
  z.object({ action: z.literal("start_tunnel") }).strict(),
  z.object({ action: z.literal("stop_tunnel") }).strict(),
  z.object({ action: z.literal("restart_tunnel") }).strict(),
  z.object({ action: z.literal("create_pairing") }).strict(),
  z.object({ action: z.literal("configure_extension"), extensionId: z.string().max(64) }).strict(),
  z
    .object({
      action: z.literal("workspace_add"),
      path: z.string().trim().min(1).max(32767),
      name: z.string().trim().min(1).max(80).optional(),
    })
    .strict(),
  z.object({ action: z.literal("workspace_remove"), workspaceId: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal("workspace_rename"),
      workspace_id: z.string().uuid(),
      name: z.string().trim().min(1).max(80),
    })
    .strict(),
  z.object({ action: z.literal("workspace_details") }).strict(),
  z
    .object({
      action: z.literal("diagnostics"),
      /** The caller's version, compared with this Companion and its workbench. */
      expectedVersion: z
        .string()
        .max(64)
        .refine((value) => parseVersion(value) !== null, "版本格式不正確。")
        .optional(),
    })
    .strict(),
  z.object({ action: z.literal("mcp_summary") }).strict(),
  z.object({ action: z.literal("quit") }).strict(),
]);

function equalToken(expected: string, candidate: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(candidate);
  return left.length === right.length && timingSafeEqual(left, right);
}

type CompanionApplication = {
  reused: boolean;
  url: string;
  closed: Promise<void>;
  close(): Promise<void>;
};

export async function startCompanionApplication(options: {
  dataDirectory: string;
  port?: number;
  openBrowser?: boolean;
  autoStartTunnel?: boolean;
  opener?: BrowserOpener;
  tunnelCommand?: readonly string[];
  tunnelApiKey?: string;
  /** Test hook: automatic Tunnel restart delays; defaults to 2 s, 10 s and 30 s. */
  tunnelRestartDelaysMs?: readonly number[];
}): Promise<CompanionApplication> {
  // Desktop hands the credential to this process. Keep it only in memory until
  // launching the official tunnel-client; the workbench must not inherit it.
  const tunnelApiKey = options.tunnelApiKey ?? process.env.CONTROL_PLANE_API_KEY;
  delete process.env.CONTROL_PLANE_API_KEY;
  const opener = options.opener ?? openExternal;
  try {
    const existing = await readCompanionConnection(options.dataDirectory);
    await verifyCompanionConnection(existing);
    const url = `${existing.origin}/#session=${existing.token}`;
    if (options.openBrowser !== false) await opener(url);
    return { reused: true, url, closed: Promise.resolve(), close: async () => undefined };
  } catch {
    // No verified Companion is running; acquisition below removes only a stale descriptor.
  }

  const runtime = new CompanionRuntime(
    options.dataDirectory,
    opener,
    options.autoStartTunnel !== false,
    options.tunnelCommand,
    tunnelApiKey,
    options.tunnelRestartDelaysMs,
  );
  const instanceId = crypto.randomUUID();
  const token = randomBytes(32).toString("hex");
  const page = companionPage(VERSION);
  const scriptHashes = Array.from(
    page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g),
    (match) =>
      `'sha256-${createHash("sha256")
        .update(match[1] ?? "")
        .digest("base64")}'`,
  ).join(" ");
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'none'; script-src ${scriptHashes}; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let shuttingDown = false;
  let release: () => Promise<void> = async () => undefined;
  let server: ReturnType<typeof Bun.serve>;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runtime.close();
    server.stop(true);
    await release();
    resolveClosed();
  };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    maxRequestBodySize: 64 * 1024,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${bunServer.port}`;
      if (
        request.headers.get("host") !== `127.0.0.1:${bunServer.port}` ||
        url.hostname !== "127.0.0.1"
      )
        return new Response("Invalid host", { status: 403, headers });
      if (request.method === "GET" && url.pathname === "/healthz")
        return Response.json({ status: "ok", instanceId, version: VERSION }, { headers });
      if (request.method === "GET" && url.pathname === "/")
        return new Response(page, {
          headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
        });
      if (
        request.method !== "POST" ||
        !["/api/status", "/api/action", "/api/handoff"].includes(url.pathname)
      )
        return new Response("Not found", { status: 404, headers });
      if (request.headers.get("origin") !== origin)
        return new Response("Invalid origin", { status: 403, headers });
      const candidate = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!equalToken(token, candidate))
        return Response.json(
          { message: "控制憑證無效，請重新啟動 Companion。" },
          { status: 401, headers },
        );
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        return new Response("Expected JSON", { status: 415, headers });
      try {
        const body = await request.text();
        if (Buffer.byteLength(body) > (url.pathname === "/api/handoff" ? 64 * 1024 : 4096))
          throw new KairomesError("REQUEST_TOO_LARGE", "本機請求超過大小上限。");
        const parsedBody: unknown = JSON.parse(body);
        if (url.pathname === "/api/handoff")
          return Response.json(await runtime.handoff(parsedBody, request.signal), { headers });
        if (url.pathname === "/api/status") {
          z.object({}).strict().parse(parsedBody);
          return Response.json(await runtime.status(), { headers });
        }
        const input = ActionSchema.parse(parsedBody);
        let result: Record<string, unknown> = {};
        if (input.action === "open_workbench") await runtime.openWorkbench();
        else if (input.action === "open_connectors") await runtime.openConnectors();
        else if (input.action === "retry_workbench") await runtime.retryWorkbench();
        else if (input.action === "start_tunnel") await runtime.startTunnel();
        else if (input.action === "stop_tunnel") await runtime.stopTunnel();
        else if (input.action === "restart_tunnel") await runtime.restartTunnel();
        else if (input.action === "create_pairing") result = await runtime.createPairing();
        else if (input.action === "configure_extension")
          result = await runtime.configureExtension(input.extensionId);
        else if (input.action === "workspace_add")
          result = await runtime.addWorkspace(input.path, input.name);
        else if (input.action === "workspace_remove")
          result = await runtime.removeWorkspace(input.workspaceId);
        else if (input.action === "workspace_rename")
          result = await runtime.renameWorkspace(input.workspace_id, input.name);
        else if (input.action === "workspace_details") result = await runtime.workspaceDetails();
        else if (input.action === "diagnostics")
          result = await runtime.diagnostics(input.expectedVersion);
        else if (input.action === "mcp_summary") result = await runtime.mcpSummary();
        else if (input.action === "quit") setTimeout(() => void shutdown(), 80);
        return Response.json({ ok: true, ...result }, { headers });
      } catch (error) {
        return Response.json(publicError(error), { status: 400, headers });
      }
    },
    error() {
      return new Response("Request failed", { status: 500, headers });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const connection = ConnectionSchema.parse({ instanceId, pid: process.pid, origin, token });
  const acquired = await acquireCompanionConnection(options.dataDirectory, connection);
  if (acquired.kind === "existing") {
    server.stop(true);
    await runtime.close();
    const url = `${acquired.connection.origin}/#session=${acquired.connection.token}`;
    if (options.openBrowser !== false) await opener(url);
    resolveClosed();
    return { reused: true, url, closed, close: async () => undefined };
  }
  release = acquired.release;
  await runtime.initialize();
  const url = `${origin}/#session=${token}`;
  if (options.openBrowser !== false) await opener(url);
  return { reused: false, url, closed, close: shutdown };
}

export async function runCompanion(options: {
  dataDirectory: string;
  port?: number;
  openBrowser?: boolean;
  autoStartTunnel?: boolean;
  opener?: BrowserOpener;
  tunnelCommand?: readonly string[];
  tunnelApiKey?: string;
}) {
  const application = await startCompanionApplication(options);
  if (application.reused) return;
  const close = () => void application.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await application.closed;
  } finally {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
  }
}
