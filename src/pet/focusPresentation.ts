import type { Dimensions, MonitorPayload, Point, Rect } from "../types";
import type { GiantCelebrationState } from "./giantCelebration";
import { clamp, monitorForPoint } from "./geometry";

export type FocusDialogPlacement = "right" | "left" | "below";

export interface FocusPresentationLayout {
  windowPosition: Point;
  windowLogicalDimensions: Dimensions;
  petOffset: Point;
  petDimensions: Dimensions;
  dialogOffset: Point;
  dialogDimensions: Dimensions;
  dialogPlacement: FocusDialogPlacement;
}

const dialogDimensions: Dimensions = { width: 264, height: 248 };
const gap = 18;

export function createFocusPresentationLayout(
  celebration: GiantCelebrationState,
  monitors: MonitorPayload[],
  fallbackArea: Rect,
): FocusPresentationLayout {
  const monitor = monitorForPoint(celebration.targetCenter, monitors);
  const workArea = monitor?.workArea ?? fallbackArea;
  const scaleFactor = Math.max(
    1,
    monitor?.scaleFactor ??
      celebration.targetWindowDimensions.width / celebration.targetPetDimensions.width,
  );
  const petPhysical = celebration.targetWindowDimensions;
  const petLeft = celebration.targetCenter.x - petPhysical.width * 0.5;
  const petTop = celebration.targetCenter.y - petPhysical.height * 0.5;
  const petRight = petLeft + petPhysical.width;
  const petBottom = petTop + petPhysical.height;
  const dialogPhysical = {
    width: dialogDimensions.width * scaleFactor,
    height: dialogDimensions.height * scaleFactor,
  };
  const physicalGap = gap * scaleFactor;

  let placement: FocusDialogPlacement = "right";
  let dialogLeft = petRight + physicalGap;
  let dialogTop = celebration.targetCenter.y - dialogPhysical.height * 0.5;

  if (dialogLeft + dialogPhysical.width > workArea.x + workArea.width) {
    const leftCandidate = petLeft - physicalGap - dialogPhysical.width;
    if (leftCandidate >= workArea.x) {
      placement = "left";
      dialogLeft = leftCandidate;
    } else {
      placement = "below";
      dialogLeft = celebration.targetCenter.x - dialogPhysical.width * 0.5;
      dialogTop = petBottom + physicalGap;
    }
  }

  dialogLeft = clamp(
    dialogLeft,
    workArea.x,
    Math.max(workArea.x, workArea.x + workArea.width - dialogPhysical.width),
  );
  dialogTop = clamp(
    dialogTop,
    workArea.y,
    Math.max(workArea.y, workArea.y + workArea.height - dialogPhysical.height),
  );

  const groupLeft = Math.min(petLeft, dialogLeft);
  const groupTop = Math.min(petTop, dialogTop);
  const groupRight = Math.max(petRight, dialogLeft + dialogPhysical.width);
  const groupBottom = Math.max(petBottom, dialogTop + dialogPhysical.height);

  return {
    windowPosition: { x: groupLeft, y: groupTop },
    windowLogicalDimensions: {
      width: (groupRight - groupLeft) / scaleFactor,
      height: (groupBottom - groupTop) / scaleFactor,
    },
    petOffset: {
      x: (petLeft - groupLeft) / scaleFactor,
      y: (petTop - groupTop) / scaleFactor,
    },
    petDimensions: { ...celebration.targetPetDimensions },
    dialogOffset: {
      x: (dialogLeft - groupLeft) / scaleFactor,
      y: (dialogTop - groupTop) / scaleFactor,
    },
    dialogDimensions: { ...dialogDimensions },
    dialogPlacement: placement,
  };
}

export function presentationMonitorIsAvailable(
  celebration: GiantCelebrationState,
  monitors: MonitorPayload[],
): boolean {
  return monitorForPoint(celebration.targetCenter, monitors) !== null;
}
