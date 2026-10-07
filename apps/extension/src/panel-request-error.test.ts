import { expect, test } from "bun:test";
import { MCP_COMMAND_RELATIVE_MESSAGE, MCP_CWD_INVALID_MESSAGE } from "@kairomes/protocol";
import { importErrorText } from "./image-file.ts";
import { mcpCwdRefusal, settleMcpMutation } from "./mcp-mutation.ts";
import { PanelRequestError, panelErrorCode, panelRequestError } from "./panel-request-error.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("a Host refusal keeps its code, so the add form marks the working-directory field", async () => {
  // A Linux Host given a Windows path answers this way before saving anything.
  const invalid = await panelRequestError(
    json(400, { code: "MCP_CWD_INVALID", message: "C:\\private\\work" }),
  );
  expect(invalid).toBeInstanceOf(PanelRequestError);
  expect(invalid.status).toBe(400);
  expect(invalid.code).toBe("MCP_CWD_INVALID");
  // Only the fixed status sentence is visible; the response's own text is never shown.
  expect(invalid.message).toBe("請求未被接受。");
  expect(mcpCwdRefusal(invalid)).toBe(MCP_CWD_INVALID_MESSAGE);
  const relative = await panelRequestError(
    json(400, { code: "MCP_COMMAND_RELATIVE", message: "/private/start.sh" }),
  );
  expect(mcpCwdRefusal(relative)).toBe(MCP_COMMAND_RELATIVE_MESSAGE);
  expect(relative.message).toBe("請求未被接受。");
});

test("non-JSON or code-less failures carry no code and keep their status text", async () => {
  const cases: Array<[Response, string]> = [
    [new Response("Busy", { status: 503 }), "結果待確認。"],
    [new Response("Invalid host", { status: 400 }), "請求未被接受。"],
    [new Response(null, { status: 429 }), "請稍後再查詢狀態。"],
    [json(401, { message: "/private/token" }), "配對已失效。"],
    [json(403, { code: 42 }), "配對已失效。"],
    [json(409, ["MCP_CWD_INVALID"]), "請求已變更；請重新審閱。"],
    [json(400, "MCP_CWD_INVALID"), "請求未被接受。"],
    [json(400, null), "請求未被接受。"],
  ];
  for (const [response, message] of cases) {
    const error = await panelRequestError(response);
    expect(error.status).toBe(response.status);
    expect(error.code).toBeUndefined();
    expect(error.message).toBe(message);
    expect(mcpCwdRefusal(error)).toBeUndefined();
  }
  // Other daemon codes are kept but are not working-directory refusals.
  const validation = await panelRequestError(json(400, { code: "VALIDATION", message: "x" }));
  expect(validation.code).toBe("VALIDATION");
  expect(mcpCwdRefusal(validation)).toBeUndefined();
  for (const body of [undefined, null, "MCP_CWD_INVALID", { code: ["MCP_CWD_INVALID"] }])
    expect(panelErrorCode(body)).toBeUndefined();
});

test("a converted Host refusal settles as rejected without a reconciliation read", async () => {
  const requests: unknown[] = [];
  let paused = false;
  const body = { action: "add_stdio", name: "相對路徑", command: "npx", cwd: "work" };
  const result = await settleMcpMutation(
    async (request) => {
      requests.push(request);
      throw await panelRequestError(
        json(400, { code: "MCP_CWD_INVALID", message: MCP_CWD_INVALID_MESSAGE }),
      );
    },
    body,
    () => {
      paused = true;
    },
    () => true,
    () => true,
    (error) => mcpCwdRefusal(error) !== undefined,
  );
  expect(result.outcome).toBe("rejected");
  expect(paused).toBe(false);
  expect(requests).toEqual([body]);
  // Without the code, the same 400 is uncertain and is read back instead of marking the field.
  const uncoded: unknown[] = [];
  const unknown = await settleMcpMutation(
    async (request) => {
      uncoded.push(request);
      if ((request as { action: string }).action === "list") return "listed";
      throw await panelRequestError(new Response("Invalid host", { status: 400 }));
    },
    body,
    () => {},
    () => false,
    () => true,
    (error) => mcpCwdRefusal(error) !== undefined,
  );
  expect(unknown).toEqual({ outcome: "unknown", state: "listed" });
  expect(uncoded).toEqual([body, { action: "list" }]);
});

test("an image approval refused for a missing preview shows the import sentence, not the status text", async () => {
  const error = await panelRequestError(json(409, { code: "IMPORT_PREVIEW_REQUIRED" }));
  expect(error.code).toBe("IMPORT_PREVIEW_REQUIRED");
  expect(error.message).toBe(importErrorText("IMPORT_PREVIEW_REQUIRED"));
  expect(error.message).not.toBe("請求已變更；請重新審閱。");
  // An expired pairing still wins over any code.
  expect((await panelRequestError(json(403, { code: "IMPORT_PREVIEW_REQUIRED" }))).message).toBe(
    "配對已失效。",
  );
});
