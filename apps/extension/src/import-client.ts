import {
  type ArtifactImportApproval,
  IMAGE_IMPORT_UPLOAD_ID_HEADER,
  type PanelImportCreate,
  type PanelImportResponse,
} from "@kairomes/protocol";
import type { PreparedImage } from "./image-file.ts";
import type { ImageUploadTracker } from "./image-upload.ts";

// The panel's three trusted image routes. The coordinator supplies `fetch`, which adds the
// pairing token and the 127.0.0.1 origin; nothing here retries on its own. A failure is either
// refused (a daemon code, safe to fix and try again) or unknown (the request may have been
// applied): an unknown upload keeps its upload ID, an unknown create keeps its request ID.

export class ImportRequestError extends Error {
  constructor(
    /** Daemon error code, or UNKNOWN when the outcome cannot be known. */
    readonly code: string,
    readonly status: number | undefined,
    readonly unknown: boolean,
    /** False when the panel refused before sending anything (offline, no pairing). */
    readonly sent = true,
  ) {
    super(code);
    this.name = "ImportRequestError";
  }

  /** A definite refusal raised before any request left the panel. */
  static unsent(code: string) {
    return new ImportRequestError(code, undefined, false, false);
  }
}

export type PanelFetch = (
  path: string,
  init: RequestInit & { timeoutMs: number },
) => Promise<Response>;

const fallbackCodes: Record<number, string> = {
  401: "PANEL_UNAUTHORIZED",
  403: "PANEL_FORBIDDEN",
  404: "ARTIFACT_IMPORT_NOT_FOUND",
  409: "IMPORT_NOT_AWAITING_FILE",
  413: "ARTIFACT_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "ARTIFACT_IMPORT_LIMIT",
};

/** Turns a non-OK response into a refusal (4xx) or an unknown outcome (5xx, unreadable). */
export async function responseError(response: Response) {
  if (response.status >= 500) return new ImportRequestError("UNKNOWN", response.status, true);
  let code: string | undefined;
  try {
    const data: unknown = await response.json();
    if (data && typeof data === "object" && "code" in data && typeof data.code === "string")
      code = data.code;
  } catch {
    /* A body that is not JSON still has a meaningful status. */
  }
  if (response.status === 401) code = "PANEL_UNAUTHORIZED";
  if (response.status === 403) code = "PANEL_FORBIDDEN";
  return new ImportRequestError(
    code && /^[A-Z_]{1,64}$/.test(code) ? code : (fallbackCodes[response.status] ?? "REJECTED"),
    response.status,
    false,
  );
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function importResponse(value: unknown): PanelImportResponse {
  const data = value as Partial<PanelImportResponse> | null;
  if (
    !data ||
    typeof data !== "object" ||
    typeof data.instanceId !== "string" ||
    !data.import ||
    typeof data.import !== "object" ||
    typeof data.import.id !== "string" ||
    !uuid.test(data.import.id)
  )
    throw new ImportRequestError("UNKNOWN", 200, true);
  return data as PanelImportResponse;
}

export class ImportClient {
  constructor(
    private readonly options: {
      fetch: PanelFetch;
      uploads: ImageUploadTracker;
      /** The paired instance the tracker is bound to (origin + instance ID). */
      source: () => string | undefined;
    },
  ) {}

  private async send(path: string, init: RequestInit & { timeoutMs: number }) {
    let response: Response;
    try {
      response = await this.options.fetch(path, init);
    } catch (cause) {
      // A caller's own abort (closing the preview) is not an outcome of the request, and a
      // refusal raised before sending (no pairing) is already definite.
      if (init.signal?.aborted || cause instanceof ImportRequestError) throw cause;
      throw new ImportRequestError("UNKNOWN", undefined, true);
    }
    if (!response.ok) throw await responseError(response);
    return response;
  }

  private async json(response: Response) {
    try {
      return importResponse(await response.json());
    } catch (cause) {
      if (cause instanceof ImportRequestError) throw cause;
      throw new ImportRequestError("UNKNOWN", response.status, true);
    }
  }

  /**
   * Opens a user-started import in awaiting_file. The same request ID returns the same import.
   * Aborting (the dialog was closed) leaves the outcome unknown: the import may exist.
   */
  async create(input: PanelImportCreate, signal?: AbortSignal) {
    const response = await this.send("/api/panel/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
      timeoutMs: 10_000,
    });
    return this.json(response);
  }

  /**
   * Sends the prepared bytes for an awaiting_file import. The upload ID comes from the
   * tracker: new for new bytes, the same one again after an unconfirmed attempt. An aborted
   * upload may still have reached the daemon, so it is unconfirmed like a lost answer.
   */
  async upload(
    item: Pick<ArtifactImportApproval, "id">,
    image: PreparedImage,
    signal?: AbortSignal,
  ) {
    const source = this.options.source();
    const uploadId = this.options.uploads.begin(source, item.id, image.sha256);
    if (!uploadId) throw new ImportRequestError("UPLOAD_IN_PROGRESS", undefined, false);
    try {
      const response = await this.send(`/api/panel/imports/${item.id}/file`, {
        method: "POST",
        headers: { "Content-Type": image.mime, [IMAGE_IMPORT_UPLOAD_ID_HEADER]: uploadId },
        body: image.blob,
        ...(signal ? { signal } : {}),
        // The daemon allows 60 s of receiving; give it room to answer before calling it unknown.
        timeoutMs: 90_000,
      });
      const data = await this.json(response);
      this.options.uploads.settle(source, item.id, uploadId, "accepted");
      return data;
    } catch (cause) {
      const error =
        cause instanceof ImportRequestError
          ? cause
          : new ImportRequestError("UNKNOWN", undefined, true);
      // Nothing reached the daemon: the upload ID of an earlier unconfirmed try stays reserved
      // for these bytes, and that try stays unconfirmed.
      if (!error.sent) this.options.uploads.unsent(source, item.id, uploadId);
      else
        this.options.uploads.settle(
          source,
          item.id,
          uploadId,
          error.unknown ? "unknown" : { rejected: error.code },
        );
      throw error;
    }
  }

  /** The pending bytes, read by this panel: what lets this pairing approve them. */
  async content(item: Pick<ArtifactImportApproval, "id">, signal: AbortSignal) {
    const response = await this.send(`/api/panel/imports/${item.id}/content`, {
      method: "GET",
      signal,
      timeoutMs: 20_000,
    });
    let bytes: ArrayBuffer;
    try {
      bytes = await response.arrayBuffer();
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new ImportRequestError("UNKNOWN", response.status, true);
    }
    return { bytes, type: response.headers.get("content-type") ?? "" };
  }
}
