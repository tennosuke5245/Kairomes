/** The inspector is a flush pane: no gutter after it (design spec §5.3, shot e2). */
export const INSPECTOR_LAYOUT = { min: 320, max: 760, canvasMin: 320, handle: 8, gutter: 0 };

export function inspectorBounds(containerWidth: number) {
  const { min, max, canvasMin, handle, gutter } = INSPECTOR_LAYOUT;
  return { min, max: Math.max(min, Math.min(max, containerWidth - canvasMin - handle - gutter)) };
}

export function boundedInspectorWidth(width: number, bounds: { min: number; max: number }) {
  return Math.min(bounds.max, Math.max(bounds.min, Number.isFinite(width) ? width : 410));
}

export function inspectorKeyWidth(
  key: string,
  width: number,
  bounds: { min: number; max: number },
) {
  const next =
    key === "ArrowLeft"
      ? width + 24
      : key === "ArrowRight"
        ? width - 24
        : key === "Home"
          ? bounds.min
          : key === "End"
            ? bounds.max
            : undefined;
  return next === undefined ? undefined : boundedInspectorWidth(next, bounds);
}
