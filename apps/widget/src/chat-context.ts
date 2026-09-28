interface ChatContext {
  message: string;
  workspaceId?: string;
  filePath?: string;
}

/**
 * Keep widget-originated messages explicit: the model receives useful local
 * context without the widget ever reading more file content than the user saw.
 */
export function buildChatMessage({ message, workspaceId, filePath }: ChatContext): string {
  const request = message.trim();
  if (!request) throw new Error("請先輸入要交給 ChatGPT 的訊息。");

  const activeContext = [
    workspaceId ? `目前工作區的 workspace_id=${JSON.stringify(workspaceId)}。` : undefined,
    filePath ? `目前選取檔案的 path=${JSON.stringify(filePath)}。` : undefined,
  ].filter((item): item is string => Boolean(item));

  return [
    "使用者正在 Kairomes 本機工作台中提出需求。",
    ...activeContext,
    "",
    "使用者訊息：",
    request,
    "",
    "若需要查閱或操作此工作區，請使用 Kairomes 工具。任何終端機操作都必須等待本機使用者批准。",
  ].join("\n");
}
