import { AccessReceipts } from "../apps/daemon/src/access-receipts.ts";
import type { CommandApproval, PanelSnapshot } from "../packages/protocol/src/index.ts";
import { PanelAccessInputSchema } from "../packages/protocol/src/panel-access.ts";

// Public, in-memory transport fixture. Never launches a host, shell, reader or MCP server.
const syntheticToken = "0".repeat(64);
const workspaceId = "00000000-0000-4000-8000-000000000010";
const encoder = new TextEncoder();
export function createPanelHttpFixture() {
  let online = true;
  let authorized = true;
  let loseNextResponse = false;
  let holdNextDecision = false;
  let heldDecision: { command: CommandApproval; action: string } | undefined;
  let holdNextList = false;
  const heldLists = new Set<() => void>();
  let holdNextCatalog = false;
  const heldCatalogs = new Set<(status: number) => void>();
  let holdNextAccess = false;
  const heldAccess = new Set<() => void>();
  const accessReceipts = new AccessReceipts(() => authorized);
  let nextId = 1;
  const counts = { mutations: 0, lists: 0, streams: 0, accessMutations: 0, accessQueries: 0 };
  const controllers = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>();
  const command = (): CommandApproval => {
    const id = `${String(nextId++).padStart(8, "0")}-0000-4000-8000-000000000001`;
    return {
      id,
      request_id: id,
      workspace_id: workspaceId,
      workspace_name: "HTTP 合成測試專案",
      cwd: "",
      absolute_cwd: "C:\\Synthetic-Kairomes\\project",
      executable: "C:\\Synthetic-Kairomes\\tool.exe",
      argv: ["synthetic-tool", "check"],
      timeout_ms: 120000,
      state: "pending",
      created_at: Date.now(),
      started_at: null,
      ended_at: null,
      expires_at: Date.now() + 300000,
      exit_code: null,
      signal: null,
      message: null,
      fingerprint: "1".repeat(64),
    };
  };
  const snapshot: PanelSnapshot = {
    instanceId: "00000000-0000-4000-8000-000000000050",
    workspaces: [
      { id: workspaceId, name: "HTTP 合成測試專案" },
      { id: "00000000-0000-4000-8000-000000000020", name: "HTTP 第二合成專案" },
    ],
    sessions: [],
    changes: [],
    imports: [],
    commands: [command()],
    accessGrants: [],
  };
  const bytes = () => encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  const send = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    const data = bytes();
    // Intentionally split bytes, including UTF-8 text. HTTP may coalesce these chunks.
    controller.enqueue(data.slice(0, 71));
    controller.enqueue(data.slice(71, 155));
    controller.enqueue(data.slice(155));
  };
  const emit = () => {
    for (const controller of controllers.keys()) send(controller);
  };
  const dropStreams = () => {
    for (const [controller, cleanup] of controllers) {
      cleanup();
      controller.close();
    }
  };
  const probe = () => ({
    ...counts,
    activeStreams: controllers.size,
    heldLists: heldLists.size,
    heldCatalogs: heldCatalogs.size,
    heldAccess: heldAccess.size,
    online,
    authorized,
  });
  const readBody = async (request: Request) => {
    const text = await request.text();
    if (text.length > 4096) throw new Error("Synthetic body too large");
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid body");
    return body as Record<string, unknown>;
  };
  const reply = (data: unknown, status = 200) =>
    Response.json(data, {
      status,
      headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
  return {
    close() {
      accessReceipts.close();
      for (const release of heldAccess) release();
      dropStreams();
      for (const release of heldLists) release();
      for (const release of heldCatalogs) release(503);
    },
    probe,
    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const route = url.pathname;
      if (route === "/synthetic-panel/probe" && request.method === "GET") return reply(probe());
      if (!route.startsWith("/synthetic-panel/") && !route.startsWith("/api/panel/")) return null;
      if (request.method !== "POST" || request.headers.get("origin") !== url.origin)
        return reply({ message: "Synthetic origin rejected" }, 403);
      let body: Record<string, unknown>;
      try {
        body = await readBody(request);
      } catch {
        return reply({ message: "Invalid body" }, 400);
      }
      if (route === "/synthetic-panel/control") {
        if (Object.keys(body).join() !== "action") return reply({}, 400);
        switch (body.action) {
          case "reset":
            accessReceipts.close();
            for (const release of heldAccess) release();
            holdNextAccess = false;
            snapshot.accessGrants = [];
            counts.accessMutations = counts.accessQueries = 0;
            dropStreams();
            for (const release of heldLists) release();
            for (const release of heldCatalogs) release(409);
            online = true;
            authorized = true;
            loseNextResponse = false;
            holdNextDecision = false;
            heldDecision = undefined;
            holdNextList = false;
            holdNextCatalog = false;
            counts.mutations = counts.lists = counts.streams = 0;
            // Keep IDs monotonic so an old participant cannot approve a new request.
            snapshot.commands = [command()];
            break;
          case "pending":
            snapshot.commands?.push(command());
            emit();
            break;
          case "offline":
            online = false;
            dropStreams();
            break;
          case "online":
            online = true;
            break;
          case "invalid":
            authorized = false;
            accessReceipts.close();
            dropStreams();
            break;
          case "lost":
            loseNextResponse = true;
            break;
          case "uncertain":
            holdNextDecision = true;
            break;
          case "settle":
            if (heldDecision) {
              heldDecision.command.state = heldDecision.action === "approve" ? "running" : "denied";
              heldDecision.command.started_at = Date.now();
              heldDecision = undefined;
              emit();
            }
            break;
          case "hold-list":
            holdNextList = true;
            break;
          case "release-list":
            for (const release of heldLists) release();
            heldLists.clear();
            break;
          case "hold-catalog":
            holdNextCatalog = true;
            break;
          case "release-catalog-failure":
            for (const release of heldCatalogs) release(503);
            break;
          case "uncertain-access":
            holdNextAccess = true;
            break;
          case "settle-access":
            for (const release of heldAccess) release();
            break;
          default:
            return reply({}, 400);
        }
        return reply(probe());
      }
      if (!["stream", "approvals", "mcp", "access"].some((name) => route === `/api/panel/${name}`))
        return reply({}, 404);
      if (request.headers.get("authorization") !== `Bearer ${syntheticToken}` || !authorized)
        return reply({}, 401);
      if (!online) return reply({}, 503);
      if (route.endsWith("/access")) {
        try {
          const input = PanelAccessInputSchema.parse(body);
          if (input.action === "status") {
            counts.accessQueries++;
            return reply({
              ...snapshot,
              access_receipt: accessReceipts.status(syntheticToken, input.request_id),
            });
          }
          const workspace = snapshot.workspaces?.find((item) => item.id === input.workspace_id);
          if (!workspace) throw new Error("Unknown synthetic workspace");
          const uncertain = input.action === "enable" && holdNextAccess;
          if (uncertain) holdNextAccess = false;
          const execute = async (valid: () => boolean) => {
            if (!valid()) throw new Error("Synthetic pairing revoked");
            counts.accessMutations++;
            const otherGrants = (snapshot.accessGrants ?? []).filter(
              (item) => item.workspace_id !== input.workspace_id,
            );
            snapshot.accessGrants =
              input.action === "enable"
                ? [
                    ...otherGrants,
                    {
                      id: crypto.randomUUID(),
                      workspace_id: workspace.id,
                      workspace_name: workspace.name,
                      level: input.level,
                      expires_at:
                        input.minutes === null ? null : Date.now() + input.minutes * 60_000,
                    },
                  ]
                : otherGrants;
            emit();
            if (uncertain)
              await new Promise<void>((resolve) => {
                const release = () => {
                  clearTimeout(timer);
                  heldAccess.delete(release);
                  resolve();
                };
                const timer = setTimeout(release, 30_000);
                timer.unref();
                heldAccess.add(release);
              });
          };
          if (!input.request_id || !input.valid_until) {
            await execute(() => authorized);
            return reply(snapshot);
          }
          const operation = accessReceipts.run(
            syntheticToken,
            { ...input, request_id: input.request_id, valid_until: input.valid_until },
            execute,
          );
          if (uncertain) {
            void operation.catch(() => undefined);
            return reply({}, 502);
          }
          return reply({ ...snapshot, access_receipt: await operation });
        } catch {
          return reply({ message: "Invalid synthetic access request" }, 400);
        }
      }
      if (route.endsWith("/stream")) {
        if (Object.keys(body).length) return reply({}, 400);
        if (request.signal.aborted) return reply({}, 408);
        counts.streams++;
        let active: ReadableStreamDefaultController<Uint8Array> | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const cleanup = () => {
          clearInterval(heartbeat);
          if (active) controllers.delete(active);
          request.signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          const controller = active;
          cleanup();
          controller?.close();
        };
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              active = controller;
              controllers.set(controller, cleanup);
              send(controller);
              heartbeat = setInterval(
                () => controller.enqueue(encoder.encode(": heartbeat\n\n")),
                5000,
              );
              request.signal.addEventListener("abort", abort, { once: true });
            },
            cancel: cleanup,
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } },
        );
      }
      if (body.action === "list" && Object.keys(body).length === 1) {
        counts.lists++;
        if (holdNextCatalog && route.endsWith("/mcp")) {
          holdNextCatalog = false;
          if (heldCatalogs.size >= 4) return reply({}, 429);
          const status = await new Promise<number>((resolve) => {
            const abort = () => release(499);
            const release = (value: number) => {
              heldCatalogs.delete(release);
              request.signal.removeEventListener("abort", abort);
              resolve(value);
            };
            heldCatalogs.add(release);
            request.signal.addEventListener("abort", abort, { once: true });
            if (request.signal.aborted) abort();
          });
          return reply({ message: "合成 catalog 延遲失敗" }, status);
        }
        const response = reply(
          route.endsWith("/mcp") ? { catalog_revision: "synthetic-http", servers: [] } : snapshot,
        );
        if (holdNextList && route.endsWith("/approvals")) {
          holdNextList = false;
          if (heldLists.size >= 4) return reply({}, 429);
          await new Promise<void>((resolve) => {
            const release = () => {
              heldLists.delete(release);
              request.signal.removeEventListener("abort", release);
              resolve();
            };
            heldLists.add(release);
            request.signal.addEventListener("abort", release, { once: true });
            if (request.signal.aborted) release();
          });
        }
        return response;
      }
      if (
        !route.endsWith("/approvals") ||
        !["approve", "deny", "stop"].includes(String(body.action)) ||
        Object.keys(body).some((key) => !["action", "command_id", "fingerprint"].includes(key))
      )
        return reply({}, 400);
      const selected = snapshot.commands?.find((item) => item.id === body.command_id);
      if (
        !selected ||
        selected.fingerprint !== body.fingerprint ||
        (body.action === "stop" ? selected.state !== "running" : selected.state !== "pending")
      )
        return reply({}, 409);
      // A previously accepted synthetic decision remains unknown to the client.
      if (heldDecision?.command.id === selected.id) return reply({}, 409);
      counts.mutations++;
      if (holdNextDecision && body.action !== "stop") {
        holdNextDecision = false;
        heldDecision = { command: selected, action: String(body.action) };
        return reply({}, 502);
      }
      selected.state =
        body.action === "approve" ? "running" : body.action === "deny" ? "denied" : "cancelled";
      selected.started_at = Date.now();
      if (loseNextResponse) {
        loseNextResponse = false;
        // A transport failure response after commit, before an SSE observation.
        return reply({}, 502);
      }
      emit();
      return reply(snapshot);
    },
  };
}
