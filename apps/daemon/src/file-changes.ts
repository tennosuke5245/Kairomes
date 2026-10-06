import { createHash } from "node:crypto";
import {
  type AccessGrant,
  type ActivitySource,
  type FileChange,
  type FileChangeApproval,
  FileChangeInputs,
  type FileChangeResult,
  fileChangeActive,
  KairomesError,
  LIMITS,
  publicError,
  type z,
} from "@kairomes/protocol";
import {
  type PreparedWorkspaceChange,
  WorkspaceChanges,
  type WorkspaceRegistry,
} from "@kairomes/workspace-core";
import { denialReason } from "./approval-decision.ts";

type Input = z.infer<typeof FileChangeInputs.file_change_request>;
type Job = {
  view: FileChange;
  source: ActivitySource;
  inputHash: string;
  fingerprint: string;
  prepared: PreparedWorkspaceChange;
  grantId?: string;
  applying?: Promise<void>;
};

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const limits = { active: 4, retained: 24, requests: 4096, pending: 5 * 60_000 };
const conflictCodes = new Set([
  "VERSION_CONFLICT",
  "FILE_CHANGED",
  "FILE_EXISTS",
  "WORKSPACE_CHANGED",
  "OUTSIDE_WORKSPACE",
]);

function boundedDiff(value: string) {
  if (Buffer.byteLength(value) <= LIMITS.responseBytes) return { text: value, truncated: false };
  let text = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > LIMITS.responseBytes) break;
    text += character;
    bytes += size;
  }
  return { text, truncated: true };
}

/**
 * Keeps model-requested file changes separate from the trusted approval path.
 * The model receives an opaque change ID; only the local Extension/admin UI can
 * present the fingerprint and call decide().
 */
