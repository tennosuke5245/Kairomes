import { expect, test } from "bun:test";
import type { ActivityEntry, ActivitySnapshot, Artifact, ArtifactImport } from "@kairomes/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { activityState, activityTitle } from "./activity-model.ts";
import type { WorkbenchBridge } from "./bridge.ts";
import { importedArtifact, OverviewPanel } from "./overview-panel.tsx";
import { activityHeadline, timelineRow } from "./timeline-model.ts";

const workspace = "10000000-0000-4000-8000-000000000001";
const artifact: Artifact = {
  kind: "artifact",
  artifact_id: "3".repeat(64),
  workspace_id: workspace,
  path: "design/cover.png",
  media_kind: "image",
  mime_type: "image/png",
  byte_size: 10,
  width: 2,
  height: 2,
  version: "a".repeat(64),
  modified_at: 0,
  previewable: true,
};
const value: ArtifactImport = {
  id: "20000000-0000-4000-8000-000000000001",
  request_id: "20000000-0000-4000-8000-000000000002",
  workspace_id: workspace,
  path: "design/cover.png",
  summary: "保存封面",
  source_file_id: null,
  source_file_name: null,
  claimed_mime_type: null,
  mime_type: null,
  byte_size: null,
  width: null,
  height: null,
  version: null,
  state: "awaiting_file",
  write_outcome: "not_written",
  created_at: 0,
  applied_at: null,
  expires_at: 600_000,
  error_code: null,
  message: null,
  artifact: null,
};
const entry = (patch: Partial<ActivityEntry>): ActivityEntry => ({
  id: "import",
  seq: 3,
  focusSeq: 3,
  source: "mcp",
  kind: "artifact_import",
  tool: "artifact_import_request",
  title: "匯入圖片 · 等待圖片",
  state: "awaiting_file",
  writeOutcome: "not_written",
  updatedAt: 0,
  workspaceId: workspace,
  path: value.path,
  importId: value.id,
  ...patch,
});

test("timeline labels come from artifactImportLabel, including 結果待確認 for an unknown write", () => {
  expect(activityState(entry({}))).toMatchObject({
    label: "等待圖片",
    dataTone: "brand",
    icon: "Tray",
  });
  expect(activityState(entry({ state: "failed", writeOutcome: "unknown" }))).toMatchObject({
    label: "結果待確認",
    dataTone: "warning",
  });
  expect(activityState(entry({ state: "failed", writeOutcome: "not_written" }))).toMatchObject({
    label: "匯入失敗",
    dataTone: "danger",
  });
  expect(
    activityState(entry({ state: "applied", writeOutcome: "written_verified" })),
  ).toMatchObject({
    label: "已匯入",
  });
  // The daemon title carries the same label once; it is shown once.
  expect(
    activityTitle(
      entry({ state: "failed", writeOutcome: "unknown", title: "匯入圖片 · 結果待確認" }),
    ),
  ).toBe("匯入圖片");
  expect(activityHeadline(entry({}))).toEqual({ verb: "匯入圖片", code: "design/cover.png" });
});

test("a conflict reads its own cause, matching the side panel, and its title suffix is shown once", () => {
  const missing = entry({
    state: "conflict",
    errorCode: "PARENT_NOT_FOUND",
    title: "匯入圖片 · 找不到資料夾",
  });
  expect(activityState(missing)).toMatchObject({ label: "找不到資料夾", dataTone: "danger" });
  expect(activityTitle(missing)).toBe("匯入圖片");
  expect(activityState(entry({ state: "conflict", errorCode: "FILE_EXISTS" })).label).toBe(
    "目的檔案已存在",
  );
  expect(activityState(entry({ state: "conflict", errorCode: "LINK_BLOCKED" })).label).toBe(
    "儲存位置已變更",
  );
  // An entry without a code (older daemon) keeps the original wording.
  expect(activityState(entry({ state: "conflict" })).label).toBe("目的檔案已存在");
});

test("a waiting import shows its countdown in the timeline", () => {
  const snapshot = { imports: [value] } as unknown as ActivitySnapshot;
  const row = timelineRow(entry({}), { snapshot, now: 60_000 });
  expect(row.meta).toMatchObject({ kind: "countdown", text: "剩 9:00" });
});

test("the written file is previewed only when it is this import's target and version", () => {
  const applied = {
    ...value,
    state: "applied" as const,
    write_outcome: "written_verified" as const,
    version: artifact.version,
    artifact,
  };
  expect(importedArtifact(applied, null)).toBe(artifact);
  expect(importedArtifact({ ...applied, version: "b".repeat(64) }, null)).toBeNull();
  expect(importedArtifact({ ...applied, write_outcome: "unknown" }, null)).toBeNull();
  expect(
    importedArtifact({ ...applied, artifact: { ...artifact, path: "other.png" } }, null),
  ).toBeNull();
  expect(importedArtifact(value, artifact)).toBeNull();
});

test("the widget asks for the image in the side panel and offers no upload or approve control", () => {
  const snapshot: ActivitySnapshot = {
    instanceId: "fixture",
    seq: 3,
    sessions: [],
    imports: [value],
    entries: [entry({})],
  };
  const html = renderToStaticMarkup(
    <OverviewPanel
      snapshot={snapshot}
      bridge={{ mode: "workbench" } as WorkbenchBridge}
      file={null}
      search={null}
      artifact={null}
      mcpCall={null}
      workspaceName={() => "專案"}
      onFiles={() => {}}
      onSelect={() => {}}
    />,
  );
  expect(html).toContain("請在 Kairomes 側欄提供圖片");
  // The pill says 等待圖片 once and the title names the path once; neither is repeated.
  expect(html.match(/等待圖片/g)).toHaveLength(1);
  expect(html.match(/design\/cover\.png/g)).toHaveLength(1);
  expect(html).not.toContain('type="file"');
  expect(html).not.toContain("匯入圖片</button>");
  expect(html).not.toContain("拒絕");
});
