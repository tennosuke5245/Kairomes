import type { Artifact } from "@kairomes/protocol";
import { ImageIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { WorkbenchBridge } from "./bridge.ts";
import { InspectorHead, MetaLine, TechDetails } from "./detail-parts.tsx";
import { friendlyError } from "./errors.ts";
import { formatBytes, formatDimensions } from "./file-model.ts";
import { relativeTime } from "./time-format.ts";
import { iconProps } from "./ui-icons.tsx";

/** Below this size an image is enlarged with crisp pixels instead of shown as a dot. */
const TINY_IMAGE = 64;

/** 1280 × 720 · PNG · 184 KB */
export function artifactCaption(
  artifact: Pick<Artifact, "width" | "height" | "mime_type" | "byte_size">,
) {
  return [
    formatDimensions(artifact.width, artifact.height),
    artifact.mime_type.replace("image/", "").toUpperCase(),
    formatBytes(artifact.byte_size),
  ];
}

export function ArtifactPreview({
  artifact,
  bridge,
  compact = false,
}: {
  artifact: Artifact;
  bridge: WorkbenchBridge;
  compact?: boolean;
}) {
  const identity = `${artifact.workspace_id}:${artifact.path}:${artifact.version}`;
  const [preview, setPreview] = useState({ identity, url: "", error: "" });
  const { url, error } = preview.identity === identity ? preview : { url: "", error: "" };
  useEffect(() => {
    let stopped = false;
    let objectUrl = "";
    setPreview({ identity, url: "", error: "" });
    if (!bridge.loadArtifact) {
      setPreview({ identity, url: "", error: "請在本機工作台預覽圖片。" });
      return;
    }
    void bridge
      .loadArtifact(artifact)
      .then((next) => {
        objectUrl = next;
        if (stopped) URL.revokeObjectURL(next);
        else setPreview({ identity, url: next, error: "" });
      })
      .catch((cause) => {
        if (!stopped)
          setPreview({ identity, url: "", error: friendlyError(cause, "無法載入圖片預覽。") });
      });
    return () => {
      stopped = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact, bridge, identity]);
  const tiny = artifact.width < TINY_IMAGE && artifact.height < TINY_IMAGE;

  return (
    <figure className={`artifact-preview ${compact ? "compact" : ""}`}>
      <div className="artifact-stage">
        {url ? (
          <img
            src={url}
            alt={`工作區圖片 ${artifact.path}`}
            width={artifact.width}
            height={artifact.height}
            data-tiny={tiny ? "" : undefined}
          />
        ) : error ? (
          <div className="artifact-unavailable" role="status">
            <WarningCircleIcon {...iconProps("lg")} />
            <span>{error}</span>
          </div>
        ) : (
          <div className="artifact-loading" role="status">
            <ImageIcon {...iconProps("lg")} />
            <span>正在載入圖片…</span>
          </div>
        )}
      </div>
      <MetaLine items={artifactCaption(artifact)} className="artifact-caption" />
    </figure>
  );
}

export function ArtifactPanel({
  artifact,
  bridge,
  historical = false,
  busy = false,
  onReload,
}: {
  artifact: Artifact;
  bridge: WorkbenchBridge;
  historical?: boolean;
  busy?: boolean;
  onReload?(): void;
}) {
  return (
    <section className="wb-panel" aria-label={`圖片預覽 ${artifact.path}`}>
      <InspectorHead
        icon="image"
        verb="預覽"
        code={artifact.path}
        meta={[
          historical ? "執行時預覽" : "目前預覽",
          `修改於 ${relativeTime(artifact.modified_at, Date.now())}`,
        ]}
        actions={
          onReload && (
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              disabled={busy}
              onClick={onReload}
            >
              重新讀取
            </button>
          )
        }
      />
      <div className="insp-body">
        <ArtifactPreview artifact={artifact} bridge={bridge} />
        <TechDetails rows={[["版本", artifact.version]]} />
      </div>
    </section>
  );
}
