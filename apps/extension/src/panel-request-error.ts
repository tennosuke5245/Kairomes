/** A refused or failed side-panel request. Its message is fixed text chosen by status only. */
export class PanelRequestError extends Error {
  constructor(
    readonly status: number,
    /** Daemon error code, e.g. MCP_CWD_INVALID; only fixed-map text is ever shown for it. */
    readonly code?: string,
  ) {
    super(
      status === 401 || status === 403
        ? "配對已失效。"
        : status === 409
          ? "請求已變更；請重新審閱。"
          : status === 429
            ? "請稍後再查詢狀態。"
            : status < 500
              ? "請求未被接受。"
              : "結果待確認。",
    );
  }
}

/** Keeps only a string `code` from an error body; the body's own message is never shown. */
export function panelErrorCode(body: unknown) {
  return body && typeof body === "object" && "code" in body && typeof body.code === "string"
    ? body.code
    : undefined;
}

/** Converts a non-OK response; a body that is not JSON leaves the status to classify it. */
export async function panelRequestError(response: Pick<Response, "status" | "json">) {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    /* The status alone still classifies the failure. */
  }
  return new PanelRequestError(response.status, panelErrorCode(body));
}
