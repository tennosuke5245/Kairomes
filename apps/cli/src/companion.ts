import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  createProcessGuard,
  loadMcpResultWidget,
  loadWidget,
  readWorkbenchConnection,
  startWorkbench,
  verifyWorkbenchConnection,
} from "@kairomes/daemon";
import { KairomesError, publicError, VERSION, z } from "@kairomes/protocol";
import { WorkspaceRegistry } from "@kairomes/workspace-core";
import { companionPage } from "./companion-page.ts";
import { validExtensionId } from "./extension-id.ts";

const SETTINGS_FILE = "companion-settings.json";
const CONNECTION_FILE = "companion-connection.json";
const CHATGPT_CONNECTORS_URL = "https://chatgpt.com/#settings/Connectors";
const sourceLogo = fileURLToPath(
  new URL("../../extension/assets/kairomes-k-128.png", import.meta.url),
);

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

type TunnelState = "missing" | "starting" | "running" | "stopped" | "error";
type WorkbenchState = "starting" | "running" | "external" | "stopped" | "error";

type CompanionStatus = {
  version: string;
  overall: { tone: "good" | "warn" | "busy"; label: string };
  workspaces: ReturnType<WorkspaceRegistry["list"]>;
  workbench: {
    state: WorkbenchState;
    label: string;
    message: string;
    meta: string;
  };
  tunnel: {
    state: TunnelState;
    label: string;
    message: string;
    meta: string;
    logs: string[];
  };
  connector: {
    state: "connected" | "waiting" | "blocked";
    label: string;
    message: string;
    meta: string;
  };
  extension: { configured: boolean };
};

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

async function loadLogoBase64() {
  const candidates = [
    sourceLogo,
    path.join(path.dirname(process.execPath), "resources", "kairomes-k-128.png"),
  ];
  for (const candidate of candidates) {
    try {
      return (await readFile(candidate)).toString("base64");
    } catch {
      // Source checkout and packaged executable use different roots.
    }
  }
  throw new KairomesError("COMPANION_ASSET_MISSING", "找不到 Companion 標誌資源。");
}

async function openExternal(url: string) {
  const argv =
    process.platform === "win32"
      ? [
          path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe"),
          "url.dll,FileProtocolHandler",
          url,
        ]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const exitCode = await child.exited;
  if (exitCode !== 0)
    throw new KairomesError("OPEN_FAILED", "無法開啟瀏覽器，請重新啟動 Companion。");
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
  private failureReason?: string;

  constructor(
    private readonly commandOverride?: readonly string[],
    private readonly tunnelApiKey?: string,
  ) {}

  snapshot() {
    const label = {
      missing: "尚未安裝",
      starting: "正在啟動",
      running: "執行中",
      stopped: "已停止",
      error: "需要處理",
    }[this.state];
    const message =
      this.state === "missing"
        ? "PATH 中找不到官方 tunnel-client。安裝後按啟動即可重新檢查。"
        : this.state === "starting"
          ? "正在啟動官方 Tunnel profile：kairomes。"
          : this.state === "running"
            ? "官方 Tunnel 正在背景執行；關閉這個頁面不會中斷。"
            : this.state === "error"
              ? `Tunnel 啟動後停止${
                  this.exitCode === undefined || this.exitCode === 0
                    ? ""
                    : `（Exit ${this.exitCode}）`
                }；展開最近訊息查看原因。`
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
    this.failureReason ??= line;
    if (!this.importantLogs.includes(line)) this.importantLogs.push(line);
    if (this.importantLogs.length > 6) this.importantLogs.splice(0, this.importantLogs.length - 6);
  }

  private addLog(value: string) {
    for (const line of value.split(/\r?\n/)) {
      let clean = stripTerminalControls(line);
      if (this.tunnelApiKey) clean = clean.replaceAll(this.tunnelApiKey, "[redacted]");
      clean = clean.slice(0, 500);
      if (clean) {
        this.logs.push(clean);
        this.rememberImportantLog(clean);
      }
    }
    if (this.logs.length > 80) this.logs.splice(0, this.logs.length - 80);
  }

  private async collect(stream: ReadableStream<Uint8Array> | null) {
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
        this.addLog(lines.join("\n"));
      }
      pending += decoder.decode();
      this.addLog(pending);
    } catch {
      // Process exit can close the stream while a read is pending.
    } finally {
      reader.releaseLock();
    }
  }

  async start() {
    if (this.state === "running" || this.state === "starting") return;
    const executable = this.commandOverride?.[0] ?? Bun.which("tunnel-client");
    if (!executable) {
      this.state = "missing";
      this.exitCode = undefined;
      return;
    }
    this.state = "starting";
    this.exitCode = undefined;
    this.logs = [];
    this.importantLogs = [];
    this.failureReason = undefined;
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
      this.addLog(error instanceof Error ? error.message : "Tunnel 無法啟動。");
      return;
    }
    const generation = ++this.generation;
    this.child = child;
    this.guard = guard;
    this.state = "running";
    this.startedAt = new Date().toISOString();
    void this.collect(child.stdout instanceof ReadableStream ? child.stdout : null);
    void this.collect(child.stderr instanceof ReadableStream ? child.stderr : null);
    void child.exited.then((code) => {
      if (generation !== this.generation) return;
      this.child = undefined;
      this.guard = undefined;
      guard.close();
      this.exitCode = code;
      this.state = code === 0 && !this.failureReason ? "stopped" : "error";
      this.addLog(code === 0 ? "Tunnel 已停止。" : `Tunnel 已結束，Exit ${code}。`);
    });
  }

  async stop() {
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
    this.failureReason = undefined;
    this.addLog("Tunnel 已由 Companion 停止。");
  }

  async restart() {
    await this.stop();
    await this.start();
  }
}

