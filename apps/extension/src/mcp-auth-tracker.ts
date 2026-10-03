import {
  type McpAuthInput,
  McpAuthInputSchema,
  McpAuthResultSchema,
  type McpAuthSummary,
} from "@kairomes/protocol";
import { mcpAuthDiagnostic } from "./mcp-auth-diagnostic.ts";

type Intent = Extract<McpAuthInput, { action: "start" | "forget" }>;
export interface SavedMcpAuth {
  request: Intent;
  cancelling: boolean;
  previous?: { request: Intent; cancelling: boolean };
}
interface Pending extends SavedMcpAuth {
  unknown: boolean;
}
export interface McpAuthIdentity {
  instance_id: string;
  server_id: string;
  config_fingerprint: string;
}
const matches = (a: McpAuthIdentity, b: McpAuthIdentity) =>
  a.instance_id === b.instance_id &&
  a.server_id === b.server_id &&
  a.config_fingerprint === b.config_fingerprint;

/** OAuth receipts belong to an operation; catalog changes never clear these records. */
export class McpAuthTracker {
  private source?: string;
  private pending = new Map<string, Pending>();
  private summaries = new Map<string, McpAuthSummary>();

  bind(source?: string) {
    if (source === this.source) return;
    this.source = source;
    this.pending.clear();
    this.summaries.clear();
  }
  current(identity: McpAuthIdentity) {
    const value = this.pending.get(identity.server_id);
    return value && matches(value.request, identity) ? value : undefined;
  }
  summary(identity: McpAuthIdentity) {
    return this.summaries.get(this.key(identity));
  }
  private key(identity: McpAuthIdentity) {
    return `${identity.server_id}:${identity.config_fingerprint}`;
  }
  observeSummary(identity: McpAuthIdentity, summary: McpAuthSummary) {
    const previous = this.summary(identity);
    if (!previous || summary.phase_version > previous.phase_version)
      this.summaries.set(this.key(identity), structuredClone(summary));
  }
  begin(source: string, request: Intent) {
    if (source !== this.source) return false;
    const previous = this.current(request);
    if (previous && (request.action !== "forget" || previous.request.action === "forget"))
      return false;
    this.pending.set(request.server_id, {
      request: structuredClone(request),
      cancelling: false,
      unknown: false,
      ...(previous
        ? { previous: { request: previous.request, cancelling: previous.cancelling } }
        : {}),
    });
    return true;
  }
  cancel(source: string, identity: McpAuthIdentity): McpAuthInput | undefined {
    const pending = this.current(identity);
    if (source !== this.source || !pending || pending.unknown || pending.request.action !== "start")
      return;
    pending.cancelling = true;
    return { ...pending.request, action: "cancel" };
  }
  query(identity: McpAuthIdentity): McpAuthInput | undefined {
    const pending = this.current(identity);
    if (!pending) return;
    const { accept_before: _, action, ...request } = pending.request;
    return { ...request, action: "status", operation: action === "start" ? "login" : "forget" };
  }
  queryStillCurrent(source: string, snapshot?: SavedMcpAuth) {
    return (
      source === this.source &&
      snapshot !== undefined &&
      JSON.stringify(this.saved(snapshot.request)) === JSON.stringify(snapshot)
    );
  }
  markUnknown(source: string, request: McpAuthInput) {
    const pending = this.current(request);
    if (source === this.source && pending?.request.operation_id === request.operation_id)
      pending.unknown = true;
  }
  reject(source: string, request: McpAuthInput) {
    const pending = this.current(request);
    if (source !== this.source || pending?.request.operation_id !== request.operation_id) return;
    if (request.action === "cancel") {
      pending.cancelling = false;
      pending.unknown = true;
      return;
    }
    if (pending.previous)
      this.pending.set(request.server_id, { ...pending.previous, unknown: true });
    else this.pending.delete(request.server_id);
  }
  accept(source: string, value: unknown) {
    if (source !== this.source) return false;
    const parsed = McpAuthResultSchema.safeParse(value);
    if (!parsed.success) return false;
    const result = parsed.data;
    const pending = this.current(result);
    if (
      !pending ||
      pending.request.operation_id !== result.operation_id ||
      result.operation !== (pending.request.action === "start" ? "login" : "forget")
    )
      return false;
    this.observeSummary(result, result);
    if (result.receipt_outcome === "missing" || result.receipt_outcome === "expired") {
      pending.unknown = true;
    } else if (result.receipt_outcome === "pending") {
      // A pending start is accepted evidence; it cannot prove a lost cancel finished.
      pending.unknown = pending.cancelling;
    } else if (result.receipt_outcome === "failed" && pending.previous) {
      this.pending.set(result.server_id, { ...pending.previous, unknown: true });
    } else this.pending.delete(result.server_id);
    return true;
  }
  saved(identity: McpAuthIdentity): SavedMcpAuth | undefined {
    const pending = this.current(identity);
    if (!pending) return;
    const { unknown: _, ...saved } = pending;
    return structuredClone(saved);
  }
  restore(source: string, identity: McpAuthIdentity, value: unknown) {
    if (source !== this.source) return false;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const saved = value as SavedMcpAuth;
    if (
      Object.keys(saved).some((key) => !["request", "cancelling", "previous"].includes(key)) ||
      typeof saved.cancelling !== "boolean"
    )
      return false;
    const parsed = McpAuthInputSchema.safeParse(saved.request);
    if (
      !parsed.success ||
      !["start", "forget"].includes(parsed.data.action) ||
      !matches(parsed.data, identity)
    )
      return false;
    const request = parsed.data as Intent;
    let previous: SavedMcpAuth["previous"];
    if (saved.previous) {
      const old = McpAuthInputSchema.safeParse(saved.previous.request);
      if (
        request.action !== "forget" ||
        !old.success ||
        old.data.action !== "start" ||
        !matches(old.data, identity) ||
        old.data.operation_id === request.operation_id ||
        typeof saved.previous.cancelling !== "boolean" ||
        Object.keys(saved.previous).some((key) => !["request", "cancelling"].includes(key))
      )
        return false;
      previous = { request: old.data, cancelling: saved.previous.cancelling };
    }
    if (request.action === "forget" && saved.cancelling) return false;
    this.pending.set(request.server_id, {
      request,
      cancelling: saved.cancelling,
      unknown: true,
      ...(previous ? { previous } : {}),
    });
    return true;
  }
}

