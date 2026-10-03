import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { KairomesError, VERSION } from "@kairomes/protocol";

type RpcId = string | number;
type RpcMessage = {
  id?: RpcId;
  method?: string;
  result?: unknown;
  error?: unknown;
};
export interface CodexConnection {
  start(): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/** Dedicated stdio child; no generic RPC endpoint is exposed to the browser. */
export class CodexRpc implements CodexConnection {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private ready = false;
  private nextId = 1;
  private pending = new Map<
    RpcId,
    {
      resolve(value: unknown): void;
      reject(error: unknown): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private readonly directory: string,
    private readonly command: string | null,
    private readonly timeout: number,
    private readonly args: string[],
    private readonly capabilities: { experimentalApi?: boolean } = {},
  ) {}

  get connected() {
    return this.ready;
  }

  start(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async launch() {
    if (!this.command)
      throw new KairomesError("CODEX_MISSING", "找不到 Codex CLI。請先安裝後重新執行交接指令。");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (
        value &&
        /^(path|pathext|systemroot|windir|temp|tmp|home|userprofile|localappdata|appdata|lang|term|comspec)$/i.test(
          key,
        )
      )
        env[key] = value;
    }
    // Handoff reads the explicitly selected local Codex home.
    env.CODEX_HOME = this.directory;
    const child = spawn(this.command, this.args, {
      cwd: this.directory,
      env,
      windowsHide: true,
      stdio: "pipe",
    });
    this.child = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) {
        child.kill();
        return;
      }
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          this.receive(JSON.parse(line));
        } catch {
          /* Ignore non-protocol lines; never expose stdout as HTML. */
        }
        end = buffer.indexOf("\n");
      }
    });
    child.stderr.resume();
    let lost = false;
    const disconnect = () => {
      if (lost) return;
      lost = true;
      this.ready = false;
      for (const call of this.pending.values()) {
        clearTimeout(call.timer);
        call.reject(
          new KairomesError("CODEX_DISCONNECTED", "Codex 來源已斷線，請重新執行交接指令。"),
        );
      }
      this.pending.clear();
    };
    child.on("error", () => {
      disconnect();
      if (!child.pid && this.child === child) this.child = undefined;
      else child.kill();
    });
    child.on("exit", () => {
      disconnect();
      if (this.child === child) this.child = undefined;
    });
    child.stdin.on("error", () => {
      disconnect();
      // A broken input pipe does not prove process exit. Keep ownership until the
      // exit event so close() can wait for and finish cleanup of this reader.
      child.kill();
    });
    try {
      await this.request("initialize", {
        clientInfo: { name: "kairomes", title: "Kairomes", version: VERSION },
        capabilities: this.capabilities,
      });
      this.write({ method: "initialized", params: {} });
      this.ready = true;
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  private write(message: unknown) {
    if (!this.child || this.child.killed)
      throw new KairomesError("CODEX_DISCONNECTED", "Codex 來源尚未連線。");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new KairomesError(
            "CODEX_TIMEOUT",
            "Codex 來源未在期限內回覆；要求可能已送達，請重試交接指令。",
          ),
        );
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private receive(message: RpcMessage) {
    if (!message || typeof message !== "object") return;
    if (message.method) {
      if (message.id !== undefined) this.reject(message.id);
      return;
    }
    if (message.id === undefined) return;
    const call = this.pending.get(message.id);
    if (!call) return;
    clearTimeout(call.timer);
    this.pending.delete(message.id);
    if (message.error)
      call.reject(
        new KairomesError("CODEX_REQUEST_FAILED", "Codex 來源拒絕此操作。請確認工作區與來源狀態。"),
      );
    else call.resolve(message.result);
  }

  private reject(id: RpcId) {
    this.write({
      id,
      error: { code: -32601, message: "This client does not support this request." },
    });
  }

  async close() {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    await exited;
    clearTimeout(timer);
  }
}
