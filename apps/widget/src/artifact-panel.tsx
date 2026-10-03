import type { Artifact } from "@kairomes/protocol";
import { ImageIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { WorkbenchBridge } from "./bridge.ts";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
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
          setPreview({
            identity,
            url: "",
            error: cause instanceof Error ? cause.message : "無法載入圖片預覽。",
          });
      });
    return () => {
      stopped = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact, bridge, identity]);

  return (
    <figure className={`artifact-preview ${compact ? "compact" : ""}`}>
      <div className="artifact-stage">
        {url ? (
          <img src={url} alt={`工作區產物 ${artifact.path}`} />
        ) : error ? (
          <div className="artifact-unavailable" role="status">
            <WarningCircleIcon weight="fill" />
            <span>{error}</span>
          </div>
        ) : (
          <div className="artifact-loading" role="status">
            <ImageIcon />
            <span>載入圖片…</span>
          </div>
        )}
      </div>
      <figcaption>
        <span>
          {artifact.width.toLocaleString()} × {artifact.height.toLocaleString()}
        </span>
        <span>{formatBytes(artifact.byte_size)}</span>
        <span>{artifact.mime_type.replace("image/", "").toUpperCase()}</span>
      </figcaption>
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
    <section className="signal-artifact-panel" aria-label={`圖片預覽 ${artifact.path}`}>
      <header>
        <h1>{artifact.path}</h1>
        {onReload && (
          <button type="button" disabled={busy} onClick={onReload}>
            重新讀取
          </button>
        )}
      </header>
      <ArtifactPreview artifact={artifact} bridge={bridge} />
      <dl className="artifact-details">
        <div>
          <dt>來源</dt>
          <dd>{historical ? "執行時預覽" : "目前預覽"}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd>
            <code title={artifact.version}>{artifact.version.slice(0, 12)}</code>
          </dd>
        </div>
        <div>
          <dt>最後修改</dt>
          <dd>{new Date(artifact.modified_at).toLocaleString()}</dd>
        </div>
      </dl>
    </section>
  );
}
