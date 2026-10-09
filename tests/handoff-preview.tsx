import { createRoot } from "react-dom/client";
import { HandoffFlow } from "../apps/desktop/src/handoff-flow.tsx";
import type { HandoffInput } from "../packages/protocol/src/handoff.ts";
import { createHandoffStudyApi } from "./handoff-study-api.ts";
import { HANDOFF_STUDY_WORKSPACE, studyMaterialId } from "./handoff-study-materials.ts";

// Visual/interactions only: no Tauri invoke, source reader, files, grant or host.
const workspace = {
  ...HANDOFF_STUDY_WORKSPACE,
  capabilities: [...HANDOFF_STUDY_WORKSPACE.capabilities],
};
const query = new URLSearchParams(location.search);
const study = query.has("study") ? studyMaterialId(query.get("study")) : null;
if (
  study &&
  (location.protocol !== "http:" ||
    location.hostname !== "127.0.0.1" ||
    "__TAURI_INTERNALS__" in window)
)
  throw new Error("Study fixture requires a standalone loopback browser page.");
const localApi = createHandoffStudyApi("alpha", {
  sourceStatus: query.has("blocked") ? "unknown" : "idle",
  itemsTruncated: query.has("items-truncated"),
  hasOlderTurns: !query.has("items-truncated"),
});
let changedBeforeCopy = false;
async function request<T>(input: HandoffInput): Promise<T> {
  if (study) {
    const response = await fetch("/synthetic-study/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ material: study, command: "handoff_request", input }),
      cache: "no-store",
    });
    const result: unknown = await response.json();
    if (!response.ok) {
      const message =
        result && typeof result === "object" && "message" in result ? result.message : null;
      throw new Error(typeof message === "string" ? message : "合成請求失敗。");
    }
    return result as T;
  }
  if (input.action === "prepare" && query.has("stale") && !changedBeforeCopy) {
    changedBeforeCopy = true;
    localApi.control("edit-file");
  }
  return (await localApi.request("handoff_request", input)) as T;
}
const root = document.querySelector<HTMLElement>("#root");
if (!root) throw new Error("Missing handoff fixture root");
createRoot(root).render(
  <div className="k-app desk-preview">
    <HandoffFlow workspace={workspace} onClose={() => {}} request={request} />
  </div>,
);
