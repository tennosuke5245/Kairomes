import { z } from "zod";
import { McpAuthSummarySchema } from "./mcp-auth.ts";

const McpServerStateSchema = z.enum(["disconnected", "connecting", "ready", "unavailable"]);

const McpServerSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  transport: z.enum(["stdio", "http"]),
  enabled: z.boolean(),
  state: McpServerStateSchema,
  tool_count: z.number().int().nonnegative(),
  enabled_tool_count: z.number().int().nonnegative(),
  message: z.string().optional(),
});
export type McpServerSummary = z.infer<typeof McpServerSummarySchema>;

const McpCatalogToolSchema = z.object({
  ref: z.string(),
  server_id: z.string().uuid(),
  server_name: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean(),
  availability: z.enum(["ready", "disabled", "schema_changed", "unavailable"]),
  read_only_hint: z.boolean().nullable(),
  destructive_hint: z.boolean().nullable(),
  open_world_hint: z.boolean().nullable(),
  schema_fingerprint: z.string(),
});
export type McpCatalogTool = z.infer<typeof McpCatalogToolSchema>;

export const McpCatalogSchema = z.object({
  kind: z.literal("mcp_catalog"),
  catalog_revision: z.string(),
  servers: z.array(McpServerSummarySchema),
  tools: z.array(McpCatalogToolSchema),
  truncated: z.boolean(),
});
export type McpCatalog = z.infer<typeof McpCatalogSchema>;

export const McpToolDescriptionSchema = z.object({
  kind: z.literal("mcp_tool"),
  catalog_revision: z.string(),
  tool: McpCatalogToolSchema.extend({
    input_schema: z.record(z.string(), z.unknown()),
    output_schema: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type McpToolDescription = z.infer<typeof McpToolDescriptionSchema>;

const McpCallContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("resource_link"),
    name: z.string(),
    uri: z.string(),
    description: z.string().optional(),
    mime_type: z.string().optional(),
  }),
  z.object({
    type: z.literal("image"),
    media_id: z.string().uuid(),
    mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
    byte_length: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("media_omitted"),
    media_type: z.enum(["image", "audio", "blob"]),
    mime_type: z.string().optional(),
    byte_length: z.number().int().nonnegative(),
  }),
]);

export const McpCallSchema = z.object({
  kind: z.literal("mcp_call"),
  request_id: z.string().uuid(),
  catalog_revision: z.string(),
  tool: McpCatalogToolSchema.pick({
    ref: true,
    server_id: true,
    server_name: true,
    name: true,
    title: true,
  }),
  is_error: z.boolean(),
  arguments_preview: z.record(z.string(), z.unknown()),
  duration_ms: z.number().int().nonnegative(),
  content: z.array(McpCallContentSchema),
  structured_content: z.record(z.string(), z.unknown()).optional(),
  truncated: z.boolean(),
});
export type McpCall = z.infer<typeof McpCallSchema>;

export const McpMediaInputSchema = z.object({ media_id: z.string().uuid() }).strict();

const McpCallInputSchema = z
  .object({
    tool_ref: z.string().min(1).max(160),
    catalog_revision: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.unknown()).default({}),
    request_id: z.string().uuid(),
  })
  .strict();

export const McpInputs = {
  mcp_catalog_search: z
    .object({
      query: z.string().max(200).default(""),
      server_id: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(30).default(30),
    })
    .strict(),
  mcp_tool_describe: z.object({ tool_ref: z.string().min(1).max(160) }).strict(),
  mcp_tool_call: McpCallInputSchema,
  mcp_read_call: McpCallInputSchema,
} as const;

/**
 * Platform-neutral check for a stdio MCP working directory, also bundled for the browser: a
 * Windows drive path (`C:\` or `C:/`), a UNC share (`\\server\share`) or a POSIX path. The Host
 * re-checks with its own platform rules before saving and before launching.
 */
export function isAbsoluteMcpCwd(value: string) {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]|\/)/.test(value);
}

