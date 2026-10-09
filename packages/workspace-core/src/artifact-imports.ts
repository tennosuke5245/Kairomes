import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { type Artifact, KairomesError, LIMITS, publicError } from "@kairomes/protocol";
import {
  imageSignature,
  inspectImageBuffer,
  isAnimatedImage,
  WorkspaceArtifacts,
} from "./artifacts.ts";
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

/**
 * A failed create-only write. `not_written`: this attempt left no file at the target (it failed
 * before the link, or removed its own file again). `unknown`: a file this attempt created may
 * still exist, so the caller must not report "nothing written" or retry blindly.
 */
export class ArtifactImportWriteError extends KairomesError {
  constructor(
    code: string,
    message: string,
    readonly outcome: "not_written" | "unknown",
  ) {
    super(code, message);
    this.name = "ArtifactImportWriteError";
  }

  static from(error: unknown, outcome: "not_written" | "unknown") {
    const detail = publicError(error);
    return new ArtifactImportWriteError(detail.code, detail.message, outcome);
  }
}

const extensions: Record<Artifact["mime_type"], string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
};
const formatNames: Record<Artifact["mime_type"], string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
};

function missing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function newTarget(registry: WorkspaceRegistry, workspaceId: string, relative: string) {
  const parts = validateRelativePath(relative);
  const root = registry.get(workspaceId);
  const parentPath = parts.slice(0, -1).join("/");
  let parent: string;
  try {
    parent = await resolveChecked(root, parentPath);
  } catch (error) {
    if (missing(error))
      throw new KairomesError(
        "PARENT_NOT_FOUND",
        `找不到儲存資料夾「${parentPath}」；匯入不會自動建立資料夾，請先建立它或改用既有資料夾。`,
      );
    throw error;
  }
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
      "目的檔案已存在；圖片匯入只建立新檔，不會覆寫既有內容。",
    );
  } catch (error) {
    if (error instanceof KairomesError) throw error;
    if (!missing(error)) throw error;
  }
  return target;
}

