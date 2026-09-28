import { expect, test } from "bun:test";
import { buildChatMessage } from "./chat-context.ts";

test("chat message includes only the active opaque workspace and file context", () => {
  expect(
    buildChatMessage({
      message: "  請解釋目前的架構。  ",
      workspaceId: "ws_alpha",
      filePath: "apps/widget/src/main.tsx",
    }),
  ).toBe(
    [
      "使用者正在 Kairomes 本機工作台中提出需求。",
      '目前工作區的 workspace_id="ws_alpha"。',
      '目前選取檔案的 path="apps/widget/src/main.tsx"。',
      "",
      "使用者訊息：",
      "請解釋目前的架構。",
      "",
      "若需要查閱或操作此工作區，請使用 Kairomes 工具。任何終端機操作都必須等待本機使用者批准。",
    ].join("\n"),
  );
});

test("chat message can start without a selected workspace", () => {
  const message = buildChatMessage({ message: "請說明 Kairomes 可以做什麼？" });
  expect(message).not.toContain("workspace_id=");
  expect(message).not.toContain("path=");
});

test("chat message rejects an empty draft", () => {
  expect(() => buildChatMessage({ message: " \n " })).toThrow("請先輸入要交給 ChatGPT 的訊息。");
});
