import { expect, test } from "bun:test";
import { copyHandoffContent, handoffError } from "./handoff-copy.ts";

const preview = { text: "完整合成接續內容", digest: "a".repeat(64) };
function actions() {
  const state = {
    baseline: true,
    preview: preview.text as string | null,
    reviewed: true,
    copied: false,
    selected: false,
    writes: [] as string[],
  };
  return {
    state,
    prepare: async () => preview,
    writeText: async (text: string) => {
      state.writes.push(text);
    },
    invalidate: () => {
      state.baseline = false;
      state.preview = null;
      state.reviewed = false;
      state.copied = false;
    },
    fallback: () => {
      state.selected = true;
      state.reviewed = false;
      state.copied = false;
    },
    active: () => true,
  };
}

test("Tauri public string failures preserve their actionable reason without serializing unknown data", () => {
  const message = "來源紀錄已更新，請重新選取並審閱。";
  expect(handoffError(message)).toBeInstanceOf(Error);
  expect(handoffError(message).message).toBe(message);
  const error = new Error("檔案版本已改變，請重新核對並審閱。");
  expect(handoffError(error)).toBe(error);
  for (const value of [null, undefined, "", "   ", { private: "DO_NOT_DISPLAY" }]) {
    expect(handoffError(value).message).toBe("無法完成接續核對。");
    expect(handoffError(value).message).not.toContain("DO_NOT_DISPLAY");
  }
});

test("failed prepare invalidates all previous verification and never writes the clipboard", async () => {
  const current = actions();
  current.state.copied = true;
  const message = "檔案版本已改變，請重新核對並審閱。";
  current.prepare = async () => {
    throw message;
  };
  await expect(copyHandoffContent(preview, current)).rejects.toThrow(message);
  expect(current.state).toEqual({
    baseline: false,
    preview: null,
    reviewed: false,
    copied: false,
    selected: false,
    writes: [],
  });
});

test("changed digest or text requires a new review, even when the other field still matches", async () => {
  for (const prepared of [
    { ...preview, digest: "b".repeat(64) },
    { ...preview, text: "另一份內容" },
  ]) {
    const current = actions();
    current.prepare = async () => prepared;
    await expect(copyHandoffContent(preview, current)).rejects.toThrow("內容已改變");
    expect(current.state.baseline).toBe(false);
    expect(current.state.preview).toBeNull();
    expect(current.state.reviewed).toBe(false);
    expect(current.state.writes).toEqual([]);
  }
});

test("clipboard failure retains the complete reviewed preview for manual selection without claiming copied", async () => {
  const current = actions();
  current.writeText = async () => {
    throw new Error("Synthetic clipboard denial");
  };
  await expect(copyHandoffContent(preview, current)).rejects.toThrow("可手動複製");
  expect(current.state.baseline).toBe(true);
  expect(current.state.preview).toBe(preview.text);
  expect(current.state.selected).toBe(true);
  expect(current.state.copied).toBe(false);
});

test("only an active, unchanged preparation reaches the clipboard and can report copied", async () => {
  const current = actions();
  expect(await copyHandoffContent(preview, current)).toBe(true);
  expect(current.state.writes).toEqual([preview.text]);
  expect(current.state.baseline).toBe(true);
  const cancelled = actions();
  cancelled.active = () => false;
  expect(await copyHandoffContent(preview, cancelled)).toBe(false);
  expect(cancelled.state.writes).toEqual([]);
  expect(cancelled.state.selected).toBe(false);
});
