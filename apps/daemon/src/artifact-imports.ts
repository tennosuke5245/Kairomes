import { createHash } from "node:crypto";
import {
  type ActivitySource,
  type Artifact,
  type ArtifactImport,
  type ArtifactImportApproval,
  type ArtifactImportDelivery,
  type ArtifactImportState,
  artifactImportActive,
  IMAGE_IMPORT_UPLOAD_TYPES,
  type ImageImport,
  type ImageImportHydration,
  ImageImportInputs,
  type ImageImportResult,
  KairomesError,
  LIMITS,
  type OpenAIFileReference,
  PanelImportCreateSchema,
  publicError,
} from "@kairomes/protocol";
import {
  ArtifactImportWriteError,
  type PreparedArtifactImport,
  WorkspaceArtifactImports,
  type WorkspaceRegistry,
} from "@kairomes/workspace-core";
import { denialReason } from "./approval-decision.ts";
import { checkFileReference, downloadOpenAIFile } from "./openai-file-download.ts";

/** Fetches one host file parameter; injected in tests so no real network is used. */
export type ArtifactDownload = (
  reference: OpenAIFileReference,
  options: { signal: AbortSignal },
) => Promise<Uint8Array>;

/** Who opened the import: an MCP or local tool call, or the local user in the side panel. */
type Origin = "tool" | "panel";

type Job = {
  view: ArtifactImport;
  source: ActivitySource;
  origin: Origin;
  /** Key of this import's request identity in `requests`. */
  key: string;
  delivery: ArtifactImportDelivery;
  identity: string;
  /** Changes when verified bytes arrive; approve needs the content fingerprint. */
  fingerprint: string;
  /**
   * Hashes of the panel tokens whose request read the current verified bytes through
   * content(). Approve needs the approving panel to be one of them; cleared on new bytes.
   */
  reviewed: Set<string>;
  prepared?: PreparedArtifactImport;
  /** Host download URLs for this file, only while preparing; never exposed or logged. */
  urls: string[];
  abort?: AbortController;
  /** The background download of a host file, awaited on close. */
  task?: Promise<void>;
  uploadId: string | null;
  uploadError?: { code: string; message: string };
  /** Deadline of the panel upload being received; it never shortens `expires_at`. */
  receiveBy?: number;
  applying?: Promise<void>;
  released: boolean;
};

export const IMAGE_IMPORT_LIMITS = {
  /**
   * Unfinished imports (awaiting_file, preparing, pending, applying) per origin. Tool calls
   * never use the side panel's own slots, so the model cannot block the user's imports.
   */
  toolUnfinished: 4,
  panelUnfinished: 2,
  /** Imports holding image bytes in memory (preparing, pending, applying). */
  holding: 3,
  /** Host-file downloads may use only part of `holding`; one slot stays for the user's image. */
  hostHolding: 2,
  /** Finished imports kept for poll and the panel; an unknown write result is never dropped. */
  retained: 32,
  /** Request identities per origin since the service started. */
  toolRequests: 4096,
  panelRequests: 1024,
  /** At the identity limit, tombstones of imports that wrote nothing are dropped after this. */
  tombstoneMs: 30 * 60_000,
  awaitingMs: 10 * 60_000,
  pendingMs: 10 * 60_000,
  /** Safety deadline for receiving and verifying one image, download or panel upload. */
  preparingMs: 60_000,
  /** A duplicate call may offer one more download URL for the same file while preparing. */
  urls: 2,
} as const;
const limits = IMAGE_IMPORT_LIMITS;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflictCodes = new Set([
  "FILE_EXISTS",
  "WORKSPACE_CHANGED",
  "OUTSIDE_WORKSPACE",
  "IMPORT_CHANGED",
  "LINK_BLOCKED",
  "PARENT_NOT_FOUND",
  "NOT_DIRECTORY",
]);
/** Failures of the host file itself: the user can still provide the image in the panel. */
const sourceCodes = new Set([
  "FILE_DOWNLOAD_FAILED",
  "FILE_DOWNLOAD_TIMEOUT",
  "FILE_REDIRECT_BLOCKED",
  "UNSAFE_FILE_HOST",
  "IMPORT_SOURCE_REJECTED",
  "IMPORT_NOT_IMAGE",
  "INVALID_IMAGE",
  "ARTIFACT_TOO_LARGE",
  "UNSAFE_IMAGE_DIMENSIONS",
  "ANIMATED_IMAGE_UNSUPPORTED",
]);
const holdingStates = new Set<ArtifactImportState>(["preparing", "pending", "applying"]);

