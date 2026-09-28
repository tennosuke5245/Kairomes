import { createHash } from "node:crypto";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { type Artifact, KairomesError, LIMITS } from "@kairomes/protocol";
import { inspectImageBuffer, WorkspaceArtifacts } from "./artifacts.ts";
import { isWithin, resolveChecked, validateRelativePath } from "./paths.ts";
import type { WorkspaceRegistry } from "./registry.ts";

export type PreparedArtifactImport = {
  workspaceId: string;
  path: string;
  target: string;
  data: Buffer;
  mimeType: Artifact["mime_type"];
  width: number;
  height: number;
  version: string;
};

const expectedExtensions: Record<Artifact["mime_type"], Set<string>> = {
  "image/png": new Set([".png"]),
  "image/jpeg": new Set([".jpg", ".jpeg"]),
  "image/webp": new Set([".webp"]),
};

async function newTarget(registry: WorkspaceRegistry, workspaceId: string, relative: string) {
  const parts = validateRelativePath(relative);
  const root = registry.get(workspaceId);
  const parent = await resolveChecked(root, parts.slice(0, -1).join("/"));
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory())
    throw new KairomesError("NOT_DIRECTORY", "匯入檔案的上層路徑必須是既有資料夾。");
  if ((await realpath(parent)) !== parent)
    throw new KairomesError("WORKSPACE_CHANGED", "上層資料夾的實際路徑已改變。");
  const target = path.join(parent, parts.at(-1) ?? "");
  if (!isWithin(root.root, target))
    throw new KairomesError("OUTSIDE_WORKSPACE", "路徑超出掛載工作區。");
  try {
    await lstat(target);
    throw new KairomesError(
      "FILE_EXISTS",
      "目的檔案已存在；媒體匯入第一版只建立新檔，不會覆寫既有內容。",
    );
  } catch (error) {
    if (error instanceof KairomesError) throw error;
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  return target;
}

export class WorkspaceArtifactImports {
  private readonly artifacts: WorkspaceArtifacts;

  constructor(private readonly registry: WorkspaceRegistry) {
    this.artifacts = new WorkspaceArtifacts(registry);
  }

  async validateDestination(workspaceId: string, relative: string) {
    const extension = path.posix.extname(relative).toLocaleLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension))
      throw new KairomesError(
        "UNSUPPORTED_ARTIFACT_EXTENSION",
        "媒體匯入路徑必須使用 .png、.jpg、.jpeg 或 .webp 副檔名。",
      );
    return newTarget(this.registry, workspaceId, relative);
  }

  async prepare(
    workspaceId: string,
    relative: string,
    input: Uint8Array,
  ): Promise<PreparedArtifactImport> {
    if (input.byteLength <= 0 || input.byteLength > LIMITS.artifactBytes)
      throw new KairomesError("ARTIFACT_TOO_LARGE", "圖片必須大於 0 且不超過 25 MiB。");
    const data = Buffer.from(input);
    const image = inspectImageBuffer(data);
    const extension = path.posix.extname(relative).toLocaleLowerCase();
    if (!expectedExtensions[image.mime_type].has(extension))
      throw new KairomesError(
        "ARTIFACT_EXTENSION_MISMATCH",
        `目的路徑副檔名與實際 ${image.mime_type} 格式不符。`,
      );
    const target = await this.validateDestination(workspaceId, relative);
    return {
      workspaceId,
      path: relative,
      target,
      data,
      mimeType: image.mime_type,
      width: image.width,
      height: image.height,
      version: createHash("sha256").update(data).digest("hex"),
    };
  }

  async apply(prepared: PreparedArtifactImport): Promise<Artifact> {
    const target = await newTarget(this.registry, prepared.workspaceId, prepared.path);
    if (target !== prepared.target)
      throw new KairomesError("WORKSPACE_CHANGED", "工作區路徑已改變，沒有匯入圖片。");
    if (createHash("sha256").update(prepared.data).digest("hex") !== prepared.version)
      throw new KairomesError("IMPORT_CHANGED", "待核准的圖片內容已改變，沒有匯入。");

    const temporary = path.join(
      path.dirname(target),
      `.kairomes-import-${path.basename(target)}-${crypto.randomUUID()}.tmp`,
    );
    let linked = false;
    let identity: { dev: bigint; ino: bigint } | undefined;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(prepared.data);
      await handle.sync();
      await handle.chmod(0o644);
      const info = await handle.stat({ bigint: true });
      identity = { dev: info.dev, ino: info.ino };
    } finally {
      await handle.close();
    }
    try {
      await newTarget(this.registry, prepared.workspaceId, prepared.path);
      try {
        await link(temporary, target);
        linked = true;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
          throw new KairomesError("FILE_EXISTS", "目的檔案已在核准期間建立，沒有覆寫任何內容。");
        throw error;
      }
      await unlink(temporary);
      const artifact = await this.artifacts.inspect(prepared.workspaceId, prepared.path);
      if (artifact.version !== prepared.version)
        throw new KairomesError("WRITE_VERIFY", "圖片寫入後驗證失敗，請檢查工作區。");
      return artifact;
    } catch (error) {
      if (linked && identity) {
        try {
          const current = await lstat(target, { bigint: true });
          if (current.dev === identity.dev && current.ino === identity.ino) await unlink(target);
        } catch {
          // Keep the original failure; cleanup is best effort and identity-bound.
        }
      }
      throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
