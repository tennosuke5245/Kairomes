import { readWorkbenchConnection, verifyWorkbenchConnection } from "@kairomes/daemon";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

/** Tunnel owns this stdio process, but never owns the shared workbench service. */
export async function startAttachedRelay(directory: string) {
  const connection = await readWorkbenchConnection(directory);
  await verifyWorkbenchConnection(connection);
  const transport = new StdioServerTransport();
  const abort = new AbortController();
  let inFlight = 0;
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    abort.abort();
    await transport.close();
  };
  const replyError = async (message: JSONRPCMessage) => {
    if (!closed && "id" in message && "method" in message)
      await transport.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: "本機工作台無法完成請求；請確認 app 仍在執行。變更請求不會自動重送。",
        },
      });
  };
  const forward = async (message: JSONRPCMessage) => {
    if (closed) return;
    const body = JSON.stringify(message);
    if (inFlight >= 8 || Buffer.byteLength(body) > 32768) {
      await replyError(message);
      return;
    }
    inFlight++;
    try {
      const response = await fetch(`${connection.origin}/api/mcp`, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${connection.mcpToken}`,
        },
        body,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
      });
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
          if (size > 2 * 1024 * 1024) throw new Error("response too large");
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel();
      }
      const reply = JSONRPCMessageSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!closed) await transport.send(reply);
    } catch {
      await replyError(message);
    } finally {
      inFlight--;
    }
  };
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
