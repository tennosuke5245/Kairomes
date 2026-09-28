import { type ToolData, ToolDataSchema } from "@kairomes/protocol";

export function decodeResult(result: {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
}): ToolData {
  const texts = Array.isArray(result.content)
    ? result.content.filter((entry) => entry?.type === "text" && typeof entry.text === "string")
    : [];
  if (result.isError) {
    let message = "工具無法完成操作。";
    try {
      message = JSON.parse(texts[0]?.text ?? "{}").message ?? message;
    } catch {
      /* Keep safe fallback. */
    }
    throw new Error(message);
  }
  const candidates: unknown[] = [result.structuredContent];
  for (const item of texts) {
    try {
      candidates.push(JSON.parse(item.text));
    } catch {
      /* Not every text block is tool data. */
    }
  }
  for (const candidate of candidates) {
    const parsed = ToolDataSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  // Some hosts omit null fields. Repair only a provable end-of-file marker,
  // never infer pagination for a truncated response or weaken the server schema.
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const data = candidate as Record<string, unknown>;
    if (
      data.kind !== "file" ||
      data.next_line !== undefined ||
      data.truncated !== false ||
      typeof data.start_line !== "number" ||
      typeof data.total_lines !== "number" ||
      typeof data.content !== "string" ||
      data.start_line + data.content.split("\n").length - 1 < data.total_lines
    )
      continue;
    const parsed = ToolDataSchema.safeParse({ ...data, next_line: null });
    if (parsed.success) return parsed.data;
  }
  throw new Error(
    "工具回傳資料不完整，請重試；若持續發生，請更新 Kairomes 並在 ChatGPT 重新整理工具連線。",
  );
}
