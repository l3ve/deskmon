import type { Dimensions, MonitorPayload, Point, Rect } from "../types";
import type { FocusPresentationLayout } from "./focusPresentation";
import {
  centerOf,
  clamp,
  clampPointToRect,
  easeInOutCubic,
  easeOutCubic,
  lerpDimensions,
  lerpPoint,
  monitorForPoint,
  topLeftFromCenter,
} from "./geometry";

export type ExternalNotificationPlacement = "right" | "left" | "below";

export interface ExternalNotificationPresentationState {
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

export interface ExternalNotificationPresentationFrame {
  center: Point;
  petDimensions: Dimensions;
  windowDimensions: Dimensions;
  alwaysOnTop: boolean;
}

export interface ExternalNotificationLayout {
  windowPosition: Point;
  windowLogicalDimensions: Dimensions;
  petOffset: Point;
  petDimensions: Dimensions;
  notificationOffset: Point;
  notificationDimensions: Dimensions;
  notificationPlacement: ExternalNotificationPlacement;
  focusDialogOffset: Point | null;
}

interface CreatePresentationInput {
  startedAt: number;
  petDimensions: Dimensions;
  petWindowDimensions: Dimensions;
  position: Point;
  monitors: MonitorPayload[];
  activityArea: Rect;
  coordinateScale: number;
  targetPoint?: Point;
}

interface PresentationTarget {
  targetCenter: Point;
  targetPetDimensions: Dimensions;
  targetWindowDimensions: Dimensions;
}

interface PhysicalRect extends Rect {}

export const externalNotificationEnterMs = 600;
export const externalNotificationRestoreMs = 500;
export const externalNotificationSyncIntervalMs = 33;
export const externalNotificationDialogWidth = 284;
export const externalNotificationDialogRowHeight = 104;
export const externalNotificationDialogGap = 10;
const presentationGap = 18;
const minPhysicalSize = 280;
const maxPhysicalSize = 460;

export function createExternalNotificationPresentation({
  startedAt,
  petDimensions,
  petWindowDimensions,
  position,
  monitors,
  activityArea,
  coordinateScale,
  targetPoint,
}: CreatePresentationInput): ExternalNotificationPresentationState | null {
  const normalPetDimensions = { ...petDimensions };
  const normalWindowDimensions = { ...petWindowDimensions };
  const normalCenter = centerOf(position, normalWindowDimensions);
  const monitor =
    (targetPoint ? monitorForPoint(targetPoint, monitors) : null) ??
    monitorForPoint(normalCenter, monitors) ??
    monitors[0];
  const workArea = monitor?.workArea ?? activityArea;
  const scaleFactor = monitor?.scaleFactor ?? coordinateScale;
  const physicalLimit = Math.max(1, Math.min(workArea.width, workArea.height));
  const targetSide = Math.min(
    physicalLimit,
    clamp(
      physicalLimit * 0.35,
      Math.min(minPhysicalSize, physicalLimit),
      Math.min(maxPhysicalSize, physicalLimit),
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
  const targetPosition = clampPointToRect(
    {
      x: workArea.x + workArea.width * 0.5 - targetWindowDimensions.width * 0.5,
      y: workArea.y + workArea.height * 0.5 - targetWindowDimensions.height * 0.5,
    },
    workArea,
    targetWindowDimensions,
  );

  return {
    startedAt,
    normalCenter,
    normalPetDimensions,
    normalWindowDimensions,
    targetCenter: centerOf(targetPosition, targetWindowDimensions),
    targetPetDimensions,
    targetWindowDimensions,
    restorePetDimensions: normalPetDimensions,
    restoreWindowDimensions: normalWindowDimensions,
    lastPresentationSync: 0,
  };
}

export function externalNotificationEnterFrame(
  presentation: ExternalNotificationPresentationState,
  elapsed: number,
): ExternalNotificationPresentationFrame {
  const progress = easeOutCubic(elapsed / externalNotificationEnterMs);
  return {
    center: lerpPoint(presentation.normalCenter, presentation.targetCenter, progress),
    petDimensions: lerpDimensions(
      presentation.normalPetDimensions,
      presentation.targetPetDimensions,
      progress,
    ),
    windowDimensions: lerpDimensions(
      presentation.normalWindowDimensions,
      presentation.targetWindowDimensions,
      progress,
    ),
    alwaysOnTop: true,
  };
}

export function externalNotificationRestoreFrame(
  presentation: ExternalNotificationPresentationState,
  restoreTarget: ExternalNotificationPresentationFrame,
  elapsed: number,
): ExternalNotificationPresentationFrame {
  const progress = easeInOutCubic(elapsed / externalNotificationRestoreMs);
  return {
    center: lerpPoint(presentation.targetCenter, restoreTarget.center, progress),
    petDimensions: lerpDimensions(
      presentation.targetPetDimensions,
      restoreTarget.petDimensions,
      progress,
    ),
    windowDimensions: lerpDimensions(
      presentation.targetWindowDimensions,
      restoreTarget.windowDimensions,
      progress,
    ),
    alwaysOnTop: true,
  };
}

export function externalNotificationRestoreTarget(
  presentation: ExternalNotificationPresentationState,
  monitors: MonitorPayload[],
  activityArea: Rect,
  alwaysOnTop: boolean,
): ExternalNotificationPresentationFrame {
  const workArea =
    monitorForPoint(presentation.normalCenter, monitors)?.workArea ??
    monitors[0]?.workArea ??
    activityArea;
  const position = clampPointToRect(
    topLeftFromCenter(presentation.normalCenter, presentation.restoreWindowDimensions),
    workArea,
    presentation.restoreWindowDimensions,
  );
  return {
    center: centerOf(position, presentation.restoreWindowDimensions),
    petDimensions: presentation.restorePetDimensions,
    windowDimensions: presentation.restoreWindowDimensions,
    alwaysOnTop,
  };
}

export function externalNotificationDialogDimensions(itemCount: number): Dimensions {
  const count = clamp(Math.round(itemCount), 1, 3);
  return {
    width: externalNotificationDialogWidth,
    height:
      count * externalNotificationDialogRowHeight +
      Math.max(0, count - 1) * externalNotificationDialogGap,
  };
}

export function createExternalNotificationLayout(
  presentation: PresentationTarget,
  monitors: MonitorPayload[],
  fallbackArea: Rect,
  itemCount: number,
  focusLayout: FocusPresentationLayout | null = null,
): ExternalNotificationLayout {
  const monitor = monitorForPoint(presentation.targetCenter, monitors);
  const workArea = monitor?.workArea ?? fallbackArea;
  const scaleFactor = Math.max(
    1,
    monitor?.scaleFactor ??
      presentation.targetWindowDimensions.width / presentation.targetPetDimensions.width,
  );
  const petPhysical: PhysicalRect = {
    x: presentation.targetCenter.x - presentation.targetWindowDimensions.width * 0.5,
    y: presentation.targetCenter.y - presentation.targetWindowDimensions.height * 0.5,
    ...presentation.targetWindowDimensions,
  };
  const notificationDimensions = externalNotificationDialogDimensions(itemCount);
  const notificationPhysicalDimensions = {
    width: notificationDimensions.width * scaleFactor,
    height: notificationDimensions.height * scaleFactor,
  };
  const physicalGap = presentationGap * scaleFactor;
  const focusPhysical = focusLayout
    ? {
        x: focusLayout.windowPosition.x + focusLayout.dialogOffset.x * scaleFactor,
        y: focusLayout.windowPosition.y + focusLayout.dialogOffset.y * scaleFactor,
        width: focusLayout.dialogDimensions.width * scaleFactor,
        height: focusLayout.dialogDimensions.height * scaleFactor,
      }
    : null;

  const candidates = candidatePlacements(
    petPhysical,
    notificationPhysicalDimensions,
    physicalGap,
    focusLayout,
  );
  const selected =
    candidates.find(
      ({ rect }) => rectInside(rect, workArea) && (!focusPhysical || !rectsOverlap(rect, focusPhysical)),
    ) ?? candidates[candidates.length - 1]!;
  const notificationPhysical = clampRectToArea(selected.rect, workArea);

  const bounds = [petPhysical, notificationPhysical, ...(focusPhysical ? [focusPhysical] : [])];
  const groupLeft = Math.min(...bounds.map((rect) => rect.x));
  const groupTop = Math.min(...bounds.map((rect) => rect.y));
  const groupRight = Math.max(...bounds.map((rect) => rect.x + rect.width));
  const groupBottom = Math.max(...bounds.map((rect) => rect.y + rect.height));

  return {
    windowPosition: { x: groupLeft, y: groupTop },
    windowLogicalDimensions: {
      width: (groupRight - groupLeft) / scaleFactor,
      height: (groupBottom - groupTop) / scaleFactor,
    },
    petOffset: {
      x: (petPhysical.x - groupLeft) / scaleFactor,
      y: (petPhysical.y - groupTop) / scaleFactor,
    },
    petDimensions: { ...presentation.targetPetDimensions },
    notificationOffset: {
      x: (notificationPhysical.x - groupLeft) / scaleFactor,
      y: (notificationPhysical.y - groupTop) / scaleFactor,
    },
    notificationDimensions,
    notificationPlacement: selected.placement,
    focusDialogOffset: focusPhysical
      ? {
          x: (focusPhysical.x - groupLeft) / scaleFactor,
          y: (focusPhysical.y - groupTop) / scaleFactor,
        }
      : null,
  };
}

function candidatePlacements(
  pet: PhysicalRect,
  dimensions: Dimensions,
  gap: number,
  focusLayout: FocusPresentationLayout | null,
): Array<{ placement: ExternalNotificationPlacement; rect: PhysicalRect }> {
  const centerY = pet.y + pet.height * 0.5;
  const centerX = pet.x + pet.width * 0.5;
  const candidates = {
    right: {
      placement: "right" as const,
      rect: {
        x: pet.x + pet.width + gap,
        y: centerY - dimensions.height * 0.5,
        ...dimensions,
      },
    },
    left: {
      placement: "left" as const,
      rect: {
        x: pet.x - gap - dimensions.width,
        y: centerY - dimensions.height * 0.5,
        ...dimensions,
      },
    },
    below: {
      placement: "below" as const,
      rect: {
        x: centerX - dimensions.width * 0.5,
        y: pet.y + pet.height + gap,
        ...dimensions,
      },
    },
  };
  if (focusLayout?.dialogPlacement === "right") {
    return [candidates.left, candidates.below, candidates.right];
  }
  if (focusLayout?.dialogPlacement === "left") {
    return [candidates.right, candidates.below, candidates.left];
  }
  return [candidates.right, candidates.left, candidates.below];
}

function rectInside(rect: PhysicalRect, area: Rect): boolean {
  return (
    rect.x >= area.x &&
    rect.y >= area.y &&
    rect.x + rect.width <= area.x + area.width &&
    rect.y + rect.height <= area.y + area.height
  );
}

function rectsOverlap(a: PhysicalRect, b: PhysicalRect): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function clampRectToArea(rect: PhysicalRect, area: Rect): PhysicalRect {
  const position = clampPointToRect(rect, area, rect);
  return { ...position, width: rect.width, height: rect.height };
}
