import { createHash } from "node:crypto";
import {
  type ActivitySource,
  type Artifact,
  type ArtifactImport,
  type ArtifactImportApproval,
  ArtifactImportRequestSchema,
  type ArtifactImportResult,
  artifactImportActive,
  KairomesError,
  publicError,
  type z,
} from "@kairomes/protocol";
import {
  type PreparedArtifactImport,
  WorkspaceArtifactImports,
  type WorkspaceRegistry,
} from "@kairomes/workspace-core";
import { downloadOpenAIFile } from "./openai-file-download.ts";

type Input = z.infer<typeof ArtifactImportRequestSchema>;
export type ArtifactDownload = typeof downloadOpenAIFile;
type Job = {
  view: ArtifactImport;
  source: ActivitySource;
  inputHash: string;
  fingerprint: string;
  prepared: PreparedArtifactImport;
  applying?: Promise<void>;
  released: boolean;
};

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const limits = { active: 2, retained: 24, requests: 4096, pending: 5 * 60_000 };
const conflictCodes = new Set([
  "FILE_EXISTS",
  "WORKSPACE_CHANGED",
  "OUTSIDE_WORKSPACE",
  "IMPORT_CHANGED",
]);

function stableInput(input: Input) {
  return {
    workspace_id: input.workspace_id,
    request_id: input.request_id,
    path: input.path,
    summary: input.summary,
    file: {
      file_id: input.file.file_id,
      mime_type: input.file.mime_type ?? null,
      file_name: input.file.file_name ?? null,
    },
  };
}

function displayName(value?: string) {
  if (
    !value ||
    /[\\/]/u.test(value) ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 || (code >= 0x202a && code <= 0x202e);
    })
  )
    return null;
  return value.normalize("NFC");
}

