import type { Dimensions, MonitorPayload, Point, Rect } from "../types";
import { clampPointToRect, monitorForPoint } from "./geometry";

export type ExternalNotificationPlacement = "right" | "left" | "below";

export interface ExternalNotificationLayout {
  windowPosition: Point;
  windowLogicalDimensions: Dimensions;
  petOffset: Point;
  notificationOffset: Point;
  notificationDimensions: Dimensions;
  notificationPlacement: ExternalNotificationPlacement;
}

interface CreateLayoutInput {
  petPosition: Point;
  petDimensions: Dimensions;
  petWindowDimensions: Dimensions;
  monitors: MonitorPayload[];
  fallbackArea: Rect;
  lockedPlacement?: ExternalNotificationPlacement;
}

interface PhysicalRect extends Rect {}

export const externalNotificationDialogWidth = 360;
export const externalNotificationDialogHeight = 152;
const presentationGap = 14;

export function createExternalNotificationLayout({
  petPosition,
  petDimensions,
  petWindowDimensions,
  monitors,
  fallbackArea,
  lockedPlacement,
}: CreateLayoutInput): ExternalNotificationLayout {
  const petCenter = {
    x: petPosition.x + petWindowDimensions.width * 0.5,
    y: petPosition.y + petWindowDimensions.height * 0.5,
  };
  const monitor = monitorForPoint(petCenter, monitors);
  const workArea = monitor?.workArea ?? fallbackArea;
  const scaleFactor = Math.max(
    1,
    monitor?.scaleFactor ?? petWindowDimensions.width / Math.max(1, petDimensions.width),
  );
  const notificationDimensions = {
    width: externalNotificationDialogWidth,
    height: externalNotificationDialogHeight,
  };
  const notificationPhysicalDimensions = {
    width: notificationDimensions.width * scaleFactor,
    height: notificationDimensions.height * scaleFactor,
  };
  const pet: PhysicalRect = { ...petPosition, ...petWindowDimensions };
  const gap = presentationGap * scaleFactor;
  const candidates = candidatePlacements(pet, notificationPhysicalDimensions, gap);
  const selected =
    candidates.find(({ placement }) => placement === lockedPlacement) ??
    candidates.find(({ rect }) => rectInside(rect, workArea)) ??
    candidates[candidates.length - 1]!;
  const notification = clampRectToArea(selected.rect, workArea);
  const groupLeft = Math.min(pet.x, notification.x);
  const groupTop = Math.min(pet.y, notification.y);
  const groupRight = Math.max(pet.x + pet.width, notification.x + notification.width);
  const groupBottom = Math.max(pet.y + pet.height, notification.y + notification.height);

  return {
    windowPosition: { x: groupLeft, y: groupTop },
    windowLogicalDimensions: {
      width: (groupRight - groupLeft) / scaleFactor,
      height: (groupBottom - groupTop) / scaleFactor,
    },
    petOffset: {
      x: (pet.x - groupLeft) / scaleFactor,
      y: (pet.y - groupTop) / scaleFactor,
    },
    notificationOffset: {
      x: (notification.x - groupLeft) / scaleFactor,
      y: (notification.y - groupTop) / scaleFactor,
    },
    notificationDimensions,
    notificationPlacement: selected.placement,
  };
}

function candidatePlacements(
  pet: PhysicalRect,
  dimensions: Dimensions,
  gap: number,
): Array<{ placement: ExternalNotificationPlacement; rect: PhysicalRect }> {
  const centerY = pet.y + pet.height * 0.5;
  const centerX = pet.x + pet.width * 0.5;
  return [
    {
      placement: "right",
      rect: {
        x: pet.x + pet.width + gap,
        y: centerY - dimensions.height * 0.5,
        ...dimensions,
      },
    },
    {
      placement: "left",
      rect: {
        x: pet.x - gap - dimensions.width,
        y: centerY - dimensions.height * 0.5,
        ...dimensions,
      },
    },
    {
      placement: "below",
      rect: {
        x: centerX - dimensions.width * 0.5,
        y: pet.y + pet.height + gap,
        ...dimensions,
      },
    },
  ];
}

function rectInside(rect: PhysicalRect, area: Rect): boolean {
  return (
    rect.x >= area.x &&
    rect.y >= area.y &&
    rect.x + rect.width <= area.x + area.width &&
    rect.y + rect.height <= area.y + area.height
  );
}

function clampRectToArea(rect: PhysicalRect, area: Rect): PhysicalRect {
  const position = clampPointToRect(rect, area, rect);
  return { ...position, width: rect.width, height: rect.height };
}
