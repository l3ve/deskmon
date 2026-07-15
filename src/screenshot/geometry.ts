export interface ScreenshotPoint {
  x: number;
  y: number;
}

export interface ScreenshotRect extends ScreenshotPoint {
  width: number;
  height: number;
}

export interface ScreenshotSize {
  width: number;
  height: number;
}

export interface ToolbarPlacement extends ScreenshotPoint {
  insideSelection: boolean;
}

const TOOLBAR_MARGIN = 8;
const TOOLBAR_GAP = 8;

export const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum));

export const clampPoint = (
  point: ScreenshotPoint,
  bounds: ScreenshotSize,
): ScreenshotPoint => ({
  x: clamp(point.x, 0, bounds.width),
  y: clamp(point.y, 0, bounds.height),
});

export const rectFromPoints = (
  start: ScreenshotPoint,
  end: ScreenshotPoint,
): ScreenshotRect => ({
  x: Math.min(start.x, end.x),
  y: Math.min(start.y, end.y),
  width: Math.abs(end.x - start.x),
  height: Math.abs(end.y - start.y),
});

export const isValidSelection = (rect: ScreenshotRect) =>
  rect.width >= 10 && rect.height >= 10;

export const placeToolbar = (
  selection: ScreenshotRect,
  toolbar: ScreenshotSize,
  viewport: ScreenshotSize,
): ToolbarPlacement => {
  const x = clamp(
    selection.x + (selection.width - toolbar.width) / 2,
    TOOLBAR_MARGIN,
    viewport.width - toolbar.width - TOOLBAR_MARGIN,
  );
  const below = selection.y + selection.height + TOOLBAR_GAP;
  if (below + toolbar.height <= viewport.height - TOOLBAR_MARGIN) {
    return { x, y: below, insideSelection: false };
  }

  const above = selection.y - TOOLBAR_GAP - toolbar.height;
  if (above >= TOOLBAR_MARGIN) {
    return { x, y: above, insideSelection: false };
  }

  return {
    x,
    y: clamp(
      selection.y + selection.height - toolbar.height - TOOLBAR_MARGIN,
      TOOLBAR_MARGIN,
      viewport.height - toolbar.height - TOOLBAR_MARGIN,
    ),
    insideSelection: true,
  };
};