/** Display text from the host: single line, no control or bidi characters, else null. */
function displayText(value: string | undefined, max: number) {
  if (
    !value ||
    value.length > max ||
    /[\\/]/u.test(value) ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return (
        code < 32 ||
        code === 127 ||
        (code >= 0x200b && code <= 0x200f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      );
    })
  )
    return null;
  return value.normalize("NFC");
}

/** Host-reported MIME type for display only; the verified bytes decide the real format. */
function mimeText(value: string | undefined) {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mime.length <= 200 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime)
    ? mime
    : null;
}

/** Stored messages stay within the 500-character bound of the published result schema. */
function boundedMessage(message: string) {
  if (message.length <= 500) return message;
  const cut = message.slice(0, 499);
  // Never end on half of a surrogate pair.
  return `${/[\ud800-\udbff]$/u.test(cut) ? cut.slice(0, -1) : cut}…`;
}

function closedError() {
  return new KairomesError("ARTIFACT_IMPORT_CLOSED", "圖片匯入服務已關閉。");
}

/** Why a running download or upload was stopped, from the state that stopped it. */
function stopError(state: ArtifactImportState) {
  if (state === "expired") return new KairomesError("IMPORT_EXPIRED", "這筆圖片匯入已到期。");
  if (state === "denied") return new KairomesError("IMPORT_DENIED", "這筆圖片匯入已被拒絕。");
  return new KairomesError("IMPORT_CANCELLED", "匯入已取消。");
}

/** The reason an aborted transfer reports: the stop reason when known, else cancelled. */
function abortError(signal: AbortSignal) {
  return signal.reason instanceof KairomesError ? signal.reason : stopError("cancelled");
}

/** Only a hash of the panel token is kept to bind a preview to the approving panel. */
const reviewerKey = (reviewer: string) => createHash("sha256").update(reviewer).digest("hex");

function limitError(message: string) {
  return new KairomesError("ARTIFACT_IMPORT_LIMIT", message);
}

/** English next step for the model; the Chinese `message` stays for the local user. */
function guidance(view: ArtifactImport) {
  switch (view.state) {
    case "awaiting_file":
      return "The image was not attached to this call. Ask the user to drop, paste or choose the image in the Kairomes side panel, where this import waits until expires_at. Then call image_import_poll with this import_id until it is applied, denied, cancelled or expired. Never send /mnt/data paths, Base64, shell copies or URLs instead.";
    case "preparing":
      return "Kairomes is receiving and verifying the image. Call image_import_poll with this import_id; once verified, the local user must approve it in the Kairomes side panel. Do not start another request for the same image.";
    case "pending":
      return "The verified image waits for the local user's individual approval in the Kairomes side panel; autonomy grants never approve imports. Poll with image_import_poll until it is applied, denied, cancelled or expired. Never ask for tokens, fingerprints or URLs.";
    case "applying":
      return "The approved image is being written. Poll again; do not resend the request.";
    case "applied":
      return "Saved as a new file at path and verified by reading it back; version is its SHA-256. Use artifact_preview to show the current file.";
    case "denied":
      return "The local user declined this import. If denial_reason is present, address it; do not resend the same request.";
    case "cancelled":
      return "The import was cancelled and nothing was written.";
    case "expired":
      return "The import expired before it was completed and nothing was written. Start a new request with a new request_id only if the user still wants the image saved.";
    case "conflict":
      return "Nothing was written: the target appeared or the workspace changed before the write, and existing files are never overwritten. Ask the user for another path and use a new request_id.";
    case "failed":
      if (view.write_outcome === "unknown")
        return "The write result is unknown and a file may exist at path. Check it with artifact_preview before doing anything else; do not retry with a new request_id.";
      if (view.error_code === "ARTIFACT_EXTENSION_MISMATCH")
        return "Nothing was written: the image format does not match the path extension (see message). Call image_import_request again with a new request_id and a path whose extension matches the image.";
      if (view.error_code && sourceCodes.has(view.error_code))
        return "Nothing was written: the attached file could not be downloaded or verified as a still PNG, JPEG or WebP image within the limits. Call image_import_request again with a new request_id and without file, then ask the user to drop the image into the Kairomes side panel.";
      return "Nothing was written (see error_code and message). Fix the cause, then use a new request_id; do not repeat this request_id.";
  }
}