/**
 * Create-only image writes for verified bytes. Paths go through the shared validator (relative,
 * no traversal, no private names), every parent segment is checked for links, and the target is
 * re-checked right before an exclusive link, so a file that appears meanwhile is never replaced.
 */
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
        "圖片匯入路徑必須使用 .png、.jpg、.jpeg 或 .webp 副檔名。",
      );
    return newTarget(this.registry, workspaceId, relative);
  }

  /**
   * Checks the real bytes: signature, container structure, header dimensions within the import
   * budget (16 MP, 16,384 px per side), no animation, and a target extension that names the
   * same format. This is a structural check, not a full decode. The returned buffer is a copy;
   * on failure that copy is zeroed.
   */
  async prepare(
    workspaceId: string,
    relative: string,
    input: Uint8Array,
  ): Promise<PreparedArtifactImport> {
    if (input.byteLength <= 0 || input.byteLength > LIMITS.artifactBytes)
      throw new KairomesError("ARTIFACT_TOO_LARGE", "圖片必須大於 0 且不超過 25 MiB。");
    const data = Buffer.from(input);
    try {
      if (!imageSignature(data))
        throw new KairomesError(
          "IMPORT_NOT_IMAGE",
          "收到的內容不是 PNG、JPEG 或 WebP 圖片（可能是網頁或錯誤訊息）。",
        );
      let image: ReturnType<typeof inspectImageBuffer>;
      try {
        image = inspectImageBuffer(data, LIMITS.importPixels);
      } catch (error) {
        if (error instanceof KairomesError && error.code === "UNSAFE_IMAGE_DIMENSIONS")
          throw new KairomesError(
            "UNSAFE_IMAGE_DIMENSIONS",
            "圖片尺寸超過匯入上限：每邊最多 16,384 px，總像素最多 16 MP。",
          );
        if (error instanceof KairomesError && error.code === "UNSUPPORTED_ARTIFACT")
          throw new KairomesError(
            "INVALID_IMAGE",
            "圖片內容不完整或格式錯誤，只接受結構完整的 PNG、JPEG 或 WebP。",
          );
        throw error;
      }
      if (isAnimatedImage(data, image.mime_type))
        throw new KairomesError(
          "ANIMATED_IMAGE_UNSUPPORTED",
          "不支援動畫 PNG 或 WebP；請改用靜態圖片。",
        );
      const extension = path.posix.extname(relative).toLocaleLowerCase();
      const expected = extensions[image.mime_type];
      if (!expected.includes(extension))
        throw new KairomesError(
          "ARTIFACT_EXTENSION_MISMATCH",
          `圖片實際格式是 ${formatNames[image.mime_type]}，目的路徑請改用 ${expected.join(" 或 ")} 副檔名。`,
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
    } catch (error) {
      data.fill(0);
      throw error;
    }
  }

  /**
   * Writes a private temporary file, syncs it, re-checks the destination, links it to the target
   * exclusively and reads the target back. Every failure throws an
   * {@link ArtifactImportWriteError} that says whether a file may remain. The read-back and any
   * cleanup happen while the temporary link still holds the new file's inode, so a matching
   * device and inode can only be this call's own file; cleanup never removes a file someone else
   * put at the target. Once the temporary link is gone, a failure reports `unknown`.
   */
  async apply(prepared: PreparedArtifactImport): Promise<Artifact> {
    let target: string;
    // Writes a private copy, so the bytes that were hashed are exactly the bytes written.
    const bytes = Buffer.from(prepared.data);
    try {
      target = await newTarget(this.registry, prepared.workspaceId, prepared.path);
      if (target !== prepared.target)
        throw new KairomesError("WORKSPACE_CHANGED", "工作區路徑已改變，沒有匯入圖片。");
      if (createHash("sha256").update(bytes).digest("hex") !== prepared.version)
        throw new KairomesError("IMPORT_CHANGED", "待核准的圖片內容已改變，沒有匯入。");
    } catch (error) {
      bytes.fill(0);
      throw ArtifactImportWriteError.from(error, "not_written");
    }

    const temporary = path.join(
      path.dirname(target),
      `.kairomes-import-${crypto.randomUUID()}.tmp`,
    );
    let linked = false;
    let temporaryRemoved = false;
    let identity: { dev: bigint; ino: bigint } | undefined;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.chmod(0o644);
        const info = await handle.stat({ bigint: true });
        identity = { dev: info.dev, ino: info.ino };
      } finally {
        await handle.close();
      }
      await newTarget(this.registry, prepared.workspaceId, prepared.path);
      try {
        await link(temporary, target);
        linked = true;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
          throw new KairomesError("FILE_EXISTS", "目的檔案已在核准期間建立，沒有覆寫任何內容。");
        throw error;
      }
      const written = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await written.stat({ bigint: true });
        const content = await written.readFile();
        if (
          info.dev !== identity.dev ||
          info.ino !== identity.ino ||
          createHash("sha256").update(content).digest("hex") !== prepared.version
        )
          throw new KairomesError("WRITE_VERIFY", "圖片寫入後驗證失敗，請檢查工作區。");
      } finally {
        await written.close();
      }
      await unlink(temporary);
      temporaryRemoved = true;
      const artifact = await this.artifacts.inspect(prepared.workspaceId, prepared.path);
      if (artifact.version !== prepared.version)
        throw new KairomesError("WRITE_VERIFY", "圖片寫入後驗證失敗，請檢查工作區。");
      return artifact;
    } catch (error) {
      if (!linked) throw ArtifactImportWriteError.from(error, "not_written");
      if (!temporaryRemoved && identity) {
        let removed = false;
        try {
          const current = await lstat(target, { bigint: true });
          if (current.dev === identity.dev && current.ino === identity.ino) {
            await unlink(target);
            removed = true;
          }
        } catch {
          // Keep the original failure; the outcome stays unknown.
        }
        if (removed) throw ArtifactImportWriteError.from(error, "not_written");
      }
      throw ArtifactImportWriteError.from(error, "unknown");
    } finally {
      bytes.fill(0);
      // Covers every step from open through link, including a failed write or sync.
      if (!temporaryRemoved) await unlink(temporary).catch(() => {});
    }
  }
}
