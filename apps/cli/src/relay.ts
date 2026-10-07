import { readWorkbenchConnection, verifyWorkbenchConnection } from "@kairomes/daemon";
import { LIMITS } from "@kairomes/protocol";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

export const RELAY_LIMITS = {
  inFlight: 8,
  timeoutMs: 30_000,
  /** Same cap as the workbench HTTP server, so a batch the daemon accepts always fits. */
  requestBytes: LIMITS.requestBodyBytes,
  responseBytes: 2 * 1024 * 1024,
} as const;

/** JSON-RPC server-error codes, so the model can tell why the relay answered instead. */
export const RELAY_ERROR_CODES = {
  offline: -32000,
  timeout: -32001,
  tooLarge: -32013,
  busy: -32029,
} as const;

export type RelayFailure = keyof typeof RELAY_ERROR_CODES;

export function relayError(
  failure: RelayFailure,
  requestBytes: number = RELAY_LIMITS.requestBytes,
) {
  switch (failure) {
    case "tooLarge":
      return {
        code: RELAY_ERROR_CODES.tooLarge,
        message: `Request too large for the local relay (limit ${Math.floor(requestBytes / 1024)} KiB). Split the change into smaller batches.`,
        data: { reason: "request_too_large", limit_bytes: requestBytes },
      };
    case "timeout":
      return {
        code: RELAY_ERROR_CODES.timeout,
        message: "The local workbench did not answer in time; retry with the same request_id.",
        data: { reason: "timeout" },
      };
    case "busy":
      return {
        code: RELAY_ERROR_CODES.busy,
        message:
          "The local relay is busy with other requests; retry shortly with the same request_id.",
        data: { reason: "busy" },
      };
    case "offline":
      return {
        code: RELAY_ERROR_CODES.offline,
        message: "本機工作台無法完成請求；請確認 app 仍在執行。變更請求不會自動重送。",
        data: { reason: "offline" },
      };
  }
}

class RelayRequestError extends Error {
  constructor(readonly failure: RelayFailure) {
    super(failure);
  }
}

export type RelayOptions = {
  origin: string;
  token: string;
  /** Writes one JSON-RPC message to the stdio client; nothing else may reach stdout. */
  send(message: JSONRPCMessage): Promise<void>;
  closed(): boolean;
  signal: AbortSignal;
  timeoutMs?: number;
  requestBytes?: number;
};

/** Forwards one stdio JSON-RPC message to /api/mcp and answers requests the workbench did not. */
export function createRelayForwarder(options: RelayOptions) {
  const timeoutMs = options.timeoutMs ?? RELAY_LIMITS.timeoutMs;
  const requestBytes = options.requestBytes ?? RELAY_LIMITS.requestBytes;
  let inFlight = 0;
  const replyError = async (message: JSONRPCMessage, failure: RelayFailure) => {
    if (!options.closed() && "id" in message && "method" in message)
      await options.send({
        jsonrpc: "2.0",
        id: message.id,
        error: relayError(failure, requestBytes),
      });
  };
  return async (message: JSONRPCMessage) => {
    if (options.closed()) return;
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body) > requestBytes) {
      await replyError(message, "tooLarge");
      return;
    }
    if (inFlight >= RELAY_LIMITS.inFlight) {
      await replyError(message, "busy");
      return;
    }
    inFlight++;
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(`${options.origin}/api/mcp`, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${options.token}`,
        },
        body,
        signal: AbortSignal.any([options.signal, timeout]),
      });
      if (response.status === 413) throw new RelayRequestError("tooLarge");
      if (response.status === 429) throw new RelayRequestError("busy");
      if (!response.ok) throw new Error("local request rejected");
      if (response.status === 202) return;
      if (!response.headers.get("content-type")?.includes("application/json"))
        throw new Error("invalid response");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("empty response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > RELAY_LIMITS.responseBytes) throw new Error("response too large");
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel();
      }
      const reply = JSONRPCMessageSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!options.closed()) await options.send(reply);
    } catch (error) {
      await replyError(
        message,
        error instanceof RelayRequestError
          ? error.failure
          : timeout.aborted && !options.signal.aborted
            ? "timeout"
            : "offline",
      );
    } finally {
      inFlight--;
    }
  };
}

/** Tunnel owns this stdio process, but never owns the shared workbench service. */
export async function startAttachedRelay(directory: string) {
  const connection = await readWorkbenchConnection(directory);
  await verifyWorkbenchConnection(connection);
  const transport = new StdioServerTransport();
  const abort = new AbortController();
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    abort.abort();
    await transport.close();
  };
  const forward = createRelayForwarder({
    origin: connection.origin,
    token: connection.mcpToken,
    send: (message) => transport.send(message),
    closed: () => closed,
    signal: abort.signal,
  });
  transport.onmessage = (message) => {
    void forward(message).catch(() => shutdown());
  };
  transport.onerror = () => {
    console.error("MCP relay 收到無效的 stdio 訊息。");
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.stdin.once("end", () => {
    void shutdown();
  });
  await transport.start();
}
