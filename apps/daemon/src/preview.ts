import { createHash, timingSafeEqual } from "node:crypto";
import {
  KairomesError,
  LIMITS,
  McpAuthInputSchema,
  McpPanelInputSchema,
  PanelAccessInputSchema,
  publicError,
  type ToolName,
  z,
} from "@kairomes/protocol";
import type { WorkspaceRegistry } from "@kairomes/workspace-core";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AccessReceipts } from "./access-receipts.ts";
import { approvalPage } from "./approval-page.ts";
import type { ArtifactDownload } from "./artifact-imports.ts";
import type { McpHostManager } from "./mcp-host.ts";
import { PanelPairing } from "./pairing.ts";
import { createMcpServer } from "./server.ts";
import { snapshotStream } from "./snapshot-stream.ts";
import { ToolService, toolDefinitions } from "./tools.ts";
import { publishWorkbenchConnection } from "./workbench-connection.ts";

const RequestSchema = z.object({ name: z.string(), arguments: z.unknown().default({}) }).strict();
const ApprovalSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.enum(["approve", "deny"]),
      session_id: z.string().uuid().optional(),
      command_id: z.string().uuid().optional(),
      change_id: z.string().uuid().optional(),
      import_id: z.string().uuid().optional(),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .refine(
      (input) =>
        [input.session_id, input.command_id, input.change_id, input.import_id].filter(Boolean)
          .length === 1,
      "請指定一個核准目標",
    ),
  z
    .object({
      action: z.literal("stop"),
      session_id: z.string().uuid().optional(),
      command_id: z.string().uuid().optional(),
      change_id: z.string().uuid().optional(),
      import_id: z.string().uuid().optional(),
      fingerprint: z.string().optional(),
    })
    .strict()
    .refine(
      (input) =>
        [input.session_id, input.command_id, input.change_id, input.import_id].filter(Boolean)
          .length === 1,
      "請指定一個停止目標",
    ),
]);

export function startPreview(registry: WorkspaceRegistry, widgetHtml: string, port = 4318) {
  try {
    return startLocalServer(new ToolService(registry, true), widgetHtml, port);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["EADDRINUSE", "EACCES"].includes(String(error.code))
    )
      throw new KairomesError(
        "PORT_UNAVAILABLE",
        `無法使用本機連接埠 ${port}，請執行 bun run preview --port 0 自動選擇可用連接埠。`,
      );
    throw error;
  }
}

export function startCompanion(service: ToolService) {
  return startLocalServer(service, undefined, 0);
}

