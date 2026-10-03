/** Consume bounded JSON snapshots over an authenticated fetch stream. */
export async function readSnapshots<T>(
  response: Response,
  receive: (snapshot: T) => void,
  signal: AbortSignal,
) {
  if (signal.aborted) {
    await response.body?.cancel().catch(() => {});
    return;
  }
  if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream"))
    throw new Error(response.status === 401 ? "配對已失效，請重新配對。" : "即時連線未就緒。");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("即時連線沒有回應內容。");
  const decoder = new TextDecoder();
  let buffer = "";
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const resetDeadline = () => {
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => {});
    }, 45000);
  };
  const abort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  try {
    resetDeadline();
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (signal.aborted) break;
      if (chunk.done) break;
      resetDeadline();
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 2 * 1024 * 1024) throw new Error("即時回應超過保留上限。");
      let end = buffer.indexOf("\n\n");
      while (end >= 0 && !signal.aborted) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) receive(JSON.parse(data.slice(6)) as T);
        end = buffer.indexOf("\n\n");
      }
    }
    if (!signal.aborted) throw new Error(timedOut ? "即時連線逾時。" : "即時連線已中斷。");
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
