import { checkImageBytes, sha256Hex } from "../apps/extension/src/image-file.ts";
import type { ArtifactImportApproval } from "../packages/protocol/src/artifact-import.ts";
import {
  IMAGE_IMPORT_UPLOAD_ID_HEADER,
  IMAGE_IMPORT_UPLOAD_TYPES,
  PanelImportCreateSchema,
} from "../packages/protocol/src/artifact-import.ts";
import {
  imageMimeForPath,
  imagePathProblem,
  parentFolder,
} from "../packages/protocol/src/image-path.ts";

// Public, memory-only stand-in for the daemon's trusted image routes (create, upload, pending
// preview, decisions). Same status codes and contract as apps/daemon, no files, no network:
// "folders" and "existing" files are a fixed synthetic list. Works on standard Request and
// Response objects, so in-page fixtures and the HTTP preview server can share it.

export interface SyntheticWorkspace {
  id: string;
  name: string;
  /** Existing folders ("" is the project root). */
  folders: readonly string[];
  /** Files that already exist (create-only imports must refuse them). */
  existing: readonly string[];
}

type Job = {
  item: ArtifactImportApproval;
  bytes?: Uint8Array;
  reviewed: boolean;
  uploads: Map<string, Response>;
};

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });
const refuse = (status: number, code: string) => json({ code, message: "合成測試拒絕。" }, status);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fileRoute = /^\/api\/panel\/imports\/([0-9a-f-]{36})\/(file|content)$/;

export const SYNTHETIC_IMPORT_LIMITS = { awaitingMs: 10 * 60_000, pendingMs: 10 * 60_000 } as const;

