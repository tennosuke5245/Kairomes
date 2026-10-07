import { createHash, timingSafeEqual } from "node:crypto";
import {
  type AccessGrant,
  ApprovalInputSchema,
  type CompanionGrantSummary,
  IMAGE_IMPORT_UPLOAD_ID_HEADER,
  IMAGE_IMPORT_UPLOAD_TYPES,
  KairomesError,
  LIMITS,
  McpAuthInputSchema,
  McpPanelInputSchema,
  PanelAccessInputSchema,
  type PanelSnapshot,
  publicError,
  type ToolName,
  VERSION,
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
/**
 * The trusted panel's full state. File changes carry review diffs only while pending or
 * applying (see FileChangeManager.approvals), which keeps every frame of /api/panel/stream
 * well below the 2 MiB limit of readSnapshots.
 */
function panelSnapshot(
  service: ToolService,
  workbench: { instanceId: string; registry: WorkspaceRegistry },
): PanelSnapshot {
  return {
    instanceId: workbench.instanceId,
    sessions: service.terminals.approvals(),
    workspaces: workbench.registry.list(),
    accessGrants: service.terminals.access(),
    commands: service.commands.approvals(),
    changes: service.changes.approvals(),
    imports: service.imports.approvals(),
    importHydration: service.imports.hydration(),
  };
}

const importRoutePattern =
  /^\/api\/panel\/imports\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(file|content)$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** HTTP status of import route failures the panel must tell apart; anything else is 400. */
const importStatus: Record<string, number> = {
  PANEL_UNAUTHORIZED: 401,
  ARTIFACT_IMPORT_NOT_FOUND: 404,
  IMPORT_NOT_AWAITING_FILE: 409,
  REQUEST_ID_REUSED: 409,
  ARTIFACT_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  ARTIFACT_IMPORT_LIMIT: 429,
};

/** `inline` with an ASCII fallback name and the UTF-8 name; never a path or URL. */
function inlineDisposition(relative: string) {
  const name = relative.split("/").at(-1) ?? "image";
  const ascii = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "image";
  const encoded = encodeURIComponent(name).replace(
    /['()*!]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Trusted local summary of live autonomy grants: level and expiry only, never id or owner. */
export function grantSummary(grants: readonly AccessGrant[]): CompanionGrantSummary[] {
  return grants.map(({ workspace_id, level, expires_at }) => ({
    workspace_id,
    level,
    expires_at: expires_at === null ? null : new Date(expires_at).toISOString(),
  }));
}

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
      /**
       * In-process, read-only view for the owning Companion. It adds no HTTP route, and an
       * external workbench cannot be read this way.
       */
      accessSummary: () => grantSummary(service.terminals.access()),
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
    // Only the trusted image upload route may stream up to 25 MiB; every other route keeps the
    // requestBodyBytes cap below, which the stdio relay also applies before /api/mcp.
    maxRequestBodySize: LIMITS.artifactBytes,
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      const host = `127.0.0.1:${bunServer.port}`;
      if (request.headers.get("host") !== host || url.hostname !== "127.0.0.1") {
        return new Response("Invalid host", { status: 403, headers });
      }
      const importRoute = importRoutePattern.exec(url.pathname);
      if (importRoute?.[2] !== "file") {
        // A chunked body has no length to check up front, so only the upload route accepts one.
        if (request.headers.has("transfer-encoding"))
          return new Response("Length required", { status: 411, headers });
        const declared = request.headers.get("content-length");
        if (declared !== null && !(Number(declared) <= LIMITS.requestBodyBytes))
          return new Response("Request too large", { status: 413, headers });
      }
      const importCreate = url.pathname === "/api/panel/imports";
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json(
          { status: "ok", instanceId: workbench?.instanceId, version: VERSION },
          { headers },
        );
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
      if (panel || importCreate || importRoute) {
        if (!workbench || !extensionOrigin || request.headers.get("origin") !== extensionOrigin)
          return new Response("Invalid extension origin", { status: 403, headers });
        const panelHeaders = {
          ...headers,
          "Access-Control-Allow-Origin": extensionOrigin,
          Vary: "Origin",
        };
        // Pending image bytes are read with GET; the upload adds its idempotency header.
        const method = importRoute?.[2] === "content" ? "GET" : "POST";
        const allowedHeaders =
          importRoute?.[2] === "file"
            ? ["authorization", "content-type", "x-kairomes-upload-id"]
            : ["authorization", "content-type"];
        if (request.method === "OPTIONS") {
          const requested =
            request.headers
              .get("access-control-request-headers")
              ?.toLowerCase()
              .split(",")
              .map((value) => value.trim()) ?? [];
          if (
            request.headers.get("access-control-request-method") !== method ||
            requested.some((value) => !allowedHeaders.includes(value))
          )
            return new Response("Invalid preflight", { status: 403, headers: panelHeaders });
          return new Response(null, {
            status: 204,
            headers: {
              ...panelHeaders,
              "Access-Control-Allow-Methods": method,
              "Access-Control-Allow-Headers":
                importRoute?.[2] === "file"
                  ? "Authorization, Content-Type, X-Kairomes-Upload-Id"
                  : "Authorization, Content-Type",
            },
          });
        }
        if (request.method !== method)
          return new Response("Method not allowed", { status: 405, headers: panelHeaders });
        const contentType =
          request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        if (importRoute?.[2] === "file") {
          if (!(IMAGE_IMPORT_UPLOAD_TYPES as readonly string[]).includes(contentType))
            return new Response("Expected PNG, JPEG or WebP", {
              status: 415,
              headers: panelHeaders,
            });
        } else if (
          importRoute?.[2] !== "content" &&
          !request.headers.get("content-type")?.startsWith("application/json")
        )
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
          if (importCreate) {
            const body = await request.json();
            if (!pairing.valid(panelToken))
              return Response.json(
                { message: "配對已失效。" },
                { status: 401, headers: panelHeaders },
              );
            const created = await service.imports.createLocal(body);
            return Response.json(
              { ...panelSnapshot(service, workbench), import: created },
              { headers: panelHeaders },
            );
          }
          if (importRoute?.[2] === "file") {
            const uploadId = request.headers.get(IMAGE_IMPORT_UPLOAD_ID_HEADER) ?? "";
            if (!uuidPattern.test(uploadId))
              throw new KairomesError("VALIDATION", "上傳需要 X-Kairomes-Upload-Id（UUID）。");
            const declared = request.headers.get("content-length");
            const uploaded = await service.imports.upload(importRoute[1] as string, {
              uploadId: uploadId.toLowerCase(),
              contentType,
              body: request.body,
              declaredBytes: declared === null ? undefined : Number(declared),
              authorized: () => pairing.valid(panelToken),
            });
            return Response.json(
              { ...panelSnapshot(service, workbench), import: uploaded },
              { headers: panelHeaders },
            );
          }
          if (importRoute?.[2] === "content") {
            // Reading the bytes is what lets this pairing approve them (see imports.decide).
            const content = service.imports.content(importRoute[1] as string, panelToken);
            const body = new Uint8Array(content.data.length);
            body.set(content.data);
            content.data.fill(0);
            return new Response(body.buffer, {
              headers: {
                ...panelHeaders,
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Type": content.mimeType,
                "Content-Length": String(body.byteLength),
                "Content-Disposition": inlineDisposition(content.path),
              },
            });
          }
          if (url.pathname === "/api/panel/stream") {
            z.object({})
              .strict()
              .parse(await request.json());
            bunServer.timeout(request, 0);
            return snapshotStream(
              request,
              // Terminal and command output never changes this snapshot; skip those wakeups.
              (listener) => service.activity.subscribe(listener, { processIo: false }),
              () => panelSnapshot(service, workbench),
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
                ...panelSnapshot(service, workbench),
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
          const input = ApprovalInputSchema.parse(await request.json());
          if (input.action !== "list") await service.decideApproval(input, panelToken);
          return Response.json(panelSnapshot(service, workbench), { headers: panelHeaders });
        } catch (error) {
          const exposed = publicError(error);
          const status =
            (importCreate || importRoute ? importStatus[exposed.code] : undefined) ??
            (exposed.code === "ACCESS_RECEIPT_LIMIT"
              ? 429
              : ["ACCESS_REQUEST_CHANGED", "ACCESS_REQUEST_EXPIRED"].includes(exposed.code)
                ? 409
                : 400);
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
            {
              mode: "workbench",
              instanceId: workbench?.instanceId,
              lastMcpRequestAt,
              pairedPanels: pairing.activeCount(),
            },
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
          const input = ApprovalInputSchema.parse(await request.json());
          // The admin token also drives the legacy /approvals page, which has no image review.
          // Image imports are approved only in the paired Extension; denying or cancelling
          // one here only reduces what can happen.
          if (input.action === "approve" && input.import_id)
            throw new KairomesError(
              "IMPORT_APPROVAL_PANEL_ONLY",
              "圖片匯入只能在已配對的瀏覽器側欄核准。",
            );
          if (input.action !== "list") await service.decideApproval(input);
          return Response.json(
            {
              sessions: service.terminals.approvals(),
              commands: service.commands.approvals(),
              changes: service.changes.approvals(),
              imports: service.imports.approvals(),
              importHydration: service.imports.hydration(),
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
