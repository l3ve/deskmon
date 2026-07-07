import type { Dimensions, MonitorPayload, Point, Rect, WindowFramePayload } from "../types";

export function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function centerOf(position: Point, dimensions: Dimensions): Point {
  return {
    x: position.x + dimensions.width * 0.5,
    y: position.y + dimensions.height * 0.5,
  };
}

export function topLeftFromCenter(center: Point, dimensions: Dimensions): Point {
  return {
    x: center.x - dimensions.width * 0.5,
    y: center.y - dimensions.height * 0.5,
  };
}

export function monitorForPoint(point: Point, monitors: MonitorPayload[]): MonitorPayload | null {
  return (
    monitors.find(
      (monitor) =>
        point.x >= monitor.workArea.x &&
        point.x <= monitor.workArea.x + monitor.workArea.width &&
        point.y >= monitor.workArea.y &&
        point.y <= monitor.workArea.y + monitor.workArea.height,
    ) ?? null
  );
}

export function cursorInsideFrame(frame: WindowFramePayload): boolean {
  return (
    frame.cursor.x >= frame.position.x &&
    frame.cursor.y >= frame.position.y &&
    frame.cursor.x <= frame.position.x + frame.size.width &&
    frame.cursor.y <= frame.position.y + frame.size.height
  );
}

export function near(a: Point, b: Point, threshold: number): boolean {
  return distance(a, b) <= threshold;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function moveTowards(current: Point, target: Point, maxDistance: number): Point {
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  const length = Math.hypot(dx, dy);
  if (length <= maxDistance || length === 0) {
    return target;
  }
  return {
    x: current.x + (dx / length) * maxDistance,
    y: current.y + (dy / length) * maxDistance,
  };
}

export function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

export function lerpPoint(start: Point, end: Point, progress: number): Point {
  return {
    x: lerp(start.x, end.x, progress),
    y: lerp(start.y, end.y, progress),
  };
}

export function lerpDimensions(
  start: Dimensions,
  end: Dimensions,
  progress: number,
): Dimensions {
  return {
    width: lerp(start.width, end.width, progress),
    height: lerp(start.height, end.height, progress),
  };
}

export function easeOutCubic(progress: number): number {
  const t = clamp(progress, 0, 1);
  return 1 - (1 - t) ** 3;
}

export function easeInOutCubic(progress: number): number {
  const t = clamp(progress, 0, 1);
  return t < 0.5 ? 4 * t ** 3 : 1 - ((-2 * t + 2) ** 3) / 2;
}

export function pointInsideRect(point: Point, rect: Rect, dimensions: Dimensions): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x + dimensions.width <= rect.x + rect.width &&
    point.y + dimensions.height <= rect.y + rect.height
  );
}

export function clampPointToRect(point: Point, rect: Rect, dimensions: Dimensions): Point {
  return {
    x: clamp(point.x, rect.x, Math.max(rect.x, rect.x + rect.width - dimensions.width)),
    y: clamp(point.y, rect.y, Math.max(rect.y, rect.y + rect.height - dimensions.height)),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