function normalizedMime(value?: string) {
  const mime = value?.split(";", 1)[0]?.trim().toLocaleLowerCase();
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

/**
 * Downloads a ChatGPT-injected, short-lived file once, then keeps only verified
 * bytes in memory until the trusted local user approves a create-only write.
 */
export class ArtifactImportManager {
  private readonly engine: WorkspaceArtifactImports;
  private readonly jobs = new Map<string, Job>();
  private readonly requests = new Map<string, { hash: string; id: string }>();
  private readonly inFlight = new Map<
    string,
    { hash: string; promise: Promise<ArtifactImportResult> }
  >();
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
        "這筆媒體匯入已不在保留清單內；請先列出目前狀態，不要直接重送未知結果。",
      );
    return job;
  }

  private replay(input: Input, inputHash: string) {
    const previous = this.requests.get(input.request_id);
    if (!previous) return;
    if (previous.hash !== inputHash)
      throw new KairomesError(
        "ARTIFACT_IMPORT_REQUEST_CONFLICT",
        "同一 request_id 不能用於不同的媒體匯入。",
      );
    return this.get(previous.id);
  }

  async request(raw: Input, source: ActivitySource = "local-ui") {
    const input = ArtifactImportRequestSchema.parse(raw);
    const inputHash = hash(stableInput(input));
    const prior = this.replay(input, inputHash);
    if (prior) return this.result(prior);
    const current = this.inFlight.get(input.request_id);
    if (current) {
      if (current.hash !== inputHash)
        throw new KairomesError(
          "ARTIFACT_IMPORT_REQUEST_CONFLICT",
          "同一 request_id 不能用於不同的媒體匯入。",
        );
      return current.promise;
    }
    if (this.closed) throw new KairomesError("ARTIFACT_IMPORT_CLOSED", "媒體匯入服務已關閉。");
    if (this.inFlight.size >= limits.active)
      throw new KairomesError("ARTIFACT_IMPORT_LIMIT", "最多同時準備 2 筆媒體匯入。");
    const promise = this.create(input, inputHash, source);
    this.inFlight.set(input.request_id, { hash: inputHash, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(input.request_id)?.promise === promise)
        this.inFlight.delete(input.request_id);
    }
  }

  private async create(input: Input, inputHash: string, source: ActivitySource) {
    await this.engine.validateDestination(input.workspace_id, input.path);
    const data = await this.download(input.file);
    const prepared = await this.engine.prepare(input.workspace_id, input.path, data);
    const claimed = normalizedMime(input.file.mime_type);
    if (claimed?.startsWith("image/") && claimed !== prepared.mimeType) {
      prepared.data.fill(0);
      throw new KairomesError(
        "ARTIFACT_MIME_MISMATCH",
        `ChatGPT 宣告 ${claimed}，但檔案實際格式是 ${prepared.mimeType}。`,
      );
    }
    const raced = this.replay(input, inputHash);
    if (raced) {
      prepared.data.fill(0);
      return this.result(raced);
    }
    if (this.closed) {
      prepared.data.fill(0);
      throw new KairomesError("ARTIFACT_IMPORT_CLOSED", "媒體匯入服務已關閉。");
    }
    if (
      [...this.jobs.values()].filter((job) => artifactImportActive(job.view)).length >=
      limits.active
    ) {
      prepared.data.fill(0);
      throw new KairomesError("ARTIFACT_IMPORT_LIMIT", "最多同時保留 2 筆等待或寫入中的媒體匯入。");
    }
    if (this.requests.size >= limits.requests) {
      prepared.data.fill(0);
      throw new KairomesError(
        "ARTIFACT_IMPORT_LIMIT",
        "本次服務的媒體匯入數量已達上限，請重新啟動工作台。",
      );
    }
    while (this.jobs.size >= limits.retained) {
      const retired = [...this.jobs.values()].find((job) => !artifactImportActive(job.view));
      if (!retired) {
        prepared.data.fill(0);
        throw new KairomesError("ARTIFACT_IMPORT_LIMIT", "媒體匯入仍在清理，請稍後再試。");
      }
      this.release(retired);
      this.jobs.delete(retired.view.id);
    }

    const createdAt = this.now();
    const view: ArtifactImport = {
      id: crypto.randomUUID(),
      request_id: input.request_id,
      workspace_id: input.workspace_id,
      path: input.path,
      summary: input.summary,
      source_file_id: input.file.file_id,
      source_file_name: displayName(input.file.file_name),
      claimed_mime_type: input.file.mime_type ?? null,
      mime_type: prepared.mimeType,
      byte_size: prepared.data.byteLength,
      width: prepared.width,
      height: prepared.height,
      version: prepared.version,
      state: "pending",
      created_at: createdAt,
      applied_at: null,
      expires_at: createdAt + limits.pending,
      message: null,
      artifact: null,
    };
    const fingerprint = hash({ id: view.id, inputHash, version: view.version, path: view.path });
    const job: Job = {
      view,
      source,
      inputHash,
      fingerprint,
      prepared,
      released: false,
    };
    this.jobs.set(view.id, job);
    this.requests.set(input.request_id, { hash: inputHash, id: view.id });
    this.notify(job);
    this.sweep ??= setInterval(() => this.maintain(), 250);
    this.sweep.unref();
    return this.result(job);
  }

  list() {
    return [...this.jobs.values()].map((job) => structuredClone(job.view));
  }

  approvals(): ArtifactImportApproval[] {
    return [...this.jobs.values()].map((job) => ({
      ...structuredClone(job.view),
      fingerprint: job.fingerprint,
      workspace_name:
        this.registry.list().find((workspace) => workspace.id === job.view.workspace_id)?.name ??
        "已解除掛載",
    }));
  }

  /** Administrative method. Only the trusted Extension or local approval page calls it. */
  async decide(id: string, fingerprint: string, approve: boolean) {
    const job = this.get(id);
    if (job.view.state !== "pending" || job.applying || fingerprint !== job.fingerprint)
      throw new KairomesError("APPROVAL_MISMATCH", "媒體匯入已處理或審批內容不一致，請更新狀態。");
    if (this.now() >= job.view.expires_at) {
      this.finish(job, "expired");
      throw new KairomesError("APPROVAL_EXPIRED", "媒體匯入請求已過期。");
    }
    if (!approve) {
      this.finish(job, "denied");
      return;
    }

    job.view.state = "applying";
    this.notify(job);
    job.applying = (async () => {
      try {
        const artifact = await this.engine.apply(job.prepared);
        job.view.artifact = artifact;
        job.view.applied_at = this.now();
        this.finish(job, "applied");
      } catch (error) {
        const detail = publicError(error);
        job.view.message = detail.message;
        this.finish(job, conflictCodes.has(detail.code) ? "conflict" : "failed");
      }
    })();
    await job.applying;
  }

  private release(job: Job) {
    if (job.released) return;
    job.prepared.data.fill(0);
    job.released = true;
  }

  private finish(job: Job, state: ArtifactImport["state"]) {
    job.view.state = state;
    if (!artifactImportActive(job.view)) this.release(job);
    this.notify(job);
  }

  private result(job: Job): ArtifactImportResult {
    return { kind: "artifact_import", artifact_import: structuredClone(job.view) };
  }

  poll(id: string) {
    return this.result(this.get(id));
  }

  cancel(id: string) {
    const job = this.get(id);
    if (job.view.state === "pending") this.finish(job, "cancelled");
    return this.result(job);
  }

  maintain() {
    for (const job of this.jobs.values()) {
      if (job.view.state !== "pending") continue;
      if (this.now() >= job.view.expires_at) {
        this.finish(job, "expired");
        continue;
      }
      try {
        this.registry.get(job.view.workspace_id);
      } catch {
        this.finish(job, "cancelled");
      }
    }
  }

  cancelWorkspace(workspaceId: string) {
    for (const job of this.jobs.values())
      if (job.view.workspace_id === workspaceId && job.view.state === "pending")
        this.finish(job, "cancelled");
  }

  async close() {
    this.closed = true;
    clearInterval(this.sweep);
    for (const job of this.jobs.values())
      if (job.view.state === "pending") this.finish(job, "cancelled");
    await Promise.all(
      [...this.jobs.values()].map((job) => job.applying).filter(Boolean) as Promise<void>[],
    );
    for (const job of this.jobs.values()) this.release(job);
  }
}
