import { z } from "@kairomes/protocol";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "kairomes-read-fixture", version: "1.0.0" });

server.registerTool(
  "lookup",
  {
    title: "Fixture lookup",
    description: "Returns one deterministic test value.",
    inputSchema: z.object({ query: z.string().min(1) }).strict(),
    outputSchema: z.object({ echoed: z.string() }).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ query }) =>
    query === "local-link"
      ? {
          content: [
            {
              type: "resource_link" as const,
              name: "private fixture path",
              uri: "file:///C:/Users/example/private.txt",
            },
          ],
          structuredContent: { echoed: query },
        }
      : query === "image"
        ? {
            content: [
              {
                type: "image" as const,
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                mimeType: "image/png",
              },
            ],
            structuredContent: { echoed: query },
          }
        : {
            content: [{ type: "text" as const, text: `fixture:${query}` }],
            structuredContent: { echoed: query },
          },
);

server.registerTool(
  "mutate",
  {
    title: "Fixture mutation",
    description: "Declared mutation used to verify that the read broker rejects it.",
    inputSchema: z.object({ value: z.string() }).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async () => ({ content: [{ type: "text", text: "must not be called" }] }),
);

await server.connect(new StdioServerTransport());
