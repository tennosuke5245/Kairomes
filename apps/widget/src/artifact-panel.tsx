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
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    let objectUrl = "";
    setUrl("");
    setError("");
    if (!bridge.loadArtifact) {
      setError("圖片內容只能在已配對的本機工作台預覽；檔案資訊仍可在這裡查看。");
      return;
    }
    void bridge
      .loadArtifact(artifact)
      .then((next) => {
        objectUrl = next;
        if (stopped) URL.revokeObjectURL(next);
        else setUrl(next);
      })
      .catch((cause) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : "無法載入圖片預覽。");
      });
    return () => {
      stopped = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact, bridge]);

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
            <span>正在準備安全預覽…</span>
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
}: {
  artifact: Artifact;
  bridge: WorkbenchBridge;
}) {
  return (
    <section className="signal-artifact-panel" aria-label={`圖片預覽 ${artifact.path}`}>
      <header>
        <span>WORKSPACE ARTIFACT</span>
        <h1>{artifact.path}</h1>
        <p>已核對實際格式與檔案版本；這份預覽只從目前掛載的工作區讀取。</p>
      </header>
      <ArtifactPreview artifact={artifact} bridge={bridge} />
      <dl className="artifact-details">
        <div>
          <dt>版本</dt>
          <dd>{artifact.version.slice(0, 12)}</dd>
        </div>
        <div>
          <dt>最後修改</dt>
          <dd>{new Date(artifact.modified_at).toLocaleString()}</dd>
        </div>
      </dl>
    </section>
  );
}
