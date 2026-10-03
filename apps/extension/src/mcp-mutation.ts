import { McpPanelInputSchema, type McpPanelState, mcpConfigFingerprint } from "@kairomes/protocol";

export type McpMutationResult<T> =
  | { outcome: "applied"; state: T }
  | { outcome: "reconciled"; state: T }
  | { outcome: "unknown"; state?: T };

export type McpMutationBody = { action: string; [key: string]: unknown };

export interface McpMutationScope {
  source?: string;
  generation: number;
}

export async function mcpAddFingerprint(body: McpMutationBody) {
  const result = McpPanelInputSchema.safeParse(body);
  if (!result.success) return undefined;
  const input = result.data;
  if (input.action === "add_stdio")
    return mcpConfigFingerprint({
      name: input.name,
      transport: {
        kind: "stdio",
        command: input.command,
        args: input.args,
        env: input.env,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      },
    });
  if (input.action === "add_http")
    return mcpConfigFingerprint({
      name: input.name,
      transport: { kind: "http", url: input.url, header_env: input.header_env },
    });
  return undefined;
}

/** Catalog revisions are digests, not receipts for a particular mutation. */
export function mcpMutationObserved(
  base: McpPanelState,
  next: McpPanelState,
  body: McpMutationBody,
  expectedFingerprint?: string,
) {
  if (base.catalog_revision === next.catalog_revision) return false;
  if (body.action === "add_stdio" || body.action === "add_http") {
    if (!expectedFingerprint) return false;
    const ids = new Set(base.servers.map((server) => server.id));
    const matching = next.servers.filter(
      (server) =>
        !ids.has(server.id) &&
        server.name === body.name &&
        server.transport === (body.action === "add_stdio" ? "stdio" : "http") &&
        server.config_fingerprint === expectedFingerprint &&
        server.enabled,
    );
    return matching.length === 1;
  }
  const before = base.servers.find((server) => server.id === body.server_id);
  if (!before) return false;
  const after = next.servers.find((server) => server.id === body.server_id);
  if (body.action === "remove") return !after;
  if (
    !after ||
    after.name !== before.name ||
    after.transport !== before.transport ||
    !before.config_fingerprint ||
    after.config_fingerprint !== before.config_fingerprint
  )
    return false;
  if (body.action === "set_server_enabled")
    return before.enabled !== body.enabled && after.enabled === body.enabled;
  if (body.action === "set_tool_enabled") {
    const oldTool = before.tools.find((tool) => tool.name === body.tool_name);
    const newTool = after.tools.find((tool) => tool.name === body.tool_name);
    return Boolean(
      oldTool &&
        newTool &&
        newTool.server_id === oldTool.server_id &&
        newTool.schema_fingerprint === oldTool.schema_fingerprint &&
        oldTool.enabled !== body.enabled &&
        newTool.enabled === body.enabled,
    );
  }
  // A refresh may legitimately return the same tools; list cannot prove it finished.
  return false;
}

/** This state outlives dialog close/reopen and remains attached to the original body. */
export class McpMutationTracker {
  private source?: string;
  private generation = 0;
  private readonly pending = new Map<
    string | undefined,
    { base: McpPanelState; body: McpMutationBody; expectedFingerprint?: string }
  >();

  bind(source: string | undefined) {
    if (source === this.source) return false;
    this.source = source;
    this.generation++;
    return true;
  }

  capture(): McpMutationScope {
    return { source: this.source, generation: this.generation };
  }

  isCurrent(scope: McpMutationScope) {
    return scope.source === this.source && scope.generation === this.generation;
  }

  isLocked(source?: string) {
    return this.pending.has(source);
  }

  get locked() {
    return this.isLocked(this.source);
  }

  begin(base: McpPanelState, body: McpMutationBody, source?: string, expectedFingerprint?: string) {
    if (source !== this.source || this.pending.has(source)) return false;
    this.pending.set(source, {
      base: structuredClone(base),
      body: structuredClone(body),
      expectedFingerprint,
    });
    return true;
  }

  acknowledge(source?: string) {
    if (source === this.source) this.pending.delete(source);
  }

  diagnostic(next?: McpPanelState, source?: string): "missing_fingerprint" | undefined {
    const pending = this.pending.get(source);
    if (!pending || !next || this.source !== source) return;
    const { base, body, expectedFingerprint } = pending;
    if (
      !expectedFingerprint ||
      base.catalog_revision === next.catalog_revision ||
      (body.action !== "add_stdio" && body.action !== "add_http")
    )
      return;
    const ids = new Set(base.servers.map((server) => server.id));
    const candidates = next.servers.filter(
      (server) =>
        !ids.has(server.id) &&
        server.name === body.name &&
        server.transport === (body.action === "add_stdio" ? "stdio" : "http") &&
        server.enabled,
    );
    if (candidates.length === 1 && candidates[0]?.config_fingerprint === undefined)
      return "missing_fingerprint";
  }

  observe(next: McpPanelState, source?: string) {
    const pending = this.pending.get(source);
    if (
      !pending ||
      this.source !== source ||
      !mcpMutationObserved(pending.base, next, pending.body, pending.expectedFingerprint)
    )
      return false;
    this.acknowledge(source);
    return true;
  }
}

/** A lost response never causes a mutation to be replayed, including an add request. */
export async function settleMcpMutation<T>(
  request: (body: unknown) => Promise<T>,
  body: unknown,
  uncertain: () => void,
  observed: (state: T) => boolean,
  current: () => boolean = () => true,
): Promise<McpMutationResult<T>> {
  if (!current()) return { outcome: "unknown" };
  try {
    const state = await request(body);
    return current() ? { outcome: "applied", state } : { outcome: "unknown" };
  } catch {
    if (!current()) return { outcome: "unknown" };
    uncertain();
    if (!current()) return { outcome: "unknown" };
    try {
      const state = await request({ action: "list" });
      if (!current()) return { outcome: "unknown" };
      return { outcome: observed(state) ? "reconciled" : "unknown", state };
    } catch {
      return { outcome: "unknown" };
    }
  }
}

/** Read-only reconciliation cannot apply a catalog to a replacement view. */
export async function readMcpMutationState<T>(
  read: () => Promise<T>,
  current: () => boolean,
): Promise<{ state: T } | undefined> {
  if (!current()) return;
  const state = await read();
  if (current()) return { state };
}