class CompanionRuntime {
  private settings: CompanionSettings = {};
  private registry?: WorkspaceRegistry;
  private ownedWorkbench?: Awaited<ReturnType<typeof startWorkbench>>;
  private external = false;
  private workbenchState: WorkbenchState = "starting";
  private workbenchMessage = "正在建立安全的本機工作階段。";
  private tunnel: TunnelSupervisor;
  private workbenchRecovery?: Promise<boolean>;
  private closed = false;

  constructor(
    private readonly dataDirectory: string,
    private readonly opener: BrowserOpener,
    private readonly autoStartTunnel: boolean,
    tunnelCommand?: readonly string[],
    tunnelApiKey?: string,
  ) {
    this.tunnel = new TunnelSupervisor(tunnelCommand, tunnelApiKey);
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
      });
      this.registry = registry;
      this.ownedWorkbench = workbench;
      this.workbenchState = "running";
      this.workbenchMessage = "工作台由 Companion 管理；完全退出時會安全關閉。";
    } catch (error) {
      registry?.close();
      const safe = publicError(error);
      if (safe.code === "WORKBENCH_RUNNING") {
        try {
          const connection = await readWorkbenchConnection(this.dataDirectory);
          await verifyWorkbenchConnection(connection);
          this.external = true;
          this.workbenchState = "external";
          this.workbenchMessage =
            "偵測到另一個 CMD 啟動的工作台。Companion 不會強制關閉它；停止舊程序後可重新接管。";
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
    const workbench = this.ownedWorkbench;
    const registry = this.registry;
    this.ownedWorkbench = undefined;
    this.registry = undefined;
    if (workbench) await workbench.close();
    registry?.close();
  }

  private async workbenchConnection() {
    const connection = await readWorkbenchConnection(this.dataDirectory);
    await verifyWorkbenchConnection(connection);
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

  private async connectorLastSeen() {
    try {
      const connection = await this.workbenchConnection();
      const response = await fetch(`${connection.origin}/api/connection`, {
        method: "POST",
        redirect: "error",
        headers: {
          Origin: connection.origin,
          Authorization: `Bearer ${connection.uiToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return null;
      const body = await response.json();
      return typeof body.lastMcpRequestAt === "string" ? body.lastMcpRequestAt : null;
    } catch {
      return null;
    }
  }

  async status(): Promise<CompanionStatus> {
    const recovered = await this.recoverLostExternalWorkbench();
    if (recovered && this.autoStartTunnel) await this.tunnel.restart();
    const tunnel = this.tunnel.snapshot();
    const lastSeen = await this.connectorLastSeen();
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
    };
  }

  async addWorkspace(root: string, name?: string) {
    const workspace = await this.withRegistry((registry) => registry.add(root, name));
    return { workspace };
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
    if (this.autoStartTunnel && this.workbenchState === "running") await this.tunnel.start();
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
    if (this.autoStartTunnel) await this.tunnel.start();
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
    return { pairingUrl: String(result.pairingUrl) };
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
    await this.tunnel.stop();
  }

  async restartTunnel() {
    await this.ensureWorkbenchReady();
    await this.tunnel.restart();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
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
  );
  const instanceId = crypto.randomUUID();
  const token = randomBytes(32).toString("hex");
  const page = companionPage(await loadLogoBase64(), VERSION);
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
    maxRequestBodySize: 4096,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${bunServer.port}`;
      if (
        request.headers.get("host") !== `127.0.0.1:${bunServer.port}` ||
        url.hostname !== "127.0.0.1"
      )
        return new Response("Invalid host", { status: 403, headers });
      if (request.method === "GET" && url.pathname === "/healthz")
        return Response.json({ status: "ok", instanceId }, { headers });
      if (request.method === "GET" && url.pathname === "/")
        return new Response(page, {
          headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
        });
      if (request.method !== "POST" || !["/api/status", "/api/action"].includes(url.pathname))
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
        if (url.pathname === "/api/status") {
          z.object({})
            .strict()
            .parse(await request.json());
          return Response.json(await runtime.status(), { headers });
        }
        const input = ActionSchema.parse(await request.json());
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