/** Model-facing view: no source file ID or name, fingerprint, delivery or upload ID. */
function publicView(view: ArtifactImport): ImageImport {
  return {
    id: view.id,
    request_id: view.request_id,
    workspace_id: view.workspace_id,
    path: view.path,
    summary: view.summary,
    state: view.state,
    write_outcome: view.write_outcome,
    mime_type: view.mime_type,
    byte_size: view.byte_size,
    width: view.width,
    height: view.height,
    version: view.version,
    created_at: view.created_at,
    expires_at: view.expires_at,
    applied_at: view.applied_at,
    error_code: view.error_code,
    message: view.message,
    ...(view.denial_reason ? { denial_reason: view.denial_reason } : {}),
    artifact: view.artifact,
  };
}

/**
 * Settles as soon as `signal` aborts, even if the download ignores it; bytes that still arrive
 * afterwards are zeroed and dropped.
 */
function unlessAborted(promise: Promise<Uint8Array>, signal: AbortSignal) {
  return new Promise<Uint8Array>((resolve, reject) => {
    if (signal.aborted) reject(abortError(signal));
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (data) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) data.fill(0);
        else resolve(data);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readBounded(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch {
        throw signal.aborted
          ? abortError(signal)
          : new KairomesError("UPLOAD_INTERRUPTED", "圖片上傳中斷，請重新放入圖片。");
      }
      if (signal.aborted) throw abortError(signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > LIMITS.artifactBytes) {
        await reader.cancel().catch(() => {});
        throw new KairomesError("ARTIFACT_TOO_LARGE", "圖片超過 25 MiB 匯入上限。");
      }
      chunks.push(Buffer.from(next.value));
    }
    if (bytes === 0) throw new KairomesError("INVALID_IMAGE", "沒有收到圖片內容。");
    return Buffer.concat(chunks, bytes);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/**
 * Image imports into mounted workspaces. A host file parameter is downloaded asynchronously
 * after the request identity is reserved; without one, the import waits for the local user to
 * provide the image in the trusted side panel. Verified bytes stay in memory until the local
 * user approves that exact content in the paired Extension, then a create-only write runs.
 * Approve also needs the approving panel to have read those bytes through content() first, so
 * no image is written without having been delivered to the panel that reviews it. Autonomy
 * grants are never consulted: every import is approved individually.
 */
export class ArtifactImportManager {
  private readonly engine: WorkspaceArtifactImports;
  private readonly jobs = new Map<string, Job>();
  /**
   * Request identities, kept after their import leaves `jobs` so a request_id never silently
   * runs twice. `settled` is set when the import finishes; only tombstones of imports that
   * wrote nothing may be pruned, and only at the identity limit after tombstoneMs.
   */
  private readonly requests = new Map<
    string,
    {
      identity: string;
      id: string;
      origin: Origin;
      settled?: { at: number; outcome: ArtifactImport["write_outcome"] };
    }
  >();
  private readonly reserving = new Map<string, { identity: string; promise: Promise<Job> }>();
  private readonly counts: ImageImportHydration = { hydrated: 0, omitted: 0, rejected: 0 };
  private closed = false;
  private sweep?: ReturnType<typeof setInterval>;

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly changed: (
      value: ArtifactImport,
      source: ActivitySource,
      artifact?: Artifact,
    ) => void = () => {},
    private readonly download: ArtifactDownload = downloadOpenAIFile,
    private readonly now = Date.now,
    private readonly diagnosticsChanged: () => void = () => {},
  ) {
    this.engine = new WorkspaceArtifactImports(registry);
  }

  private notify(job: Job) {
    this.changed(structuredClone(job.view), job.source, job.view.artifact ?? undefined);
  }

  private get(id: string) {
    const job = this.jobs.get(id);
    if (!job)
      throw new KairomesError(
        "ARTIFACT_IMPORT_NOT_FOUND",
        "這筆圖片匯入已不在保留清單內；請檢查目的檔案，不要直接重送未知結果。",
      );
    return job;
  }

  /** Counts of how image_import_request received its file, for trusted diagnostics only. */
  hydration(): ImageImportHydration {
    return { ...this.counts };
  }

  /** MCP and local tool route. The file reference is checked before anything is reserved. */
  async request(raw: unknown, source: ActivitySource = "local-ui"): Promise<ImageImportResult> {
    const input = ImageImportInputs.image_import_request.parse(raw);
    if (input.file) {
      try {
        checkFileReference(input.file);
      } catch (error) {
        this.counts.rejected++;
        this.diagnosticsChanged();
        throw error;
      }
      this.counts.hydrated++;
    } else this.counts.omitted++;
    this.diagnosticsChanged();
    const identity = hash({
      origin: "tool",
      workspace_id: input.workspace_id,
      path: input.path,
      summary: input.summary,
      file_id: input.file?.file_id ?? null,
    });
    const job = await this.reserveOnce(input.request_id, identity, input.file?.download_url, () =>
      this.reserve({
        key: input.request_id,
        origin: "tool",
        identity,
        requestId: input.request_id,
        workspaceId: input.workspace_id,
        path: input.path,
        summary: input.summary,
        source,
        reference: input.file,
      }),
    );
    return this.result(job);
  }

  /** Trusted panel route: a user-initiated import that waits for the user's own image. */
  async createLocal(raw: unknown): Promise<ArtifactImportApproval> {
    const input = PanelImportCreateSchema.parse(raw);
    const key = `panel:${input.request_id}`;
    const identity = hash({
      origin: "panel",
      workspace_id: input.workspace_id,
      path: input.path,
      summary: input.summary ?? null,
    });
    const job = await this.reserveOnce(key, identity, undefined, () =>
      this.reserve({
        key,
        origin: "panel",
        identity,
        requestId: input.request_id,
        workspaceId: input.workspace_id,
        path: input.path,
        summary: input.summary ?? "從側欄匯入的圖片",
        source: "local-panel",
      }),
    );
    return this.approval(job);
  }

  /**
   * One import per request key. A retry or a concurrent duplicate with the same logical input
   * returns the same import and never starts a second download; a different input reusing the
   * key is refused. A duplicate host call may add one more URL for the same file, which is
   * tried only if the first download fails.
   */
  private async reserveOnce(
    key: string,
    identity: string,
    url: string | undefined,
    create: () => Promise<Job>,
  ) {
    const reused = () =>
      new KairomesError(
        "REQUEST_ID_REUSED",
        "同一個 request_id 已用於另一個圖片匯入（工作區、路徑、說明或檔案不同）。",
      );
    const known = this.requests.get(key);
    if (known) {
      if (known.identity !== identity) throw reused();
      const job = this.get(known.id);
      this.offerUrl(job, url);
      return job;
    }
    const inFlight = this.reserving.get(key);
    if (inFlight) {
      if (inFlight.identity !== identity) throw reused();
      const job = await inFlight.promise;
      this.offerUrl(job, url);
      return job;
    }
    const promise = create();
    this.reserving.set(key, { identity, promise });
    try {
      return await promise;
    } finally {
      if (this.reserving.get(key)?.promise === promise) this.reserving.delete(key);
    }
  }

  private offerUrl(job: Job, url: string | undefined) {
    if (
      url &&
      job.view.state === "preparing" &&
      job.delivery === "host_file" &&
      !job.urls.includes(url) &&
      job.urls.length < limits.urls
    )
      job.urls.push(url);
  }

  private active() {
    return [...this.jobs.values()].filter((job) => artifactImportActive(job.view));
  }

  /** Bytes in memory stay bounded; host downloads leave one slot for the user's own image. */
  private ensureHolding(hostFile: boolean) {
    const holding = this.active().filter((job) => holdingStates.has(job.view.state));
    if (
      hostFile &&
      holding.filter((job) => job.delivery === "host_file").length >= limits.hostHolding
    )
      throw limitError(
        `最多同時下載或等待核准 ${limits.hostHolding} 張 ChatGPT 圖片；請先處理側欄中的匯入。`,
      );
    if (holding.length >= limits.holding)
      throw limitError(`最多同時準備或等待核准 ${limits.holding} 張圖片；請先處理側欄中的匯入。`);
  }

  /**
   * Request identities are bounded per origin, so tool calls can never use up the side panel's
   * budget. At the limit, tombstones of imports that finished without writing are dropped
   * once older than tombstoneMs; applied and unknown results keep theirs until restart.
   */
  private ensureRequestBudget(origin: Origin) {
    const max = origin === "panel" ? limits.panelRequests : limits.toolRequests;
    const used = () => {
      let count = 0;
      for (const record of this.requests.values()) if (record.origin === origin) count++;
      return count;
    };
    if (used() < max) return;
    const now = this.now();
    for (const [key, record] of this.requests)
      if (
        record.origin === origin &&
        record.settled?.outcome === "not_written" &&
        now - record.settled.at >= limits.tombstoneMs
      )
        this.requests.delete(key);
    if (used() >= max)
      throw limitError(
        origin === "panel"
          ? "側欄開始的圖片匯入數量已達上限，請稍後再試或重新啟動工作台。"
          : "最近的圖片匯入請求過多，請稍後再試。",
      );
  }

  private async reserve(spec: {
    key: string;
    origin: Origin;
    identity: string;
    requestId: string;
    workspaceId: string;
    path: string;
    summary: string;
    source: ActivitySource;
    reference?: OpenAIFileReference;
  }): Promise<Job> {
    if (this.closed) throw closedError();
    // Local checks only: path rules, existing parent folder, no existing target.
    await this.engine.validateDestination(spec.workspaceId, spec.path);
    if (this.closed) throw closedError();
    const unfinished = spec.origin === "panel" ? limits.panelUnfinished : limits.toolUnfinished;
    if (this.active().filter((job) => job.origin === spec.origin).length >= unfinished)
      throw limitError(`最多同時保留 ${unfinished} 筆未完成的圖片匯入；請先處理側欄中的匯入。`);
    if (spec.reference) this.ensureHolding(true);
    this.ensureRequestBudget(spec.origin);
    while (this.jobs.size >= limits.retained) {
      // The oldest finished import goes first, but never the only record of an unknown write.
      const retired = [...this.jobs.values()].find(
        (job) => !artifactImportActive(job.view) && job.view.write_outcome !== "unknown",
      );
      if (!retired) throw limitError("圖片匯入仍在處理或結果待確認；請先在側欄處理後再試。");
      this.release(retired);
      this.jobs.delete(retired.view.id);
    }

    const createdAt = this.now();
    const id = crypto.randomUUID();
    const reference = spec.reference;
    const view: ArtifactImport = {
      id,
      request_id: spec.requestId,
      workspace_id: spec.workspaceId,
      path: spec.path,
      summary: spec.summary,
      source_file_id: reference?.file_id ?? null,
      source_file_name: displayText(reference?.file_name, 255),
      claimed_mime_type: mimeText(reference?.mime_type),
      mime_type: null,
      byte_size: null,
      width: null,
      height: null,
      version: null,
      state: reference ? "preparing" : "awaiting_file",
      write_outcome: "not_written",
      created_at: createdAt,
      applied_at: null,
      expires_at: createdAt + (reference ? limits.preparingMs : limits.awaitingMs),
      error_code: null,
      message: null,
      artifact: null,
    };
    const job: Job = {
      view,
      source: spec.source,
      origin: spec.origin,
      key: spec.key,
      delivery: reference ? "host_file" : "user_supplied",
      identity: spec.identity,
      fingerprint: hash({ id, identity: spec.identity, phase: "waiting" }),
      reviewed: new Set(),
      urls: reference ? [reference.download_url] : [],
      uploadId: null,
      released: false,
    };
    this.jobs.set(id, job);
    this.requests.set(spec.key, { identity: spec.identity, id, origin: spec.origin });
    this.notify(job);
    this.sweep ??= setInterval(() => this.maintain(), 250);
    this.sweep.unref?.();
    if (reference) this.startDownload(job, reference);
    return job;
  }

  private startDownload(job: Job, reference: OpenAIFileReference) {
    const abort = new AbortController();
    job.abort = abort;
    job.task = (async () => {
      let data: Uint8Array | undefined;
      try {
        let failure: unknown;
        // job.urls can grow while the first download runs; the next URL is tried only after a
        // plain download failure, never in parallel.
        for (let index = 0; index < job.urls.length && !data; index++) {
          const url = job.urls[index] as string;
          try {
            data = await unlessAborted(
              this.download({ ...reference, download_url: url }, { signal: abort.signal }),
              abort.signal,
            );
          } catch (error) {
            failure = error;
            if (
              abort.signal.aborted ||
              !(error instanceof KairomesError && error.code === "FILE_DOWNLOAD_FAILED")
            )
              break;
          }
        }
        if (!data) throw failure;
        await this.accept(job, data, abort.signal);
      } catch (error) {
        if (job.view.state === "preparing" && job.abort === abort) {
          const detail = publicError(error);
          job.view.error_code = detail.code;
          job.view.message = boundedMessage(detail.message);
          this.finish(job, "failed");
        }
      } finally {
        data?.fill(0);
        if (job.abort === abort) job.abort = undefined;
        job.urls = [];
      }
    })();
  }

  /** Verifies bytes for a preparing import and moves it to pending; false if it was cancelled. */
  private async accept(job: Job, data: Uint8Array, signal: AbortSignal) {
    const prepared = await this.engine.prepare(job.view.workspace_id, job.view.path, data);
    if (signal.aborted || job.view.state !== "preparing" || this.closed) {
      prepared.data.fill(0);
      return false;
    }
    job.prepared = prepared;
    job.reviewed.clear();
    job.view.mime_type = prepared.mimeType;
    job.view.byte_size = prepared.data.byteLength;
    job.view.width = prepared.width;
    job.view.height = prepared.height;
    job.view.version = prepared.version;
    job.view.error_code = null;
    job.view.message = null;
    job.view.state = "pending";
    job.view.expires_at = this.now() + limits.pendingMs;
    job.fingerprint = hash({
      id: job.view.id,
      identity: job.identity,
      workspace_id: job.view.workspace_id,
      path: job.view.path,
      version: prepared.version,
      byte_size: prepared.data.byteLength,
    });
    this.notify(job);
    return true;
  }

  /**
   * Trusted panel upload for an awaiting_file import. The body is counted while it streams and
   * stops at 25 MiB. The same upload ID returns the first attempt's result instead of reading
   * new bytes, so an uncertain retry can never produce a second, different pending image. A
   * rejected image returns the import to awaiting_file so the user can choose another one.
   * Receiving gets its own preparingMs deadline, so an upload that starts just before the
   * awaiting deadline is not expired while its body streams.
   */
  async upload(
    id: string,
    input: {
      uploadId: string;
      contentType: string;
      body: ReadableStream<Uint8Array> | null;
      declaredBytes?: number;
      /** Re-checked after the body arrived, so a revoked pairing cannot finish an upload. */
      authorized: () => boolean;
    },
  ): Promise<ArtifactImportApproval> {
    const job = this.get(id);
    if (job.uploadId === input.uploadId) {
      if (job.uploadError) throw new KairomesError(job.uploadError.code, job.uploadError.message);
      return this.approval(job);
    }
    if (job.view.state !== "awaiting_file")
      throw new KairomesError(
        "IMPORT_NOT_AWAITING_FILE",
        "這筆匯入目前不等待圖片；請更新側欄狀態。",
      );
    if (this.now() >= job.view.expires_at) {
      this.finish(job, "expired");
      throw new KairomesError("IMPORT_EXPIRED", "這筆圖片匯入已到期。");
    }
    if (!(IMAGE_IMPORT_UPLOAD_TYPES as readonly string[]).includes(input.contentType))
      throw new KairomesError("UNSUPPORTED_MEDIA_TYPE", "只接受 PNG、JPEG 或 WebP 圖片。");
    if (input.declaredBytes !== undefined && !(input.declaredBytes <= LIMITS.artifactBytes))
      throw new KairomesError("ARTIFACT_TOO_LARGE", "圖片超過 25 MiB 匯入上限。");
    if (!input.body) throw new KairomesError("INVALID_IMAGE", "沒有收到圖片內容。");
    this.ensureHolding(false);

    const abort = new AbortController();
    job.abort = abort;
    job.uploadId = input.uploadId;
    job.uploadError = undefined;
    job.view.state = "preparing";
    job.receiveBy = this.now() + limits.preparingMs;
    job.view.expires_at = Math.max(job.view.expires_at, job.receiveBy);
    job.view.error_code = null;
    job.view.message = null;
    this.notify(job);
    let data: Buffer | undefined;
    try {
      data = await readBounded(input.body, abort.signal);
      if (!input.authorized()) throw new KairomesError("PANEL_UNAUTHORIZED", "側欄配對已失效。");
      if (!(await this.accept(job, data, abort.signal))) throw abortError(abort.signal);
      return this.approval(job);
    } catch (error) {
      const detail = publicError(error);
      job.uploadError = detail;
      if (job.view.state === "preparing" && job.abort === abort) {
        job.view.state = "awaiting_file";
        job.view.error_code = detail.code;
        job.view.message = boundedMessage(detail.message);
        this.notify(job);
      }
      throw new KairomesError(detail.code, detail.message);
    } finally {
      data?.fill(0);
      if (job.abort === abort) job.abort = undefined;
    }
  }

  /**
   * Verified pending bytes for the trusted preview; a copy, so release cannot race it.
   * `reviewer` is the paired panel token of the request: reading the bytes is what lets that
   * panel, and only that panel, approve this version.
   */
  content(id: string, reviewer: string) {
    const job = this.get(id);
    if (
      (job.view.state !== "pending" && job.view.state !== "applying") ||
      !job.prepared ||
      job.released
    )
      throw new KairomesError("ARTIFACT_IMPORT_NOT_FOUND", "沒有可預覽的待審圖片。");
    if (reviewer) job.reviewed.add(reviewerKey(reviewer));
    return {
      data: Buffer.from(job.prepared.data),
      mimeType: job.prepared.mimeType,
      version: job.prepared.version,
      path: job.view.path,
    };
  }

  /** Workbench activity view: the trusted panel alone sees the host file ID. */
  list() {
    return [...this.jobs.values()].map((job) => ({
      ...structuredClone(job.view),
      source_file_id: null,
    }));
  }

  private approval(job: Job): ArtifactImportApproval {
    return {
      ...structuredClone(job.view),
      fingerprint: job.fingerprint,
      workspace_name:
        this.registry.list().find((workspace) => workspace.id === job.view.workspace_id)?.name ??
        "已解除掛載",
      delivery: job.delivery,
      sha256_short: job.view.version?.slice(0, 12) ?? null,
      upload_id: job.uploadId,
    };
  }

  approvals(): ArtifactImportApproval[] {
    return [...this.jobs.values()].map((job) => this.approval(job));
  }

  /**
   * Administrative method for the paired Extension (approve, deny) and the admin channel (deny
   * only). Approve needs `pending`, the fingerprint of the verified content and `reviewer`: the
   * panel token of a panel that read these exact bytes through content(). A waiting slot's
   * fingerprint can only deny. An identical retry after a lost response is refused with
   * APPROVAL_MISMATCH and never writes twice; the snapshot is the authoritative result.
   */
  async decide(
    id: string,
    fingerprint: string,
    approve: boolean,
    reason?: string,
    reviewer?: string,
  ) {
    const denial = denialReason(approve, reason);
    const job = this.get(id);
    const decidable = approve
      ? job.view.state === "pending" && Boolean(job.prepared) && !job.released
      : ["awaiting_file", "preparing", "pending"].includes(job.view.state);
    if (!decidable || job.applying || fingerprint !== job.fingerprint)
      throw new KairomesError("APPROVAL_MISMATCH", "圖片匯入已處理或審閱內容不一致，請更新狀態。");
    if (job.view.state !== "preparing" && this.now() >= job.view.expires_at) {
      this.finish(job, "expired");
      throw new KairomesError("APPROVAL_EXPIRED", "圖片匯入請求已到期。");
    }
    if (!approve) {
      if (denial) job.view.denial_reason = denial;
      this.finish(job, "denied");
      return;
    }
    if (!reviewer || !job.reviewed.has(reviewerKey(reviewer)))
      throw new KairomesError(
        "IMPORT_PREVIEW_REQUIRED",
        "核准前須先在這個側欄載入並核對這張圖片的預覽。",
      );

    const prepared = job.prepared as PreparedArtifactImport;
    job.view.state = "applying";
    job.view.write_outcome = "unknown";
    this.notify(job);
    job.applying = (async () => {
      try {
        const artifact = await this.engine.apply(prepared);
        job.view.artifact = artifact;
        job.view.applied_at = this.now();
        job.view.write_outcome = "written_verified";
        this.finish(job, "applied");
      } catch (error) {
        const detail = publicError(error);
        const outcome = error instanceof ArtifactImportWriteError ? error.outcome : "unknown";
        job.view.write_outcome = outcome;
        job.view.error_code = detail.code;
        job.view.message = boundedMessage(detail.message);
        this.finish(
          job,
          outcome === "not_written" && conflictCodes.has(detail.code) ? "conflict" : "failed",
        );
      }
    })();
    await job.applying;
  }

  private release(job: Job, reason: KairomesError = stopError("cancelled")) {
    job.abort?.abort(reason);
    job.urls = [];
    if (job.released) return;
    job.prepared?.data.fill(0);
    job.reviewed.clear();
    job.released = true;
  }

  private finish(job: Job, state: ArtifactImportState) {
    job.view.state = state;
    if (!artifactImportActive(job.view)) {
      this.release(job, stopError(state));
      const record = this.requests.get(job.key);
      if (record?.id === job.view.id)
        record.settled = { at: this.now(), outcome: job.view.write_outcome };
    }
    this.notify(job);
  }

  private result(job: Job): ImageImportResult {
    return {
      kind: "image_import",
      image_import: publicView(job.view),
      guidance: guidance(job.view),
    };
  }

  poll(id: string) {
    return this.result(this.get(id));
  }

  /** Cancels a waiting, preparing or pending import; applying and finished ones are unchanged. */
  cancel(id: string) {
    const job = this.get(id);
    if (["awaiting_file", "preparing", "pending"].includes(job.view.state))
      this.finish(job, "cancelled");
    return this.result(job);
  }

  maintain() {
    const now = this.now();
    for (const job of this.jobs.values()) {
      const state = job.view.state;
      if (state !== "awaiting_file" && state !== "preparing" && state !== "pending") continue;
      try {
        this.registry.get(job.view.workspace_id);
      } catch {
        this.finish(job, "cancelled");
        continue;
      }
      if (state === "preparing" && job.delivery === "user_supplied" && job.abort) {
        // A panel upload has its own deadline, so the awaiting deadline never cuts it off. A
        // stalled one is aborted, and upload() returns the import to awaiting_file.
        if (now >= (job.receiveBy ?? job.view.expires_at))
          job.abort.abort(new KairomesError("UPLOAD_TIMEOUT", "接收圖片逾時，請重新放入圖片。"));
        continue;
      }
      if (now < job.view.expires_at) continue;
      if (state === "preparing" && job.delivery === "host_file") {
        job.view.error_code = "FILE_DOWNLOAD_TIMEOUT";
        job.view.message = "接收 ChatGPT 檔案逾時。";
        this.finish(job, "failed");
      } else this.finish(job, "expired");
    }
  }

  cancelWorkspace(workspaceId: string) {
    for (const job of this.jobs.values())
      if (
        job.view.workspace_id === workspaceId &&
        ["awaiting_file", "preparing", "pending"].includes(job.view.state)
      )
        this.finish(job, "cancelled");
  }

  async close() {
    this.closed = true;
    clearInterval(this.sweep);
    for (const job of this.jobs.values())
      if (["awaiting_file", "preparing", "pending"].includes(job.view.state))
        this.finish(job, "cancelled");
    await Promise.all(
      [...this.jobs.values()]
        .flatMap((job) => [job.applying, job.task])
        .filter(Boolean) as Promise<void>[],
    );
    for (const job of this.jobs.values()) this.release(job);
  }
}
