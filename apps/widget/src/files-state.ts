import type { Artifact, FileResult, SearchResult, Snapshot } from "@kairomes/protocol";

// What a result pushed into the 檔案 view does to it (C3–C5). The workbench (results opened
// from 動態) and the ChatGPT host viewer (results the model pushes) share one rule, so a new
// search or folder can never stay hidden behind a file that was already open.

export type FilesTab = "files" | "search";

export interface FilesView {
  file: FileResult | null;
  /** The line a search hit points at, highlighted in the file viewer. */
  fileFocus?: { path: string; line: number };
  search: SearchResult | null;
  snapshot: Snapshot | null;
  artifact: Artifact | null;
  tab: FilesTab;
}

/**
 * The fields a loaded result changes; fields it leaves out keep their value. A search or a
 * folder closes the open file (the viewer covers the browser), and a file opens on 瀏覽.
 */
export function filesResultPatch(data: FileResult | SearchResult | Snapshot): Partial<FilesView> {
  switch (data.kind) {
    case "file":
      return { file: data, fileFocus: undefined, artifact: null, tab: "files" };
    case "search":
      return { file: null, fileFocus: undefined, artifact: null, search: data, tab: "search" };
    case "snapshot":
      return {
        file: null,
        fileFocus: undefined,
        artifact: null,
        search: null,
        snapshot: data,
        tab: "files",
      };
  }
}

/** What the 檔案 view shows: the open file, else the browser on its tab. */
export function filesPane(view: Pick<FilesView, "file" | "tab">): "viewer" | FilesTab {
  return view.file ? "viewer" : view.tab;
}
