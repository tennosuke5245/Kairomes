import { importErrorText } from "./image-file.ts";

/** Fixed text for a refused 復原這批…; the daemon's own message is never shown. */
const revertRefusals: Record<string, string> = {
  REVERT_CONFLICT: "這批有檔案在套用後又被修改、移除或重新建立，無法復原。",
  REVERT_UNAVAILABLE: "只有仍在保留清單內、已套用的檔案變更可以復原。",
  FILE_CHANGE_NOT_FOUND: "這批變更已不在保留清單內，無法復原。",
  NO_CHANGES: "這批只建立了資料夾，沒有可復原的檔案內容。",
  CHANGE_REVIEW_TOO_LARGE: "復原的差異超過本機完整審查上限，無法復原這批。",
};

/** A refused or failed side-panel request. Its message is fixed text chosen by status (and a few known codes). */
export class PanelRequestError extends Error {
  constructor(
    readonly status: number,
    /** Daemon error code, e.g. MCP_CWD_INVALID or IMPORT_PREVIEW_REQUIRED; only fixed-map text is ever shown for it. */
    readonly code?: string,
    /** Fixed text chosen by the caller for this code, e.g. by revertRefusal(). */
    message?: string,
  ) {
    super(
      message ??
        (status === 401 || status === 403
          ? "配對已失效。"
          : code === "IMPORT_PREVIEW_REQUIRED"
            ? importErrorText(code)
            : status === 409
              ? "請求已變更；請重新審閱。"
              : status === 429
                ? "請稍後再查詢狀態。"
                : status < 500
                  ? "請求未被接受。"
                  : "結果待確認。"),
    );
  }
}

/**
 * Names why 復原這批… was refused. Only the revert request uses it: the same codes from an
 * approve, deny or stop keep the generic status text.
 */
export function revertRefusal(error: PanelRequestError) {
  return error.status === 400 && error.code && Object.hasOwn(revertRefusals, error.code)
    ? new PanelRequestError(error.status, error.code, revertRefusals[error.code])
    : error;
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
