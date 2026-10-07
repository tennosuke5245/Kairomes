import { expect, test } from "bun:test";
import {
  IMAGE_IMPORT_MAX_BYTES,
  IMAGE_IMPORT_MAX_PIXELS,
  imagePathProblem,
  imagePathProblemText,
  parentFolder,
  sanitizeImageStem,
  suggestImagePath,
  withImageExtension,
} from "../packages/protocol/src/image-path.ts";
import { LIMITS } from "../packages/protocol/src/index.ts";
import { validateRelativePath } from "../packages/workspace-core/src/paths.ts";

// The side panel and widget explain a bad target before sending it; the daemon decides. Both
// must agree, so this compares the shared client rules with the daemon's own validator.
const daemonProblem = (path: string) => {
  const extension = path.slice(path.lastIndexOf("/") + 1);
  const dot = extension.lastIndexOf(".");
  if (
    ![".png", ".jpg", ".jpeg", ".webp"].includes(dot > 0 ? extension.slice(dot).toLowerCase() : "")
  )
    return "UNSUPPORTED_ARTIFACT_EXTENSION";
  try {
    validateRelativePath(path);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

test("client path rules match the daemon's codes on a corpus of hostile and plain paths", () => {
  const corpus = [
    "images/cover.png",
    "design/placeholders/figure-default.png",
    "a.JPEG",
    "photo.webp",
    "../escape.png",
    "src/../../escape.png",
    "/abs.png",
    "C:/escape.png",
    "dir\\file.png",
    "dir//file.png",
    "./file.png",
    "dir/./file.png",
    "file .png",
    "dir. /file.png",
    "con.png",
    "dir/lpt1.png",
    "node_modules/figure.png",
    ".git/logo.png",
    ".env.local.png",
    ".kairomes-import-x.png",
    "keys/server.key.png",
    "notes.txt",
    "image",
    ".png",
    "images/.png",
    "bidi\u202e.png",
    "tab\t.png",
    "images/封面.png",
  ];
  for (const path of corpus)
    expect(imagePathProblem(path), path).toBe(daemonProblem(path) as never);
});

test("the extension must name the image's real format", () => {
  expect(imagePathProblem("cover.png", "image/png")).toBeUndefined();
  expect(imagePathProblem("cover.jpeg", "image/jpeg")).toBeUndefined();
  expect(imagePathProblem("cover.jpg", "image/png")).toBe("ARTIFACT_EXTENSION_MISMATCH");
  expect(imagePathProblemText("ARTIFACT_EXTENSION_MISMATCH", "image/png")).toContain(".png");
  expect(imagePathProblem(`${"x".repeat(1021)}.png`)).toBe("INVALID_PATH");
});

test("shared limits equal the protocol limits", () => {
  expect(IMAGE_IMPORT_MAX_BYTES).toBe(LIMITS.artifactBytes);
  expect(IMAGE_IMPORT_MAX_PIXELS).toBe(LIMITS.importPixels);
});

test("file names become safe stems; generic and private names fall back to a timestamp", () => {
  expect(sanitizeImageStem("ChatGPT Image Oct 7, 2026, 02_15_33 PM.png")).toBe(
    "ChatGPT-Image-Oct-7-2026-02_15_33-PM",
  );
  expect(sanitizeImageStem("封面 設計.webp")).toBe("封面-設計");
  expect(sanitizeImageStem("C:\\Users\\mei\\Desktop\\logo.png")).toBe("logo");
  expect(sanitizeImageStem("../../secret.png")).toBe("secret");
  expect(sanitizeImageStem("evil\u202egnp.exe")).toBe("evilgnp");
  // A leading dot is dropped, so a name never becomes a hidden or private file.
  expect(sanitizeImageStem(".env.png")).toBe("env");
  for (const name of ["image.png", "blob", "", "con.png", "...png", "id_rsa", "server.key.png"])
    expect(sanitizeImageStem(name), name).toBeUndefined();
  expect([...(sanitizeImageStem(`${"長".repeat(200)}.png`) ?? "")]).toHaveLength(80);
});

test("the suggested path uses the real format's extension and always passes the rules", () => {
  const now = new Date(2026, 9, 7, 14, 32, 5).getTime();
  expect(suggestImagePath({ name: "cover.jpg", mime: "image/png", now })).toBe("images/cover.png");
  expect(suggestImagePath({ name: "image.png", mime: "image/webp", now })).toBe(
    "images/image-20261007-143205.webp",
  );
  expect(suggestImagePath({ name: "hero.png", mime: "image/jpeg", now, folder: "design/" })).toBe(
    "design/hero.jpg",
  );
  expect(suggestImagePath({ name: "hero.png", mime: "image/png", now, folder: "" })).toBe(
    "hero.png",
  );
  // A remembered folder that breaks the rules is not reused.
  expect(
    suggestImagePath({ name: "hero.png", mime: "image/png", now, folder: "node_modules" }),
  ).toBe("image-20261007-143205.png");
  for (const name of ["a b c.png", "x.y.z.png", "日本語.png", "\u0000.png", "con.png"]) {
    const path = suggestImagePath({ name, mime: "image/png", now });
    expect(imagePathProblem(path, "image/png"), path).toBeUndefined();
  }
  expect(parentFolder("design/placeholders/a.png")).toBe("design/placeholders");
  expect(parentFolder("a.png")).toBe("");
  expect(withImageExtension("design/cover.png", "image/jpeg")).toBe("design/cover.jpg");
  expect(withImageExtension("cover", "image/webp")).toBe("cover.webp");
});