export function createSyntheticImports(options: {
  workspaces: readonly SyntheticWorkspace[];
  /** Called after any change, so the fixture can push a snapshot frame. */
  changed(): void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const jobs = new Map<string, Job>();
  const requests = new Map<string, { id: string; identity: string }>();
  /** Imports the panel opened itself; the daemon allows two unfinished at a time. */
  const panelIds = new Set<string>();
  const counts = { creates: 0, uploads: 0, contents: 0, approvals: 0 };
  let loseNextUpload = false;
  let holdContent: Promise<void> | undefined;
  let corruptContent = false;
  let forgetReview = false;

  const workspace = (id: string) => options.workspaces.find((item) => item.id === id);
  const fingerprint = async (value: unknown) =>
    sha256Hex(new TextEncoder().encode(JSON.stringify(value)));

  /** Adds an import as the daemon would hold it (model requests and every finished state). */
  async function seed(item: ArtifactImportApproval, bytes?: Uint8Array) {
    jobs.set(item.id, { item, bytes, reviewed: false, uploads: new Map() });
  }

  function list() {
    return [...jobs.values()].map((job) => structuredClone(job.item));
  }

  function targetProblem(workspaceId: string, path: string) {
    const space = workspace(workspaceId);
    if (!space) return "WORKSPACE_NOT_FOUND";
    const problem = imagePathProblem(path);
    if (problem) return problem;
    if (!space.folders.includes(parentFolder(path))) return "PARENT_NOT_FOUND";
    const taken = [...jobs.values()].some(
      (job) =>
        job.item.workspace_id === workspaceId &&
        job.item.path === path &&
        job.item.state === "applied",
    );
    if (space.existing.includes(path) || taken) return "FILE_EXISTS";
    return undefined;
  }

  async function create(request: Request) {
    counts.creates++;
    let input: ReturnType<typeof PanelImportCreateSchema.parse>;
    try {
      input = PanelImportCreateSchema.parse(await request.json());
    } catch {
      return refuse(400, "VALIDATION");
    }
    const identity = JSON.stringify([input.workspace_id, input.path, input.summary ?? null]);
    const known = requests.get(input.request_id);
    if (known) {
      if (known.identity !== identity) return refuse(409, "REQUEST_ID_REUSED");
      const job = jobs.get(known.id);
      return job
        ? json({ ...snapshotPart(), import: structuredClone(job.item) })
        : refuse(404, "ARTIFACT_IMPORT_NOT_FOUND");
    }
    const problem = targetProblem(input.workspace_id, input.path);
    if (problem) return refuse(400, problem);
    const unfinished = [...panelIds].filter((key) =>
      ["awaiting_file", "preparing", "pending", "applying"].includes(
        jobs.get(key)?.item.state ?? "",
      ),
    );
    if (unfinished.length >= 2) return refuse(429, "ARTIFACT_IMPORT_LIMIT");
    const id = crypto.randomUUID();
    const created = now();
    const item: ArtifactImportApproval = {
      id,
      request_id: input.request_id,
      workspace_id: input.workspace_id,
      workspace_name: workspace(input.workspace_id)?.name ?? "已解除掛載",
      path: input.path,
      summary: input.summary ?? "從側欄匯入的圖片",
      source_file_id: null,
      source_file_name: null,
      claimed_mime_type: null,
      mime_type: null,
      byte_size: null,
      width: null,
      height: null,
      version: null,
      sha256_short: null,
      state: "awaiting_file",
      write_outcome: "not_written",
      created_at: created,
      applied_at: null,
      expires_at: created + SYNTHETIC_IMPORT_LIMITS.awaitingMs,
      error_code: null,
      message: null,
      artifact: null,
      fingerprint: await fingerprint([id, identity, "waiting"]),
      delivery: "user_supplied",
      origin: "panel",
      upload_id: null,
    };
    jobs.set(id, { item, reviewed: false, uploads: new Map() });
    requests.set(input.request_id, { id, identity });
    panelIds.add(id);
    options.changed();
    return json({ ...snapshotPart(), import: structuredClone(item) });
  }

  async function upload(id: string, request: Request) {
    counts.uploads++;
    const job = jobs.get(id);
    if (!job) return refuse(404, "ARTIFACT_IMPORT_NOT_FOUND");
    const uploadId = (request.headers.get(IMAGE_IMPORT_UPLOAD_ID_HEADER) ?? "").toLowerCase();
    if (!uuid.test(uploadId)) return refuse(400, "VALIDATION");
    // The same upload ID replays its first answer and reads nothing new.
    const replay = job.uploads.get(uploadId);
    if (replay) return replay.clone();
    if (job.item.state !== "awaiting_file") return refuse(409, "IMPORT_NOT_AWAITING_FILE");
    const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
    if (!(IMAGE_IMPORT_UPLOAD_TYPES as readonly string[]).includes(type))
      return refuse(415, "UNSUPPORTED_MEDIA_TYPE");
    const bytes = new Uint8Array(await request.arrayBuffer());
    // Like the daemon: the attempt's ID is recorded as soon as receiving starts.
    job.item.upload_id = uploadId;
    const answer = async (response: Response) => {
      job.uploads.set(uploadId, response.clone());
      options.changed();
      return response;
    };
    const checked = checkImageBytes(bytes);
    if (!checked.ok) {
      job.item.error_code = checked.code === "EMPTY_IMAGE" ? "INVALID_IMAGE" : checked.code;
      job.item.message = "合成測試拒絕。";
      return answer(refuse(checked.code === "ARTIFACT_TOO_LARGE" ? 413 : 400, job.item.error_code));
    }
    if (imageMimeForPath(job.item.path) !== checked.header.mime) {
      job.item.error_code = "ARTIFACT_EXTENSION_MISMATCH";
      job.item.message = "合成測試拒絕。";
      return answer(refuse(400, "ARTIFACT_EXTENSION_MISMATCH"));
    }
    const version = await sha256Hex(bytes);
    Object.assign(job.item, {
      state: "pending",
      mime_type: checked.header.mime,
      byte_size: bytes.length,
      width: checked.header.width,
      height: checked.header.height,
      version,
      sha256_short: version.slice(0, 12),
      error_code: null,
      message: null,
      expires_at: now() + SYNTHETIC_IMPORT_LIMITS.pendingMs,
      fingerprint: await fingerprint([job.item.id, job.item.path, version, bytes.length]),
    } satisfies Partial<ArtifactImportApproval>);
    job.bytes = bytes;
    job.reviewed = false;
    const response = await answer(json({ ...snapshotPart(), import: structuredClone(job.item) }));
    if (loseNextUpload) {
      loseNextUpload = false;
      // Accepted, but the answer is lost on the way back: the panel must not invent a new ID.
      throw new TypeError("Synthetic upload response lost");
    }
    return response;
  }

  async function content(id: string) {
    counts.contents++;
    const job = jobs.get(id);
    if (!job?.bytes || !["pending", "applying"].includes(job.item.state))
      return refuse(404, "ARTIFACT_IMPORT_NOT_FOUND");
    if (holdContent) await holdContent;
    job.reviewed = true;
    const body = new Uint8Array(job.bytes);
    // A fixture switch for the "bytes do not match" state; the hash check must catch it.
    if (corruptContent) body[body.length - 13] = (body[body.length - 13] ?? 0) ^ 0xff;
    return new Response(body, {
      headers: {
        "content-type": job.item.mime_type ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  /** `POST /api/panel/approvals` for an `import_id`; undefined for any other target. */
  async function decide(body: Record<string, unknown>) {
    if (typeof body.import_id !== "string") return undefined;
    const job = jobs.get(body.import_id);
    if (!job) return refuse(400, "APPROVAL_MISMATCH");
    const { item } = job;
    if (body.action === "stop") {
      if (!["awaiting_file", "preparing", "pending"].includes(item.state))
        return refuse(400, "APPROVAL_MISMATCH");
      item.state = "cancelled";
    } else if (body.action === "deny") {
      if (
        !["awaiting_file", "preparing", "pending"].includes(item.state) ||
        body.fingerprint !== item.fingerprint
      )
        return refuse(400, "APPROVAL_MISMATCH");
      item.state = "denied";
      if (typeof body.reason === "string" && body.reason.trim())
        item.denial_reason = body.reason.trim();
    } else if (body.action === "approve") {
      counts.approvals++;
      if (item.state !== "pending" || body.fingerprint !== item.fingerprint)
        return refuse(400, "APPROVAL_MISMATCH");
      if (forgetReview) {
        // The daemon no longer counts this panel's read (fixture switch): it must read again.
        forgetReview = false;
        job.reviewed = false;
      }
      if (!job.reviewed) return refuse(400, "IMPORT_PREVIEW_REQUIRED");
      const problem = targetProblem(item.workspace_id, item.path);
      if (problem === "FILE_EXISTS" || problem === "PARENT_NOT_FOUND") {
        item.state = "conflict";
        item.error_code = problem;
      } else {
        item.state = "applied";
        item.write_outcome = "written_verified";
        item.applied_at = now();
      }
    } else return refuse(400, "VALIDATION");
    // Every decision ends the import; its pending bytes are released.
    job.bytes = undefined;
    options.changed();
    return json(snapshotPart());
  }

  let snapshotPart: () => object = () => ({});

  return {
    counts,
    seed,
    list,
    decide,
    /** The rest of the snapshot that route responses carry (instance, workspaces, items). */
    setSnapshot(part: () => object) {
      snapshotPart = part;
    },
    loseNextUpload() {
      loseNextUpload = true;
    },
    /** Holds every preview read until `release` runs (the loading state stays visible). */
    holdPreviews() {
      let release = () => {};
      holdContent = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        holdContent = undefined;
        release();
      };
    },
    corruptPreviews(value = true) {
      corruptContent = value;
    },
    /** The next approve finds no preview read by this panel (IMPORT_PREVIEW_REQUIRED). */
    forgetNextReview() {
      forgetReview = true;
    },
    /** Handles the three import routes; null for any other path. */
    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (url.pathname === "/api/panel/imports" && request.method === "POST")
        return create(request);
      const match = fileRoute.exec(url.pathname);
      if (!match) return null;
      const [, id = "", kind] = match;
      if (kind === "file" && request.method === "POST") return upload(id, request);
      if (kind === "content" && request.method === "GET") return content(id);
      return refuse(405, "VALIDATION");
    },
  };
}

export type SyntheticImports = ReturnType<typeof createSyntheticImports>;

/** A finished or waiting import in any state, for screenshots of every row and record. */
export function syntheticImport(
  base: { id: string; workspace: { id: string; name: string }; now: number },
  patch: Partial<ArtifactImportApproval>,
): ArtifactImportApproval {
  return {
    id: base.id,
    request_id: base.id.replace(/^.{8}/, "1e000000"),
    workspace_id: base.workspace.id,
    workspace_name: base.workspace.name,
    path: "design/placeholders/figure-default.png",
    summary: "把剛才產生的示意圖存成專案的預設插圖。",
    source_file_id: null,
    source_file_name: null,
    claimed_mime_type: null,
    mime_type: null,
    byte_size: null,
    width: null,
    height: null,
    version: null,
    sha256_short: null,
    state: "awaiting_file",
    write_outcome: "not_written",
    created_at: base.now - 40_000,
    applied_at: null,
    expires_at: base.now + 9 * 60_000,
    error_code: null,
    message: null,
    artifact: null,
    fingerprint: "f".repeat(64),
    delivery: "user_supplied",
    origin: "tool",
    upload_id: null,
    ...patch,
  };
}
