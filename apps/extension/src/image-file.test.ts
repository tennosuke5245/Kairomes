import { expect, test } from "bun:test";
import {
  animatedPng,
  jpegHeader,
  onePixelPng,
  pngHeader,
  webpHeader,
} from "../../daemon/src/__fixtures__/images.ts";
import {
  checkImageBytes,
  formatBytes,
  imageHeader,
  imageSummary,
  importErrorField,
  importErrorText,
  prepareImage,
  sha256Hex,
  sniffImageType,
} from "./image-file.ts";

const bytes = (buffer: Buffer) => new Uint8Array(buffer);

test("the bytes, not the declared type, name the format", () => {
  expect(sniffImageType(bytes(onePixelPng))).toBe("image/png");
  expect(sniffImageType(bytes(jpegHeader(3, 2)))).toBe("image/jpeg");
  expect(sniffImageType(bytes(webpHeader(5, 4)))).toBe("image/webp");
  expect(sniffImageType(new TextEncoder().encode("<!doctype html>"))).toBeUndefined();
  expect(sniffImageType(new Uint8Array())).toBeUndefined();
});

test("headers give the pixel size and animation of each format", () => {
  expect(imageHeader(bytes(onePixelPng))).toEqual({
    mime: "image/png",
    width: 1,
    height: 1,
    animated: false,
  });
  expect(imageHeader(bytes(pngHeader(1200, 750)))).toMatchObject({ width: 1200, height: 750 });
  expect(imageHeader(bytes(jpegHeader(640, 480)))).toMatchObject({ width: 640, height: 480 });
  expect(imageHeader(bytes(webpHeader(300, 200)))).toMatchObject({ width: 300, height: 200 });
  expect(imageHeader(bytes(animatedPng()))?.animated).toBe(true);
  expect(imageHeader(bytes(webpHeader(4, 4, 0x02)))?.animated).toBe(true);
});

test("local checks mirror the daemon's limits before anything is uploaded", () => {
  expect(checkImageBytes(bytes(onePixelPng))).toMatchObject({ ok: true });
  expect(checkImageBytes(new Uint8Array())).toEqual({ ok: false, code: "EMPTY_IMAGE" });
  expect(checkImageBytes(new TextEncoder().encode('{"error":"x"}'))).toEqual({
    ok: false,
    code: "IMPORT_NOT_IMAGE",
  });
  expect(checkImageBytes(bytes(pngHeader(16_385, 10)))).toEqual({
    ok: false,
    code: "UNSAFE_IMAGE_DIMENSIONS",
  });
  expect(checkImageBytes(bytes(pngHeader(5000, 5000)))).toEqual({
    ok: false,
    code: "UNSAFE_IMAGE_DIMENSIONS",
  });
  expect(checkImageBytes(bytes(animatedPng()))).toEqual({
    ok: false,
    code: "ANIMATED_IMAGE_UNSUPPORTED",
  });
  // A JPEG without a frame header is not a usable image.
  expect(checkImageBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual({
    ok: false,
    code: "INVALID_IMAGE",
  });
});

test("a prepared image hashes exactly the bytes it will upload, whatever the file claims", async () => {
  const file = new File([onePixelPng], "封面.jpg", { type: "image/jpeg" });
  const prepared = await prepareImage(file);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  expect(prepared.image).toMatchObject({
    mime: "image/png",
    size: onePixelPng.length,
    name: "封面.jpg",
  });
  expect(prepared.image.blob.type).toBe("image/png");
  const sent = new Uint8Array(await prepared.image.blob.arrayBuffer());
  expect(prepared.image.sha256).toBe(await sha256Hex(sent));
  expect(prepared.image.sha256).toBe(
    new Bun.CryptoHasher("sha256").update(onePixelPng).digest("hex"),
  );
  const big = { size: 25 * 1024 * 1024 + 1, arrayBuffer: async () => new ArrayBuffer(0) } as Blob;
  expect(await prepareImage(big)).toEqual({ ok: false, code: "ARTIFACT_TOO_LARGE" });
});

test("sizes and the one-line image summary use binary units", () => {
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(8126)).toBe("7.9 KiB");
  expect(formatBytes(25 * 1024 * 1024)).toBe("25.0 MiB");
  expect(imageSummary({ mime: "image/png", width: 128, height: 128, size: 8126 })).toBe(
    "128 × 128 · PNG · 7.9 KiB",
  );
});

test("error codes map to one fixed sentence and a form field; daemon text never passes", () => {
  expect(importErrorField("PARENT_NOT_FOUND")).toBe("path");
  expect(importErrorField("FILE_EXISTS")).toBe("path");
  expect(importErrorField("INVALID_IMAGE")).toBe("image");
  expect(importErrorField("ARTIFACT_IMPORT_LIMIT")).toBe("general");
  expect(importErrorText("PARENT_NOT_FOUND", { path: "design/placeholders/a.png" })).toContain(
    "「design/placeholders」",
  );
  expect(importErrorText("ARTIFACT_EXTENSION_MISMATCH", { mime: "image/jpeg" })).toContain(".jpg");
  for (const code of ["SOMETHING_NEW", "", "FILE_DOWNLOAD_FAILED"])
    expect(importErrorText(code)).toBe("匯入未被接受。");
  expect(importErrorText("IMPORT_PREVIEW_REQUIRED")).toContain("預覽");
});
