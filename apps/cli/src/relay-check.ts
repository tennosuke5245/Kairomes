import { fileURLToPath } from "node:url";
import { readWorkbenchConnection, verifyWorkbenchConnection } from "@kairomes/daemon";
import { Inputs, VERSION } from "@kairomes/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type RelayCheck = {
  origin: string;
  /** Version the attached workbench reports; null for an older workbench without one. */
  workbenchVersion: string | null;
  /** True when the workbench is not this CLI's version; its tool list may be stale. */
  versionMismatch: boolean;
  expected: string[];
  tools: string[];
  missing: string[];
  unexpected: string[];
  ok: boolean;
};

function relayEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value &&
      /^(path|systemroot|windir|temp|tmp|home|userprofile|localappdata|appdata|pathext)$/i.test(
        name,
      )
    )
      env[name] = value;
  }
  return env;
}

/**
 * Verifies the exact stdio attach path used by tunnel-client. This only calls
 * MCP initialize and tools/list; it never invokes a Kairomes tool.
 */
export async function relayCheck(
  dataDirectory: string,
  expectedVersion = VERSION,
): Promise<RelayCheck> {
  const connection = await readWorkbenchConnection(dataDirectory);
  const health = await verifyWorkbenchConnection(connection);
  const versionMismatch = health.version !== expectedVersion;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "serve",
      "--attach",
      "--stdio",
      "--data-dir",
      dataDirectory,
    ],
    env: relayEnvironment(),
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "kairomes-relay-check", version: VERSION });
  try {
    await client.connect(transport, { timeout: 7000 });
    const expected = Object.keys(Inputs).sort();
    const listed = (await client.listTools({}, { timeout: 7000 })).tools;
    const tools = listed.map((tool) => tool.name).sort();
    const missing = expected.filter((name) => !tools.includes(name));
    const unexpected = tools.filter((name) => !expected.includes(name));
    return {
      origin: connection.origin,
      workbenchVersion: health.version,
      versionMismatch,
      expected,
      tools,
      missing,
      unexpected,
      ok: missing.length === 0 && unexpected.length === 0 && !versionMismatch,
    };
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}
