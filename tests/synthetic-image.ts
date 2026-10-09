// A synthetic placeholder figure drawn in the page (no user content), encoded as real PNG
// bytes, with transparent corners so the preview's checkerboard shows. Browser fixtures only.
export async function syntheticFigurePng(width = 960, height = 600, label = "合成示意圖") {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D context for the synthetic figure");
  const radius = Math.round(Math.min(width, height) * 0.08);
  context.beginPath();
  context.roundRect(0, 0, width, height, radius);
  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#f3e3c8");
  sky.addColorStop(1, "#e7b98f");
  context.fillStyle = sky;
  context.fill();
  context.save();
  context.clip();
  context.fillStyle = "#f7f1e6";
  context.beginPath();
  context.arc(width * 0.72, height * 0.32, Math.min(width, height) * 0.13, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#a8233f";
  context.beginPath();
  context.moveTo(0, height);
  context.lineTo(width * 0.3, height * 0.45);
  context.lineTo(width * 0.55, height * 0.8);
  context.lineTo(width * 0.7, height * 0.6);
  context.lineTo(width, height);
  context.fill();
  context.fillStyle = "#5c1426";
  context.beginPath();
  context.moveTo(width * 0.15, height);
  context.lineTo(width * 0.42, height * 0.62);
  context.lineTo(width * 0.75, height);
  context.fill();
  context.restore();
  context.fillStyle = "rgb(31 27 28 / 0.72)";
  context.font = `600 ${Math.round(height * 0.06)}px system-ui, sans-serif`;
  context.fillText(label, radius * 0.9, radius * 1.4);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

/** The figure as a File, the way a paste or a drop hands it over. */
export async function syntheticFigureFile(name = "image.png", width = 960, height = 600) {
  return new File([await syntheticFigurePng(width, height)], name, { type: "image/png" });
}
