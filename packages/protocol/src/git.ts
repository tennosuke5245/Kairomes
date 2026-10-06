import { z } from "zod";

/** Bounds shared by the read-only Git tools and their local renderers. */
export const GIT_LIMITS = {
  statusEntries: 500,
  diffFiles: 300,
  diffPageBytes: 48 * 1024,
  logCommits: 50,
  subjectLength: 300,
  nameLength: 200,
  refLength: 255,
  /** Longer repository paths are omitted like private names instead of failing the whole view. */
  pathLength: 1024,
} as const;

const WorkspaceId = z.string().uuid();
const GitPath = z.string().min(1).max(GIT_LIMITS.pathLength);
const Sha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const ShortSha = z.string().regex(/^[0-9a-f]{4,64}$/);
const RefName = z.string().min(1).max(GIT_LIMITS.refLength);
/** Opaque to the model: a page offset bound to a digest of the diff it came from. */
export const GitDiffCursorSchema = z.string().regex(/^\d{1,8}\.[0-9a-f]{16}$/);

export const GitUnavailableReasonSchema = z.enum([
  "not_repository",
  "root_mismatch",
  "git_missing",
  "timeout",
  "too_large",
  "unsupported_config",
  "failed",
]);
export type GitUnavailableReason = z.infer<typeof GitUnavailableReasonSchema>;

const Availability = {
  state: z.enum(["available", "unavailable"]),
  reason: GitUnavailableReasonSchema.nullable(),
  message: z.string().max(200).nullable(),
};

const StatusCode = z.enum([".", "M", "T", "A", "D", "R", "C", "U", "?"]);
export const GitStatusEntrySchema = z
  .object({
    path: GitPath,
    previous_path: GitPath.optional(),
    index_status: StatusCode,
    worktree_status: StatusCode,
    kind: z.enum(["staged", "unstaged", "untracked", "conflict"]),
  })
  .strict();
export type GitStatusEntry = z.infer<typeof GitStatusEntrySchema>;

export const GitStatusSchema = z
  .object({
    kind: z.literal("git_status"),
    workspace_id: WorkspaceId,
    ...Availability,
    branch: RefName.nullable(),
    detached: z.boolean(),
    head: z
      .object({
        sha: Sha,
        short_sha: ShortSha,
        subject: z.string().max(GIT_LIMITS.subjectLength),
      })
      .strict()
      .nullable(),
    upstream: z
      .object({
        name: RefName,
        ahead: z.number().int().nonnegative().nullable(),
        behind: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    entries: z.array(GitStatusEntrySchema).max(GIT_LIMITS.statusEntries),
    truncated: z.boolean(),
    omitted_private: z.number().int().nonnegative(),
  })
  .strict();
export type GitStatus = z.infer<typeof GitStatusSchema>;

export const GitDiffFileSchema = z
  .object({
    path: GitPath,
    previous_path: GitPath.optional(),
    status: z.enum(["A", "C", "D", "M", "R", "T", "U"]),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    binary: z.boolean(),
  })
  .strict();
export type GitDiffFile = z.infer<typeof GitDiffFileSchema>;

export const GitDiffSchema = z
  .object({
    kind: z.literal("git_diff"),
    workspace_id: WorkspaceId,
    ...Availability,
    staged: z.boolean(),
    path: GitPath.nullable(),
    context_lines: z.number().int().min(0).max(10),
    files: z.array(GitDiffFileSchema).max(GIT_LIMITS.diffFiles),
    files_truncated: z.boolean(),
    omitted_private: z.number().int().nonnegative(),
    diff: z.string().max(GIT_LIMITS.diffPageBytes),
    next_cursor: GitDiffCursorSchema.nullable(),
    has_more: z.boolean(),
    truncated: z.boolean(),
    redacted: z.boolean(),
  })
  .strict();
export type GitDiff = z.infer<typeof GitDiffSchema>;

export const GitCommitSchema = z
  .object({
    sha: Sha,
    short_sha: ShortSha,
    author_name: z.string().max(GIT_LIMITS.nameLength),
    authored_at: z.string().max(40),
    subject: z.string().max(GIT_LIMITS.subjectLength),
  })
  .strict();
export type GitCommit = z.infer<typeof GitCommitSchema>;

export const GitLogSchema = z
  .object({
    kind: z.literal("git_log"),
    workspace_id: WorkspaceId,
    ...Availability,
    path: GitPath.nullable(),
    commits: z.array(GitCommitSchema).max(GIT_LIMITS.logCommits),
    has_more: z.boolean(),
  })
  .strict();
export type GitLog = z.infer<typeof GitLogSchema>;

export const GitInputs = {
  git_status: z.object({ workspace_id: WorkspaceId }).strict(),
  git_diff: z
    .object({
      workspace_id: WorkspaceId,
      path: GitPath.optional(),
      staged: z.boolean().default(false),
      context_lines: z.number().int().min(0).max(10).default(3),
      cursor: GitDiffCursorSchema.optional(),
    })
    .strict(),
  git_log: z
    .object({
      workspace_id: WorkspaceId,
      path: GitPath.optional(),
      limit: z.number().int().min(1).max(GIT_LIMITS.logCommits).default(20),
    })
    .strict(),
} as const;
