/** Full snapshots give reconnecting/slow readers a consistent state without replay races. */
export function snapshotStream(
  request: Request,
  subscribe: (listener: () => void) => () => void,
  snapshot: () => unknown,
  headers: Record<string, string>,
  connections: Set<() => void>,
  authorized = () => true,
) {
  if (connections.size >= 12) return new Response("Too many observers", { status: 429, headers });
  let dispose = () => {};
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe = () => {};
        const close = () => {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          clearInterval(heartbeat);
          unsubscribe();
          request.signal.removeEventListener("abort", close);
          connections.delete(close);
          // cancel() may have already closed the consumer's stream.
          try {
            controller.close();
          } catch {
            /* Cleanup is idempotent. */
          }
        };
        const send = (heartbeatOnly = false) => {
          if (closed) return;
          if (!authorized() || (controller.desiredSize ?? 0) <= 0) {
            close();
            return;
          }
          controller.enqueue(
            encoder.encode(
              heartbeatOnly ? ": heartbeat\n\n" : `data: ${JSON.stringify(snapshot())}\n\n`,
            ),
          );
        };
        const heartbeat = setInterval(() => send(true), 15000);
        heartbeat.unref();
        unsubscribe = subscribe(() => {
          timer ??= setTimeout(() => {
            timer = undefined;
            send();
          }, 100);
        });
        dispose = close;
        connections.add(close);
        request.signal.addEventListener("abort", close, { once: true });
        if (request.signal.aborted) close();
        else send();
      },
      cancel() {
        dispose();
      },
    },
    { highWaterMark: 4 },
  );
  return new Response(body, {
    headers: { ...headers, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" },
  });
}