export class FileChangeManager {
  private readonly engine: WorkspaceChanges;
  private readonly jobs = new Map<string, Job>();
  // Tombstones prevent an uncertain retry from applying the same logical change twice.
  private readonly requests = new Map<string, { hash: string; id: string }>();
  private closed = false;
  private sweep?: ReturnType<typeof setInterval>;

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly access: (workspaceId: string) => AccessGrant | undefined,
    private readonly changed: (change: FileChange, source: ActivitySource) => void = () => {},
    private readonly now = Date.now,
  ) {
    this.engine = new WorkspaceChanges(registry);
  }

  private notify(job: Job) {
    this.changed(structuredClone(job.view), job.source);
  }

  private get(id: string) {
    const job = this.jobs.get(id);
    if (!job)
      throw new KairomesError(
        "FILE_CHANGE_NOT_FOUND",
        "這批檔案變更已不在保留清單內；請先重新讀取目前檔案，不要直接重送未知結果。",
      );
    return job;
  }

  private replay(input: Input, inputHash: string) {
    const previous = this.requests.get(input.request_id);
    if (!previous) return;
    if (previous.hash !== inputHash)
      throw new KairomesError(
        "FILE_CHANGE_REQUEST_CONFLICT",
        "同一 request_id 不能用於不同的檔案變更。",
      );
    return this.get(previous.id);
  }

  async request(raw: Input, source: ActivitySource = "local-ui"): Promise<FileChangeResult> {
    const input = FileChangeInputs.file_change_request.parse(raw);
    const inputHash = hash(input);
    const prior = this.replay(input, inputHash);
    if (prior) return this.result(prior);
    if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024)
      throw new KairomesError("FILE_CHANGE_SIZE", "單批檔案變更請求不能超過 256 KiB。");

    const prepared = await this.engine.prepare(input.workspace_id, input.changes);
    const raced = this.replay(input, inputHash);
    if (raced) return this.result(raced);
    if (this.closed) throw new KairomesError("FILE_CHANGE_CLOSED", "檔案變更服務已關閉。");
    if ([...this.jobs.values()].filter((job) => fileChangeActive(job.view)).length >= limits.active)
      throw new KairomesError("FILE_CHANGE_LIMIT", "最多同時保留 4 批等待或套用中的檔案變更。");
    if (this.requests.size >= limits.requests)
      throw new KairomesError(
        "FILE_CHANGE_LIMIT",
        "本次服務的檔案變更數量已達上限，請重新啟動工作台。",
      );
    while (this.jobs.size >= limits.retained) {
      const retired = [...this.jobs.values()].find((job) => !fileChangeActive(job.view));
      if (!retired) throw new KairomesError("FILE_CHANGE_LIMIT", "檔案變更仍在清理，請稍後再試。");
      this.jobs.delete(retired.view.id);
    }

    const createdAt = this.now();
    const view: FileChange = {
      id: crypto.randomUUID(),
      request_id: input.request_id,
      workspace_id: input.workspace_id,
      summary: input.summary,
      state: "pending",
      created_at: createdAt,
      applied_at: null,
      expires_at: createdAt + limits.pending,
      message: null,
      files: prepared.files.map((file) => ({
        operation: file.operation,
        path: file.path,
        before_version: file.beforeVersion,
        after_version: file.afterVersion,
      })),
    };
    const fingerprint = hash({
      id: view.id,
      inputHash,
      files: view.files,
      diff: prepared.diff,
      diffTruncated: prepared.diffTruncated,
    });
    const job: Job = { view, source, inputHash, fingerprint, prepared };
    this.jobs.set(view.id, job);
    this.requests.set(input.request_id, { hash: inputHash, id: view.id });
    this.notify(job);
    this.sweep ??= setInterval(() => void this.maintain(), 250);
    this.sweep.unref();

    const grant = this.access(input.workspace_id);
    if (grant) {
      job.grantId = grant.id;
      await this.decide(view.id, fingerprint, true);
    }
    return this.result(job);
  }

  list(): FileChange[] {
    return [...this.jobs.values()].map((job) => structuredClone(job.view));
  }

  /**
   * Trusted review data. Only pending and applying changes (at most four) carry their review
   * diff; finished ones keep metadata only, so up to 24 retained diffs of 192 KiB each can
   * never push a panel snapshot past the 2 MiB stream frame limit.
   */
  approvals(): FileChangeApproval[] {
    return [...this.jobs.values()].map((job) => {
      const available = fileChangeActive(job.view);
      return {
        ...structuredClone(job.view),
        fingerprint: job.fingerprint,
        workspace_name:
          this.registry.list().find((workspace) => workspace.id === job.view.workspace_id)?.name ??
          "已解除掛載",
        diff: available ? job.prepared.diff : "",
        diff_truncated: job.prepared.diffTruncated,
        diff_available: available,
      };
    });
  }

  /**
   * Administrative method. Only the trusted Extension or local approval page calls it. A denial
   * may carry the user's reason, which the model reads back as denial_reason.
   */
  async decide(id: string, fingerprint: string, approve: boolean, reason?: string) {
    const denial = denialReason(approve, reason);
    const job = this.get(id);
    if (job.view.state !== "pending" || job.applying || fingerprint !== job.fingerprint)
      throw new KairomesError("APPROVAL_MISMATCH", "檔案變更已處理或審批內容不一致，請更新狀態。");
    if (this.now() >= job.view.expires_at) {
      this.finish(job, "expired");
      throw new KairomesError("APPROVAL_EXPIRED", "檔案變更請求已過期。");
    }
    if (!approve) {
      if (denial) job.view.denial_reason = denial;
      this.finish(job, "denied");
      return;
    }

    job.view.state = "applying";
    this.notify(job);
    job.applying = (async () => {
      try {
        if (job.grantId && this.access(job.view.workspace_id)?.id !== job.grantId) {
          this.finish(job, "cancelled");
          return;
        }
        await this.engine.apply(job.prepared);
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

  private finish(job: Job, state: FileChange["state"]) {
    job.view.state = state;
    this.notify(job);
  }

  private result(job: Job): FileChangeResult {
    const diff = boundedDiff(job.prepared.diff);
    return {
      kind: "file_change",
      change: structuredClone(job.view),
      diff: diff.text,
      diff_truncated: diff.truncated,
    };
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

  async adoptAccess(workspaceId: string) {
    const grant = this.access(workspaceId);
    if (!grant) return;
    const pending = [...this.jobs.values()].filter(
      (job) =>
        job.view.workspace_id === workspaceId &&
        job.view.state === "pending" &&
        this.now() < job.view.expires_at,
    );
    for (const job of pending) job.grantId = grant.id;
    for (const job of pending) {
      if (this.access(workspaceId)?.id !== grant.id || job.view.state !== "pending") continue;
      await this.decide(job.view.id, job.fingerprint, true);
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
  }
}
