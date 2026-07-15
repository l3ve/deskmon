export type ScreenshotVisualMode =
  | "selecting"
  | "dragging"
  | "capturing"
  | "editing"
  | "blocked";

interface ScreenshotShadeState {
  showFullMask: boolean;
  showSelectionMask: boolean;
}

export const screenshotShadeState = (
  mode: ScreenshotVisualMode,
  hasSelection: boolean,
): ScreenshotShadeState => ({
  showFullMask: mode === "selecting" || mode === "blocked",
  showSelectionMask:
    hasSelection && (mode === "capturing" || mode === "editing"),
});
