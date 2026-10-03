import { expect, test } from "bun:test";
import type { Artifact } from "@kairomes/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactPanel } from "./artifact-panel.tsx";
import type { WorkbenchBridge } from "./bridge.ts";

const artifact: Artifact = {
  kind: "artifact",
  artifact_id: "10000000-0000-4000-8000-000000000002",
  workspace_id: "10000000-0000-4000-8000-000000000001",
  path: "preview.png",
  version: "a".repeat(64),
  modified_at: 0,
  byte_size: 100,
  mime_type: "image/png",
  media_kind: "image",
  previewable: true,
  width: 200,
  height: 100,
};

test("a historical image offers one current reread action while retaining historical identity", () => {
  const html = renderToStaticMarkup(
    <ArtifactPanel
      artifact={artifact}
      bridge={{ mode: "workbench" } as WorkbenchBridge}
      historical
      busy
      onReload={() => {}}
    />,
  );
  expect(html.match(/重新讀取/g)?.length).toBe(1);
  expect(html).toContain("執行時預覽");
  expect(html).not.toContain("目前預覽");
  expect(html).toContain(`title="${artifact.version}"`);
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重新讀取<\/button>/);
  const current = renderToStaticMarkup(
    <ArtifactPanel artifact={artifact} bridge={{ mode: "workbench" } as WorkbenchBridge} />,
  );
  expect(current).toContain("目前預覽");
  expect(current).not.toContain("重新讀取");
});