export async function startWorkbench(
  registry: WorkspaceRegistry,
  widgetHtml: string,
  port = 4318,
  extensionId?: string,
  options: {
    artifactDownload?: ArtifactDownload;
    mcpResultHtml?: string;
    mcpHost?: McpHostManager;
    openBrowser?: (url: string) => Promise<void>;
  } = {},
) {
  if (extensionId && !/^[a-p]{32}$/.test(extensionId))
    throw new KairomesError("USAGE", "Extension ID 必須是瀏覽器顯示的 32 位 a～p 字母。");
  const service = new ToolService(registry, true, options);
  const instanceId = crypto.randomUUID();
  const mcpToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const app = startLocalServer(
    service,
    widgetHtml,
    port,
    {
      registry,
      instanceId,
      mcpToken,
      extensionId,
      openBrowser: options.openBrowser,
    },
    options.mcpResultHtml,
  );
  try {
    const unpublish = await publishWorkbenchConnection(registry.dataDirectory, {
      instanceId,
      pid: process.pid,
      origin: new URL(app.url).origin,
      mcpToken,
      uiToken: new URLSearchParams(new URL(app.url).hash.slice(1)).get("session") ?? "",
      adminToken: new URLSearchParams(new URL(app.approvalsUrl).hash.slice(1)).get("session") ?? "",
    });
    return {
      ...app,
      async close() {
        await unpublish();
        await app.close();
      },
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}

function startLocalServer(
  service: ToolService,
  widgetHtml: string | undefined,
  port: number,
  workbench?: {
    registry: WorkspaceRegistry;
    instanceId: string;
    mcpToken: string;
    extensionId?: string;
    openBrowser?: (url: string) => Promise<void>;
  },
  mcpResultHtml?: string,
) {
  let lastMcpRequestAt: string | null = null;
  let inFlightMcp = 0;
  const streams = new Set<() => void>();
  const pairing = new PanelPairing(workbench?.extensionId);
  const accessReceipts = new AccessReceipts((owner) => pairing.valid(owner));
  if (workbench)
    service.mcp.configureAuth(workbench.instanceId, workbench.openBrowser, (owner) =>
      pairing.valid(owner),
    );
  const extensionOrigin = workbench?.extensionId
    ? `chrome-extension://${workbench.extensionId}`
    : undefined;
  const token = crypto.getRandomValues(new Uint8Array(32));
  const tokenHex = Buffer.from(token).toString("hex");
  const adminToken = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const html = widgetHtml?.replace(
    "<!--KAIROMES_MODE-->",
    `<meta name="kairomes-mode" content="${workbench ? "workbench" : "preview"}"><meta name="kairomes-parent-origin" content="${extensionOrigin ?? ""}">`,
  );
  const hashes = Array.from(
    `${html ?? ""}${approvalPage}`.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g),
    (match) =>
      `'sha256-${createHash("sha256")
        .update(match[1] ?? "")
        .digest("base64")}'`,
  ).join(" ");
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; connect-src 'self'; img-src data: blob:; font-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    // The stdio relay enforces the same cap before forwarding to /api/mcp.
    maxRequestBodySize: LIMITS.requestBodyBytes,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      const host = `127.0.0.1:${bunServer.port}`;
      if (request.headers.get("host") !== host || url.hostname !== "127.0.0.1") {
        return new Response("Invalid host", { status: 403, headers });
      }
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ status: "ok", instanceId: workbench?.instanceId }, { headers });
      }
      const panel = [
        "/api/panel/pair",
        "/api/panel/pair/renew",
        "/api/panel/stream",
        "/api/panel/approvals",
        "/api/panel/disconnect",
        "/api/panel/access",
        "/api/panel/mcp",
        "/api/panel/mcp-auth",
      ].includes(url.pathname);
      if (panel) {
        if (!workbench || !extensionOrigin || request.headers.get("origin") !== extensionOrigin)
          return new Response("Invalid extension origin", { status: 403, headers });
        const panelHeaders = {
          ...headers,
          "Access-Control-Allow-Origin": extensionOrigin,
          Vary: "Origin",
        };
        if (request.method === "OPTIONS") {
          const requested =
            request.headers
              .get("access-control-request-headers")
              ?.toLowerCase()
              .split(",")
              .map((value) => value.trim()) ?? [];
          if (
            request.headers.get("access-control-request-method") !== "POST" ||
            requested.some((value) => !["authorization", "content-type"].includes(value))
          )
            return new Response("Invalid preflight", { status: 403, headers: panelHeaders });
          return new Response(null, {
            status: 204,
            headers: {
              ...panelHeaders,
              "Access-Control-Allow-Methods": "POST",
              "Access-Control-Allow-Headers": "Authorization, Content-Type",
            },
          });
        }
        if (request.method !== "POST")
          return new Response("Method not allowed", { status: 405, headers: panelHeaders });
        if (!request.headers.get("content-type")?.startsWith("application/json"))
          return new Response("Expected JSON", { status: 415, headers: panelHeaders });
        try {
          if (url.pathname === "/api/panel/pair") {
            const input = z
              .object({ code: z.string().regex(/^[a-f0-9]{64}$/), instanceId: z.string().uuid() })
              .strict()
              .parse(await request.json());
            if (input.instanceId !== workbench.instanceId)
              throw new KairomesError("INSTANCE_CHANGED", "工作台已重新啟動，請重新產生配對碼。");
            const panelToken = pairing.redeem(input.code);
            return Response.json(
              {
                instanceId: workbench.instanceId,
                origin: `http://${host}`,
                panelToken,
                workbenchUrl: `http://${host}/#session=${tokenHex}`,
              },
              { headers: panelHeaders },
            );
          }
          if (url.pathname === "/api/panel/pair/renew") {
            const input = z
              .object({ code: z.string().regex(/^[a-f0-9]{64}$/), instanceId: z.string().uuid() })
              .strict()
              .parse(await request.json());
            if (input.instanceId !== workbench.instanceId)
              throw new KairomesError("INSTANCE_CHANGED", "工作台已重新啟動，請重新產生配對碼。");
            const code = pairing.renew(input.code);
            return Response.json(
              {
                pairingUrl: `http://${host}/pair#code=${code}&instance=${workbench.instanceId}`,
                expiresInSeconds: 120,
              },
              { headers: panelHeaders },
            );
          }
          const panelToken = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
          if (!pairing.valid(panelToken))
            return Response.json(
              { message: "側欄配對已失效，請重新配對。" },
              { status: 401, headers: panelHeaders },
            );
          if (url.pathname === "/api/panel/stream") {
            z.object({})
              .strict()
              .parse(await request.json());
            bunServer.timeout(request, 0);
            return snapshotStream(
              request,
              (listener) => service.activity.subscribe(listener),
              () => ({
                instanceId: workbench.instanceId,
                sessions: service.terminals.approvals(),
                workspaces: workbench.registry.list(),
                accessGrants: service.terminals.access(),
                commands: service.commands.approvals(),
                changes: service.changes.approvals(),
                imports: service.imports.approvals(),
              }),
              panelHeaders,
              streams,
              () => pairing.valid(panelToken),
            );
          }
          if (url.pathname === "/api/panel/disconnect") {
            z.object({})
              .strict()
              .parse(await request.json());
            pairing.revoke(panelToken);
            service.mcp.revokeAuthOwner(panelToken);
            accessReceipts.revoke(panelToken);
            await service.revokeAccessOwner(panelToken);
            return Response.json({ disconnected: true }, { headers: panelHeaders });
          }
          if (url.pathname === "/api/panel/access") {
            const input = PanelAccessInputSchema.parse(await request.json());
            // A slow body must not keep authority after its pairing was revoked.
            if (!pairing.valid(panelToken))
              return Response.json(
                { message: "配對已失效。" },
                { status: 401, headers: panelHeaders },
              );
            const execute = async (valid: () => boolean) => {
              if (input.action === "enable")
                await service.enableAccess(
                  input.workspace_id,
                  input.level,
                  input.minutes,
                  panelToken,
                  valid,
                );
              else if (input.action === "disable") await service.disableAccess(input.workspace_id);
            };
            const receipt =
              input.action === "status"
                ? accessReceipts.status(panelToken, input.request_id)
                : input.request_id && input.valid_until
                  ? await accessReceipts.run(
                      panelToken,
                      { ...input, request_id: input.request_id, valid_until: input.valid_until },
                      execute,
                    )
                  : undefined;
            if (input.action !== "status" && !input.request_id)
              await execute(() => pairing.valid(panelToken));
            if (!pairing.valid(panelToken))
              return Response.json(
                { message: "配對已失效。" },
                { status: 401, headers: panelHeaders },
              );
            return Response.json(
              {
                instanceId: workbench.instanceId,
                sessions: service.terminals.approvals(),
                workspaces: workbench.registry.list(),
                accessGrants: service.terminals.access(),
                commands: service.commands.approvals(),
                changes: service.changes.approvals(),
                imports: service.imports.approvals(),
                ...(receipt ? { access_receipt: receipt } : {}),
              },
              { headers: panelHeaders },
            );
          }
          if (url.pathname === "/api/panel/mcp-auth") {
            const input = McpAuthInputSchema.parse(await request.json());
            if (!pairing.valid(panelToken))
              return Response.json(
                { message: "配對已失效。" },
                { status: 401, headers: panelHeaders },
              );
            if (input.instance_id !== workbench.instanceId)
              throw new KairomesError("INSTANCE_CHANGED", "工作台已重新啟動，請重新配對。");
            const receipt = service.mcp.auth(panelToken, input);
            return Response.json(receipt, { headers: panelHeaders });
          }
          if (url.pathname === "/api/panel/mcp") {
            const input = McpPanelInputSchema.parse(await request.json());
            if (!pairing.valid(panelToken))
              return Response.json(
                { message: "配對已失效。" },
                { status: 401, headers: panelHeaders },
              );
            if (input.action === "add_stdio") {
              const config = await service.mcp.addStdio({
                name: input.name,
                command: input.command,
                args: input.args,
                cwd: input.cwd,
                env: input.env,
              });
              await service.mcp.refresh(config.id);
            } else if (input.action === "add_http") {
              const config = await service.mcp.addHttp({
                name: input.name,
                url: input.url,
                headerEnv: input.header_env,
              });
              await service.mcp.refresh(config.id);
            } else if (input.action === "refresh") {
              await service.mcp.refresh(input.server_id);
            } else if (input.action === "set_server_enabled") {
              await service.mcp.setServerEnabled(input.server_id, input.enabled);
            } else if (input.action === "set_tool_enabled") {
              await service.mcp.setToolEnabled(input.server_id, input.tool_name, input.enabled);
            } else if (input.action === "allow_read") {
              await service.mcp.allowRead(input.server_id, input.tool_name);
            } else if (input.action === "deny") {
              await service.mcp.deny(input.server_id, input.tool_name);
            } else if (input.action === "remove") {
              await service.mcp.remove(input.server_id);
            }
            service.activity.changed();
            return Response.json(await service.mcp.panelState(), { headers: panelHeaders });
          }
          const input = ApprovalSchema.parse(await request.json());
          if (input.action !== "list" && input.import_id) {
            if (input.action === "stop") service.imports.cancel(input.import_id);
            else
              await service.imports.decide(
                input.import_id,
                input.fingerprint,
                input.action === "approve",
              );
          } else if (input.action !== "list" && input.change_id) {
            if (input.action === "stop") service.changes.cancel(input.change_id);
            else
              await service.changes.decide(
                input.change_id,
                input.fingerprint,
                input.action === "approve",
              );
          } else if (input.action !== "list" && input.command_id) {
            if (input.action === "stop") await service.commands.cancel(input.command_id);
            else
              await service.commands.decide(
                input.command_id,
                input.fingerprint,
                input.action === "approve",
              );
          } else if (input.action === "stop")
            await service.terminals.stop(input.session_id as string);
          else if (input.action !== "list")
            await service.terminals.decide(
              input.session_id as string,
              input.fingerprint,
              input.action === "approve",
            );
          return Response.json(
            {
              instanceId: workbench.instanceId,
              sessions: service.terminals.approvals(),
              workspaces: workbench.registry.list(),
              accessGrants: service.terminals.access(),
              commands: service.commands.approvals(),
              changes: service.changes.approvals(),
              imports: service.imports.approvals(),
            },
            { headers: panelHeaders },
          );
        } catch (error) {
          const exposed = publicError(error);
          const status =
            exposed.code === "ACCESS_RECEIPT_LIMIT"
              ? 429
              : ["ACCESS_REQUEST_CHANGED", "ACCESS_REQUEST_EXPIRED"].includes(exposed.code)
                ? 409
                : 400;
          return Response.json(exposed, { status, headers: panelHeaders });
        }
      }
      if (
        request.method === "GET" &&
        (url.pathname === "/approvals" || (url.pathname === "/" && html))
      ) {
        return new Response(url.pathname === "/approvals" ? approvalPage : html, {
          headers: {
            ...headers,
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy":
              url.pathname === "/" && workbench?.extensionId
                ? headers["Content-Security-Policy"].replace(
                    "frame-ancestors 'none'",
                    `frame-ancestors chrome-extension://${workbench.extensionId}`,
                  )
                : headers["Content-Security-Policy"],
          },
        });
      }
      const admin = url.pathname === "/api/approvals";
      const mcp = url.pathname === "/api/mcp" && !!workbench;
      const connection = url.pathname === "/api/connection" && !!workbench;
      const pairCreate = url.pathname === "/api/pairing/create" && !!workbench;
      const artifactContent = url.pathname === "/api/artifacts/content" && !!html;
      const mcpMedia = url.pathname === "/api/mcp/media" && !!workbench;
      const activity =
        ["/api/activity/stream", "/api/activity/result"].includes(url.pathname) && !!workbench;
      if (
        request.method !== "POST" ||
        (!admin &&
          !mcp &&
          !connection &&
          !pairCreate &&
          !artifactContent &&
          !mcpMedia &&
          !activity &&
          !(url.pathname === "/api/tools" && html))
      ) {
        return new Response("Not found", { status: 404, headers });
      }
      const origin = request.headers.get("origin");
      if (origin !== `http://${host}` && !(mcp && origin === null))
        return new Response("Invalid origin", { status: 403, headers });
      const candidate = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const expected = Buffer.from(
        admin || pairCreate ? adminToken : mcp && workbench ? workbench.mcpToken : tokenHex,
      );
      const provided = Buffer.from(candidate);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        return Response.json(
          { message: "存取權杖無效，請重新開啟完整網址。" },
          { status: 401, headers },
        );
      }
      if (!request.headers.get("content-type")?.startsWith("application/json")) {
        return new Response("Expected JSON", { status: 415, headers });
      }
      try {
        if (artifactContent) {
          const result = await service.artifactContent(await request.json());
          const body = new Uint8Array(result.data.length);
          body.set(result.data);
          return new Response(body.buffer, {
            headers: {
              ...headers,
              "Content-Type": result.artifact.mime_type,
              "Content-Length": String(result.data.length),
            },
          });
        }
        if (mcpMedia) {
          const result = service.mcpMediaContent(await request.json());
          const body = new Uint8Array(result.data.length);
          body.set(result.data);
          return new Response(body.buffer, {
            headers: {
              ...headers,
              "Cache-Control": "private, no-store",
              "Content-Type": result.mimeType,
              "Content-Length": String(result.data.length),
            },
          });
        }
        if (pairCreate && workbench) {
          const input = z
            .object({ extensionId: z.string().regex(/^[a-p]{32}$/) })
            .strict()
            .parse(await request.json());
          const code = pairing.create(input.extensionId);
          return Response.json(
            {
              pairingUrl: `http://${host}/pair#code=${code}&instance=${workbench.instanceId}`,
              expiresInSeconds: 120,
            },
            { headers },
          );
        }
        if (activity && workbench) {
          if (url.pathname === "/api/activity/result") {
            const input = z
              .object({ id: z.string().uuid() })
              .strict()
              .parse(await request.json());
            return Response.json(service.activityResult(input.id), { headers });
          }
          z.object({})
            .strict()
            .parse(await request.json());
          bunServer.timeout(request, 0);
          return snapshotStream(
            request,
            (listener) => service.activity.subscribe(listener),
            () => ({
              instanceId: workbench.instanceId,
              seq: service.activity.seq,
              entries: service.activity.list(),
              workspaces: workbench.registry.list(),
              sessions: service.terminals.list(),
              commands: service.commands.list(),
              changes: service.changes.list(),
              imports: service.imports.list(),
            }),
            headers,
            streams,
          );
        }
        if (connection)
          return Response.json(
            { mode: "workbench", instanceId: workbench?.instanceId, lastMcpRequestAt },
            { headers },
          );
        if (mcp && workbench) {
          if (inFlightMcp >= 8) return new Response("Busy", { status: 429, headers });
          inFlightMcp++;
          const server = createMcpServer(
            workbench.registry,
            widgetHtml,
            service,
            false,
            mcpResultHtml,
          );
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          try {
            await server.connect(transport);
            const response = await transport.handleRequest(request);
            if (response.ok) lastMcpRequestAt = new Date().toISOString();
            for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
            return response;
          } finally {
            await server.close();
            inFlightMcp--;
          }
        }
        if (admin) {
          const input = ApprovalSchema.parse(await request.json());
          if (input.action !== "list" && input.import_id) {
            if (input.action === "stop") service.imports.cancel(input.import_id);
            else
              await service.imports.decide(
                input.import_id,
                input.fingerprint,
                input.action === "approve",
              );
          } else if (input.action !== "list" && input.change_id) {
            if (input.action === "stop") service.changes.cancel(input.change_id);
            else
              await service.changes.decide(
                input.change_id,
                input.fingerprint,
                input.action === "approve",
              );
          } else if (input.action !== "list" && input.command_id) {
            if (input.action === "stop") await service.commands.cancel(input.command_id);
            else
              await service.commands.decide(
                input.command_id,
                input.fingerprint,
                input.action === "approve",
              );
          } else if (input.action === "stop")
            await service.terminals.stop(input.session_id as string);
          else if (input.action !== "list")
            await service.terminals.decide(
              input.session_id as string,
              input.fingerprint,
              input.action === "approve",
            );
          return Response.json(
            {
              sessions: service.terminals.approvals(),
              commands: service.commands.approvals(),
              changes: service.changes.approvals(),
              imports: service.imports.approvals(),
            },
            { headers },
          );
        }
        const body = RequestSchema.parse(await request.json());
        if (!toolDefinitions.some((tool) => tool.name === body.name)) {
          return Response.json(
            { code: "UNKNOWN_TOOL", message: "工具不存在。" },
            { status: 404, headers },
          );
        }
        return Response.json(await service.call(body.name as ToolName, body.arguments), {
          headers,
        });
      } catch (error) {
        return Response.json(publicError(error), { status: 400, headers });
      }
    },
    error() {
      return new Response("Request failed", { status: 500, headers });
    },
  });
  // Companion may update the same SQLite registry from another process. A small,
  // read-only check keeps existing widget and extension streams in sync without
  // routing workspace administration through either browser surface.
  let workspaceVersion = workbench ? JSON.stringify(workbench.registry.list()) : "";
  const workspaceRefresh = workbench
    ? setInterval(() => {
        if (streams.size === 0) return;
        try {
          const next = JSON.stringify(workbench.registry.list());
          if (next === workspaceVersion) return;
          workspaceVersion = next;
          service.activity.changed();
        } catch {
          // A transient registry read failure is retried on the next tick.
        }
      }, 1000)
    : undefined;
  workspaceRefresh?.unref();
  return {
    server,
    url: `http://127.0.0.1:${server.port}/#session=${tokenHex}`,
    approvalsUrl: `http://127.0.0.1:${server.port}/approvals#session=${adminToken}`,
    async close() {
      clearInterval(workspaceRefresh);
      for (const close of streams) close();
      pairing.close();
      accessReceipts.close();
      server.stop(true);
      await service.close();
    },
  };
}
