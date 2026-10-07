import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { type Artifact, KairomesError, LIMITS } from "@kairomes/protocol";
import { resolveChecked, validateRelativePath } from "./paths.ts";
import type { WorkspaceRegistry } from "./registry.ts";

type ImageInfo = Pick<Artifact, "mime_type" | "width" | "height">;

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegStartOfFrame = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function uint24le(data: Buffer, offset: number) {
  return (
    data.readUInt8(offset) | (data.readUInt8(offset + 1) << 8) | (data.readUInt8(offset + 2) << 16)
  );
}

function pngInfo(data: Buffer): ImageInfo | undefined {
  if (
    data.length < 45 ||
    !data.subarray(0, 8).equals(pngSignature) ||
    data.readUInt32BE(8) !== 13 ||
    data.toString("ascii", 12, 16) !== "IHDR" ||
    data.readUInt32BE(data.length - 12) !== 0 ||
    data.toString("ascii", data.length - 8, data.length - 4) !== "IEND"
  )
    return undefined;
  return {
    mime_type: "image/png",
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

function jpegInfo(data: Buffer): ImageInfo | undefined {
  if (
    data.length < 12 ||
    data[0] !== 0xff ||
    data[1] !== 0xd8 ||
    data[data.length - 2] !== 0xff ||
    data[data.length - 1] !== 0xd9
  )
    return undefined;
  let offset = 2;
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) {
      offset++;
      continue;
    }
    while (offset < data.length && data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= data.length) break;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) break;
    if (jpegStartOfFrame.has(marker) && length >= 7) {
      return {
        mime_type: "image/jpeg",
        height: data.readUInt16BE(offset + 3),
        width: data.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return undefined;
}

function webpInfo(data: Buffer): ImageInfo | undefined {
  if (
    data.length < 30 ||
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WEBP" ||
    data.readUInt32LE(4) + 8 !== data.length
  )
    return undefined;
  let offset = 12;
  while (offset + 8 <= data.length) {
    const type = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (payload + length > data.length) return undefined;
    if (type === "VP8X" && length >= 10) {
      return {
        mime_type: "image/webp",
        width: uint24le(data, payload + 4) + 1,
        height: uint24le(data, payload + 7) + 1,
      };
    }
    if (type === "VP8L" && length >= 5 && data[payload] === 0x2f) {
      const b1 = data.readUInt8(payload + 1);
      const b2 = data.readUInt8(payload + 2);
      const b3 = data.readUInt8(payload + 3);
      const b4 = data.readUInt8(payload + 4);
      return {
        mime_type: "image/webp",
        width: 1 + (b1 | ((b2 & 0x3f) << 8)),
        height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
      };
    }
    if (
      type === "VP8 " &&
      length >= 10 &&
      data[payload + 3] === 0x9d &&
      data[payload + 4] === 0x01 &&
      data[payload + 5] === 0x2a
    ) {
      return {
        mime_type: "image/webp",
        width: data.readUInt16LE(payload + 6) & 0x3fff,
        height: data.readUInt16LE(payload + 8) & 0x3fff,
      };
    }
    offset = payload + length + (length % 2);
  }
  return undefined;
}

/**
 * Format named by the leading magic bytes alone, or undefined. Needs at most 12 bytes, so a
 * download can stop as soon as an HTML page, JSON error or other non-image body starts.
 */
export function imageSignature(data: Uint8Array): Artifact["mime_type"] | undefined {
  const head = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 12));
  if (head.length >= 8 && head.subarray(0, 8).equals(pngSignature)) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return "image/jpeg";
  if (
    head.length >= 12 &&
    head.toString("ascii", 0, 4) === "RIFF" &&
    head.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return undefined;
}

/** True for an animated PNG (acTL before the first IDAT) or WebP (animation flag or frames). */
export function isAnimatedImage(data: Buffer, mimeType: Artifact["mime_type"]) {
  if (mimeType === "image/png") {
    let offset = 8;
    while (offset + 8 <= data.length) {
      const length = data.readUInt32BE(offset);
      const type = data.toString("ascii", offset + 4, offset + 8);
      if (type === "acTL") return true;
      if (type === "IDAT" || type === "IEND") return false;
      offset += 12 + length;
    }
    return false;
  }
  if (mimeType === "image/webp") {
    let offset = 12;
    while (offset + 8 <= data.length) {
      const type = data.toString("ascii", offset, offset + 4);
      const length = data.readUInt32LE(offset + 4);
      if (type === "VP8X" && length >= 1 && ((data[offset + 8] ?? 0) & 0x02) !== 0) return true;
      if (type === "ANIM" || type === "ANMF") return true;
      offset += 8 + length + (length % 2);
    }
  }
  return false;
}

/**
 * Validates the container and header dimensions. `maxPixels` defaults to the workspace preview
 * budget; imports pass the smaller LIMITS.importPixels. This is not a full decode.
 */
export function inspectImageBuffer(
  data: Buffer,
  maxPixels: number = LIMITS.artifactPixels,
): ImageInfo {
  const info = pngInfo(data) ?? jpegInfo(data) ?? webpInfo(data);
  if (!info)
    throw new KairomesError(
      "UNSUPPORTED_ARTIFACT",
      "目前只能預覽格式正確的 PNG、JPEG 或 WebP 圖片。",
    );
  if (
    info.width <= 0 ||
    info.height <= 0 ||
    info.width > 16_384 ||
    info.height > 16_384 ||
    info.width * info.height > maxPixels
  )
    throw new KairomesError("UNSAFE_IMAGE_DIMENSIONS", "圖片尺寸超過安全預覽上限。");
  return info;
}

export class WorkspaceArtifacts {
  constructor(private readonly registry: WorkspaceRegistry) {}

  private async load(id: string, relative: string): Promise<{ artifact: Artifact; data: Buffer }> {
    validateRelativePath(relative);
    const root = this.registry.get(id);
    const target = await resolveChecked(root, relative);
    if (!(await lstat(target)).isFile())
      throw new KairomesError("NOT_FILE", "此路徑不是一般檔案。");
    const handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new KairomesError("NOT_FILE", "此路徑不是一般檔案。");
      if (before.nlink > 1n)
        throw new KairomesError("LINK_BLOCKED", "此版本不讀取多重硬連結檔案。");
      if (before.size <= 0n || before.size > BigInt(LIMITS.artifactBytes))
        throw new KairomesError("ARTIFACT_TOO_LARGE", "圖片必須小於 25 MiB。");
      const data = Buffer.alloc(Number(before.size));
      let bytes = 0;
      while (bytes < data.length) {
        const read = await handle.read(data, bytes, data.length - bytes, bytes);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
      }
      await resolveChecked(root, relative);
      const after = await handle.stat({ bigint: true });
      const current = await lstat(target, { bigint: true });
      if (
        bytes !== data.length ||
        current.isSymbolicLink() ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.nlink > 1n ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        after.size !== before.size
      )
        throw new KairomesError("FILE_CHANGED", "圖片在讀取途中改變，請重試。");
      const image = inspectImageBuffer(data);
      const version = createHash("sha256").update(data).digest("hex");
      const artifactId = createHash("sha256")
        .update(id)
        .update("\0")
        .update(relative)
        .update("\0")
        .update(version)
        .digest("hex");
      return {
        data,
        artifact: {
          kind: "artifact",
          artifact_id: artifactId,
          workspace_id: id,
          path: relative,
          media_kind: "image",
          mime_type: image.mime_type,
          byte_size: data.length,
          width: image.width,
          height: image.height,
          version,
          modified_at: Number(before.mtimeMs),
          previewable: true,
        },
      };
    } finally {
      await handle.close();
    }
  }

  async inspect(id: string, relative: string): Promise<Artifact> {
    return (await this.load(id, relative)).artifact;
  }

  async content(id: string, relative: string, expectedVersion: string) {
    const result = await this.load(id, relative);
    if (result.artifact.version !== expectedVersion)
      throw new KairomesError("ARTIFACT_CHANGED", "圖片已變更，請重新開啟最新預覽。");
    return result;
  }
}