export class McpAuthStorageConflict extends Error {
  constructor(readonly saved: unknown) {
    super("登入狀態待確認");
  }
}
interface Storage {
  get(key: string): Promise<Record<string, unknown>>;
  set(data: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}
export async function writeMcpAuthPending(
  storage: Storage,
  key: string,
  next: SavedMcpAuth | undefined,
  expected: unknown,
  lock: (key: string, work: () => Promise<void>) => Promise<void>,
) {
  await lock(key, async () => {
    const current = (await storage.get(key))[key];
    if (JSON.stringify(current) !== JSON.stringify(expected))
      throw new McpAuthStorageConflict(current);
    if (next) await storage.set({ [key]: next });
    else await storage.remove(key);
  });
}

export function mcpAuthPresentation(
  summary: McpAuthSummary,
  pending?: { unknown: boolean; cancelling: boolean; request: Intent },
  startingRequest = false,
) {
  if (pending?.unknown)
    return { label: "登入狀態待確認", action: "query" as const, button: "查詢狀態" };
  if (startingRequest && pending?.request.action === "start" && !pending.cancelling)
    return { label: "啟動登入中…", action: "none" as const, button: "" };
  if (pending?.request.action === "forget")
    return { label: "清除登入中…", action: "query" as const, button: "查詢狀態" };
  if (pending?.cancelling)
    return { label: "取消登入中…", action: "query" as const, button: "查詢狀態" };
  if (pending && !["starting", "waiting", "verifying"].includes(summary.auth_phase))
    return { label: "登入狀態待確認", action: "query" as const, button: "查詢狀態" };
  if (summary.auth_phase === "starting" || summary.auth_phase === "waiting")
    return { label: "等待登入", action: "cancel" as const, button: "取消登入" };
  if (summary.auth_phase === "verifying")
    return { label: "確認登入中…", action: "none" as const, button: "" };
  if (
    summary.auth_phase === "authenticated" &&
    ["unknown", "loading"].includes(summary.tools_status)
  )
    return { label: "取得工具中…", action: "none" as const, button: "" };
  if (summary.auth_phase === "authenticated" && summary.tools_status === "current")
    return { label: "已連線", action: "refresh" as const, button: "重新探索" };
  if (summary.auth_phase === "authenticated" && ["error", "stale"].includes(summary.tools_status))
    return {
      label:
        mcpAuthDiagnostic(summary.error_code)?.category === "connection"
          ? "MCP 連線失敗"
          : "工具清單讀取失敗",
      action: "refresh" as const,
      button: "重試",
    };
  if (summary.error_code === "browser_open_failed")
    return { label: "無法開啟瀏覽器", action: "start" as const, button: "再次開啟" };
  if (summary.error_code === "auth_expired")
    return { label: "登入逾時", action: "start" as const, button: "重新登入" };
  if (summary.error_code === "auth_unsupported")
    return { label: "此服務尚不支援登入", action: "none" as const, button: "" };
  if (summary.auth_phase === "required")
    return {
      label: summary.tools_status === "stale" ? "需重新登入" : "需要登入",
      action: "start" as const,
      button: "登入",
    };
  return { label: "登入失敗", action: "start" as const, button: "重試登入" };
}
