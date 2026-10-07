import { expect, test } from "bun:test";
import {
  copyImageMenuLabel,
  dragKind,
  dropEffectFor,
  imageFromTransfer,
  pasteHasImage,
} from "./image-transfer.ts";

const file = (name: string, type: string) => new File([new Uint8Array([1])], name, { type });
const item = (value: File | null, kind = "file") => ({
  kind,
  type: value?.type ?? "text/plain",
  getAsFile: () => value,
});

test("a paste or drop yields its first image file and counts the rest", () => {
  const png = file("image.png", "image/png");
  const jpg = file("b.jpg", "image/jpeg");
  expect(imageFromTransfer({ files: [png, jpg] })).toEqual({
    kind: "image",
    file: png,
    ignored: 1,
  });
  // Chrome's clipboard exposes images as items; files may be empty.
  expect(imageFromTransfer({ files: [], items: [item(null, "string"), item(png)] })).toEqual({
    kind: "image",
    file: png,
    ignored: 0,
  });
  // A file with no declared type is still offered; the byte check decides.
  const untyped = file("photo", "");
  expect(imageFromTransfer({ files: [untyped] })).toMatchObject({ kind: "image", file: untyped });
});

test("non-image files and link-only drags are told apart from nothing at all", () => {
  expect(imageFromTransfer({ files: [file("a.pdf", "application/pdf")] })).toEqual({
    kind: "not-image",
  });
  // An <img> dragged out of a web page carries a URL and markup, not bytes.
  expect(imageFromTransfer({ files: [], types: ["text/uri-list", "text/html"] })).toEqual({
    kind: "link",
  });
  expect(imageFromTransfer({ files: [], types: ["text/plain"] })).toEqual({ kind: "none" });
  expect(imageFromTransfer(null)).toEqual({ kind: "none" });
});

test("drag types decide the overlay before any file can be read", () => {
  expect(dragKind(["Files"])).toBe("files");
  expect(dragKind(["text/uri-list", "text/html"])).toBe("link");
  expect(dragKind(["text/plain"])).toBe("none");
  expect(dragKind(undefined)).toBe("none");
});

test("a text paste is never mistaken for an image paste", () => {
  expect(pasteHasImage({ files: [], items: [item(null, "string")], types: ["text/plain"] })).toBe(
    false,
  );
  expect(pasteHasImage({ files: [file("image.png", "image/png")] })).toBe(true);
});

test("a dragged link is accepted so its drop shows the copy-image instruction", () => {
  // An <img> dragged out of a page: no bytes, but the drop must fire to leave the notice.
  expect(dropEffectFor(dragKind(["text/uri-list", "text/html"]), false)).toBe("copy");
  expect(dropEffectFor("files", true)).toBe("copy");
  // Files with nowhere to go (no pairing, no project) are refused while dragging.
  expect(dropEffectFor("files", false)).toBe("none");
  expect(dropEffectFor("none", true)).toBe("none");
});

test("the copy instruction names the menu item the way this browser does", () => {
  const chrome =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  expect(copyImageMenuLabel(chrome)).toBe("複製圖片");
  expect(copyImageMenuLabel(`${chrome} Edg/141.0.0.0`)).toBe("複製影像");
  expect(copyImageMenuLabel("")).toBe("複製圖片");
});