export const MCP_CWD_INVALID_MESSAGE = "工作目錄須為絕對路徑。";

const McpStdioTransportConfigSchema = z
  .object({
    kind: z.literal("stdio"),
    command: z.string().min(1).max(2048),
    args: z.array(z.string().max(4096)).max(64).default([]),
    // Stored configurations stay readable; a relative legacy value makes only that mount unavailable.
    cwd: z.string().min(1).max(4096).optional(),
    env: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(32)
      .default([]),
  })
  .strict();

const McpHttpTransportConfigSchema = z
  .object({
    kind: z.literal("http"),
    url: z.string().url().max(4096),
    header_env: z
      .record(z.string().min(1).max(128), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .default({}),
  })
  .strict();

export const McpMountConfigSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    transport: z.discriminatedUnion("kind", [
      McpStdioTransportConfigSchema,
      McpHttpTransportConfigSchema,
    ]),
    allowed_read_tools: z
      .array(
        z
          .object({ name: z.string().min(1).max(256), schema_fingerprint: z.string().min(1) })
          .strict(),
      )
      .max(128)
      .default([]),
    disabled_tools: z.array(z.string().min(1).max(256)).max(128).default([]),
  })
  .strict();
export type McpMountConfig = z.infer<typeof McpMountConfigSchema>;

/** Canonical launch identity; enablement is mutable and verified separately. */
export function mcpConfigIdentitySource(config: Pick<McpMountConfig, "name" | "transport">) {
  const identity = McpMountConfigSchema.pick({ name: true, transport: true }).parse({
    name: config.name,
    transport: config.transport,
  });
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
      return `{${Object.keys(value)
        .sort()
        .map(
          (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
        )
        .join(",")}}`;
    return JSON.stringify(value) ?? "null";
  };
  return canonical({ version: 1, ...identity });
}

export async function mcpConfigFingerprint(config: Pick<McpMountConfig, "name" | "transport">) {
  const bytes = new TextEncoder().encode(mcpConfigIdentitySource(config));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const McpMountFileSchema = z
  .object({ version: z.literal(1), servers: z.array(McpMountConfigSchema).max(16) })
  .strict();
const McpPanelServerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  transport: z.enum(["stdio", "http"]),
  config_fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  enabled: z.boolean(),
  state: McpServerStateSchema,
  message: z.string().optional(),
  tools: z.array(McpCatalogToolSchema),
  auth: McpAuthSummarySchema.optional(),
});
export const McpPanelStateSchema = z.object({
  catalog_revision: z.string(),
  servers: z.array(McpPanelServerSchema),
});
export type McpPanelState = z.infer<typeof McpPanelStateSchema>;

export const McpPanelInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("add_stdio"),
      name: z.string().trim().min(1).max(80),
      command: z.string().min(1).max(2048),
      args: z.array(z.string().max(4096)).max(64).default([]),
      cwd: z
        .string()
        .min(1)
        .max(4096)
        .refine(isAbsoluteMcpCwd, { message: MCP_CWD_INVALID_MESSAGE })
        .optional(),
      env: z
        .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
        .max(32)
        .default([]),
    })
    .strict(),
  z
    .object({
      action: z.literal("add_http"),
      name: z.string().trim().min(1).max(80),
      url: z.string().url().max(4096),
      header_env: z
        .record(z.string().min(1).max(128), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
        .default({}),
    })
    .strict(),
  z.object({ action: z.literal("refresh"), server_id: z.string().uuid().optional() }).strict(),
  z
    .object({
      action: z.literal("set_server_enabled"),
      server_id: z.string().uuid(),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("set_tool_enabled"),
      server_id: z.string().uuid(),
      tool_name: z.string().min(1).max(256),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("allow_read"),
      server_id: z.string().uuid(),
      tool_name: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      action: z.literal("deny"),
      server_id: z.string().uuid(),
      tool_name: z.string().min(1).max(256),
    })
    .strict(),
  z.object({ action: z.literal("remove"), server_id: z.string().uuid() }).strict(),
]);
