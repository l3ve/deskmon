import type { Dimensions, MonitorPayload, Point, Rect } from "../types";
import {
  centerOf,
  clamp,
  clampPointToRect,
  easeInOutCubic,
  easeOutCubic,
  lerp,
  lerpDimensions,
  lerpPoint,
  monitorForPoint,
  topLeftFromCenter,
} from "./geometry";

export interface GiantCelebrationState {
  startedAt: number;
  normalCenter: Point;
  normalPetDimensions: Dimensions;
  normalWindowDimensions: Dimensions;
  targetCenter: Point;
  targetPetDimensions: Dimensions;
  targetWindowDimensions: Dimensions;
  restorePetDimensions: Dimensions;
  restoreWindowDimensions: Dimensions;
  lastPresentationSync: number;
}

export interface GiantPresentationFrame {
  center: Point;
  petDimensions: Dimensions;
  windowDimensions: Dimensions;
  alwaysOnTop: boolean;
}

export interface TemporaryPetPresentation {
  position: Point;
  dimensions: Dimensions;
  alwaysOnTop: boolean;
}

interface CreateGiantCelebrationInput {
  startedAt: number;
  petDimensions: Dimensions;
  petWindowDimensions: Dimensions;
  position: Point;
  monitors: MonitorPayload[];
  activityArea: Rect;
  coordinateScale: number;
}

const giantCelebrationEnterMs = 3000;
const giantCelebrationHoldMs = 3000;
const giantCelebrationRestoreMs = 1000;
const giantCelebrationMinPhysicalSize = 320;
const giantCelebrationMaxPhysicalSize = 560;

export const giantCelebrationTotalMs =
  giantCelebrationEnterMs + giantCelebrationHoldMs + giantCelebrationRestoreMs;
export const giantPresentationSyncIntervalMs = 33;

export function createGiantCelebration({
  startedAt,
  petDimensions,
  petWindowDimensions,
  position,
  monitors,
  activityArea,
  coordinateScale,
}: CreateGiantCelebrationInput): GiantCelebrationState | null {
  const normalPetDimensions = { ...petDimensions };
  const normalWindowDimensions = { ...petWindowDimensions };
  const normalCenter = centerOf(position, normalWindowDimensions);
  const monitor = monitorForPoint(normalCenter, monitors) ?? monitors[0];
  const workArea = monitor?.workArea ?? activityArea;
  const scaleFactor = monitor?.scaleFactor ?? coordinateScale;
  const physicalLimit = Math.max(1, Math.min(workArea.width, workArea.height));
  const targetSide = Math.min(
    physicalLimit,
    clamp(
      physicalLimit * 0.45,
      Math.min(giantCelebrationMinPhysicalSize, physicalLimit),
      Math.min(giantCelebrationMaxPhysicalSize, physicalLimit),
    ),
  );
  if (targetSide <= 0 || scaleFactor <= 0) {
    return null;
  }

  const targetWindowDimensions = { width: targetSide, height: targetSide };
  const targetPetDimensions = {
    width: targetSide / scaleFactor,
    height: targetSide / scaleFactor,
  };
  const sizeProgress = clamp(
    (targetSide - giantCelebrationMinPhysicalSize) /
      (giantCelebrationMaxPhysicalSize - giantCelebrationMinPhysicalSize),
    0,
    1,
  );
  const targetCenter = centerOf(
    clampPointToRect(
      {
        x: workArea.x + workArea.width * 0.5 - targetWindowDimensions.width * 0.5,
        y:
          workArea.y +
          workArea.height * lerp(0.58, 0.52, sizeProgress) -
          targetWindowDimensions.height * 0.5,
      },
      workArea,
      targetWindowDimensions,
    ),
    targetWindowDimensions,
  );

  return {
    startedAt,
    normalCenter,
    normalPetDimensions,
    normalWindowDimensions,
    targetCenter,
    targetPetDimensions,
    targetWindowDimensions,
    restorePetDimensions: normalPetDimensions,
    restoreWindowDimensions: normalWindowDimensions,
    lastPresentationSync: 0,
  };
}

export function getGiantPresentationFrame(
  celebration: GiantCelebrationState,
  elapsed: number,
  restoreTarget: GiantPresentationFrame,
): GiantPresentationFrame {
  if (elapsed < giantCelebrationEnterMs) {
    const progress = easeOutCubic(elapsed / giantCelebrationEnterMs);
    return {
      center: lerpPoint(celebration.normalCenter, celebration.targetCenter, progress),
      petDimensions: lerpDimensions(
        celebration.normalPetDimensions,
        celebration.targetPetDimensions,
        progress,
      ),
      windowDimensions: lerpDimensions(
        celebration.normalWindowDimensions,
        celebration.targetWindowDimensions,
        progress,
      ),
      alwaysOnTop: true,
    };
  }

  if (elapsed < giantCelebrationEnterMs + giantCelebrationHoldMs) {
    return {
      center: celebration.targetCenter,
      petDimensions: celebration.targetPetDimensions,
      windowDimensions: celebration.targetWindowDimensions,
      alwaysOnTop: true,
    };
  }

  const progress = easeInOutCubic(
    (elapsed - giantCelebrationEnterMs - giantCelebrationHoldMs) /
      giantCelebrationRestoreMs,
  );
  return {
    center: lerpPoint(celebration.targetCenter, restoreTarget.center, progress),
    petDimensions: lerpDimensions(
      celebration.targetPetDimensions,
      restoreTarget.petDimensions,
      progress,
    ),
    windowDimensions: lerpDimensions(
      celebration.targetWindowDimensions,
      restoreTarget.windowDimensions,
      progress,
    ),
    alwaysOnTop: true,
  };
}

export function getGiantRestoreTarget(
  celebration: GiantCelebrationState,
  monitors: MonitorPayload[],
  activityArea: Rect,
  alwaysOnTop: boolean,
): GiantPresentationFrame {
  const workArea =
    monitorForPoint(celebration.normalCenter, monitors)?.workArea ?? activityArea;
  const position = clampPointToRect(
    topLeftFromCenter(celebration.normalCenter, celebration.restoreWindowDimensions),
    workArea,
    celebration.restoreWindowDimensions,
  );
  return {
    center: centerOf(position, celebration.restoreWindowDimensions),
    petDimensions: celebration.restorePetDimensions,
    windowDimensions: celebration.restoreWindowDimensions,
    alwaysOnTop,
  };
}
