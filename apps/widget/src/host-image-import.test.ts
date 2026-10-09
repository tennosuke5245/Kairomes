import { expect, test } from "bun:test";
import {
  downloadUrlOf,
  hostFileApi,
  hostImageMime,
  hostImportArguments,
  selectedImage,
  visibleFileName,
} from "./host-image-import.ts";

test("the ChatGPT picker is offered only when both host helpers exist", () => {
  const helpers = { selectFiles: async () => [], getFileDownloadUrl: async () => ({}) };
  expect(hostFileApi({ openai: helpers })).toBeDefined();
  expect(hostFileApi({ openai: { selectFiles: helpers.selectFiles } })).toBeUndefined();
  expect(
    hostFileApi({ openai: { getFileDownloadUrl: helpers.getFileDownloadUrl } }),
  ).toBeUndefined();
  expect(hostFileApi({})).toBeUndefined();
  expect(hostFileApi(undefined)).toBeUndefined();
});

test("a selection is read from any envelope, with bounded fields", () => {
  expect(selectedImage([{ fileId: "file-1", fileName: "a.png", mimeType: "image/png" }])).toEqual({
    fileId: "file-1",
    fileName: "a.png",
    mimeType: "image/png",
  });
  expect(
    selectedImage({ files: [{ file_id: "file-2", name: "b.webp", type: "image/gif" }] }),
  ).toEqual({
    fileId: "file-2",
    fileName: "b.webp",
  });
  expect(selectedImage({ id: "file-3" })).toEqual({ fileId: "file-3" });
  expect(selectedImage([])).toBeUndefined();
  expect(selectedImage([{ fileId: "x".repeat(513) }])).toBeUndefined();
  expect(selectedImage([{ fileId: "f", fileName: "n".repeat(256) }])).toEqual({ fileId: "f" });
  expect(hostImageMime({ fileId: "f", fileName: "photo.JPG" })).toBe("image/jpeg");
});

test("only an https download URL is accepted, and only inside the tool arguments", () => {
  expect(downloadUrlOf({ downloadUrl: "https://files.example/x" })).toBe("https://files.example/x");
  expect(downloadUrlOf("https://files.example/y")).toBe("https://files.example/y");
  expect(downloadUrlOf({ url: "http://files.example/x" })).toBeUndefined();
  expect(downloadUrlOf({ download_url: "javascript:alert(1)" })).toBeUndefined();
  expect(downloadUrlOf({ downloadUrl: `https://e.example/${"a".repeat(5000)}` })).toBeUndefined();
  const args = hostImportArguments({
    workspaceId: "w",
    path: "images/a.png",
    requestId: "r",
    image: { fileId: "file-1", fileName: "a.png", mimeType: "image/png" },
    downloadUrl: "https://files.example/x",
  });
  expect(args).toEqual({
    workspace_id: "w",
    request_id: "r",
    path: "images/a.png",
    summary: "從 ChatGPT 工作台選擇的圖片",
    file: {
      download_url: "https://files.example/x",
      file_id: "file-1",
      mime_type: "image/png",
      file_name: "a.png",
    },
  });
});

test("a host file name is shown as text, with invisible characters made visible", () => {
  expect(visibleFileName("ChatGPT Image 封面.png")).toBe("ChatGPT Image 封面.png");
  // A right-to-left override would make "gnp.exe" read as "exe.png".
  expect(visibleFileName("photo\u202Egnp.exe")).toBe("photo\\u{202E}gnp.exe");
  expect(visibleFileName("a\u200Bb\nc")).toBe("a\\u{200B}b\\u{A}c");
});
