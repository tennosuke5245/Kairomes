import type { ApprovalItem } from "../apps/extension/src/approval-state.ts";

export const studyWorkspaces = [
  {
    id: "00000000-0000-4000-8000-000000000010",
    name: "晨光工作台／產品側欄與成果版本核對測試專案",
  },
  {
    id: "00000000-0000-4000-8000-000000000020",
    name: "星河資料站／搜尋工具與終端核准範圍驗收專案",
  },
] as const;

export function studyApprovalItems(
  templates: readonly ApprovalItem[],
  count = 10,
  now = Date.now(),
) {
  if (![1, 3, 10].includes(count) || !templates.length) throw new Error("合成核准數量無效。");
  return Array.from({ length: count }, (_, index): ApprovalItem => {
    const template = templates[index % templates.length];
    const workspace = studyWorkspaces[index < Math.ceil(count / 2) ? 0 : 1];
    if (!template) throw new Error("合成核准範本不存在。");
    const id = `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000001`;
    return {
      ...structuredClone(template),
      ...("request_id" in template ? { request_id: id } : {}),
      id,
      workspace_id: workspace.id,
      workspace_name: workspace.name,
      created_at: now - index * 1000,
      expires_at: now + ("shell" in template ? 900000 : 300000),
    };
  });
}

/** State changes describe fixed samples only; no process or file is touched. */
export function studyApprovalDecision(
  item: ApprovalItem,
  action: "approve" | "deny" | "stop",
  now = Date.now(),
) {
  if (action === "stop") {
    if (!(["starting", "running"].includes(item.state) && ("shell" in item || "argv" in item)))
      throw new Error("合成工作目前不可停止。");
    item.state = "shell" in item ? "stopped" : "cancelled";
    return;
  }
  if (item.state !== "pending" || item.expires_at <= now) throw new Error("合成請求已失效。");
  if (action === "deny") {
    item.state = "denied";
  } else if ("argv" in item) {
    item.state = "succeeded";
    item.started_at = now;
    item.ended_at = now + 1;
    item.exit_code = 0;
  } else if ("files" in item) {
    item.state = "applied";
    item.applied_at = now;
  } else {
    item.state = "running";
  }
}
