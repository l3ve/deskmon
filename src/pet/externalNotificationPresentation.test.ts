import { describe, expect, it } from "vitest";
import type { MonitorPayload, Rect } from "../types";
import type { FocusPresentationLayout } from "./focusPresentation";
import {
  createExternalNotificationLayout,
  createExternalNotificationPresentation,
  externalNotificationDialogDimensions,
  externalNotificationEnterFrame,
  externalNotificationEnterMs,
} from "./externalNotificationPresentation";

const workArea: Rect = { x: 0, y: 0, width: 1600, height: 1000 };
const monitors: MonitorPayload[] = [
  {
    name: "main",
    position: { x: 0, y: 0 },
    size: { width: 1600, height: 1000 },
    workArea,
    scaleFactor: 2,
  },
];

describe("external notification presentation", () => {
  it("targets the cursor monitor center at the notification size", () => {
    const presentation = createExternalNotificationPresentation({
      startedAt: 100,
      petDimensions: { width: 104, height: 104 },
      petWindowDimensions: { width: 208, height: 208 },
      position: { x: 50, y: 60 },
      monitors,
      activityArea: workArea,
      coordinateScale: 2,
      targetPoint: { x: 1200, y: 500 },
    });
    expect(presentation?.targetWindowDimensions).toEqual({ width: 350, height: 350 });
    expect(presentation?.targetPetDimensions).toEqual({ width: 175, height: 175 });
    expect(presentation?.targetCenter).toEqual({ x: 800, y: 500 });
  });

  it("falls back to the pet monitor when the cursor cannot be matched", () => {
    const secondary: MonitorPayload = {
      name: "secondary",
      position: { x: 1600, y: 0 },
      size: { width: 1200, height: 900 },
      workArea: { x: 1600, y: 0, width: 1200, height: 860 },
      scaleFactor: 2,
    };
    const presentation = createExternalNotificationPresentation({
      startedAt: 100,
      petDimensions: { width: 104, height: 104 },
      petWindowDimensions: { width: 208, height: 208 },
      position: { x: 1800, y: 100 },
      monitors: [monitors[0]!, secondary],
      activityArea: workArea,
      coordinateScale: 2,
      targetPoint: { x: 9000, y: 9000 },
    });
    expect(presentation?.targetCenter).toEqual({ x: 2200, y: 430 });
  });

  it("interpolates from the current pet to the target", () => {
    const presentation = createExternalNotificationPresentation({
      startedAt: 100,
      petDimensions: { width: 100, height: 100 },
      petWindowDimensions: { width: 200, height: 200 },
      position: { x: 0, y: 0 },
      monitors,
      activityArea: workArea,
      coordinateScale: 2,
    })!;
    expect(externalNotificationEnterFrame(presentation, 0).center).toEqual({ x: 100, y: 100 });
    expect(externalNotificationEnterFrame(presentation, externalNotificationEnterMs).center).toEqual(
      presentation.targetCenter,
    );
  });

  it("lays out three dialogs without moving the pet away from center", () => {
    const target = {
      targetCenter: { x: 800, y: 500 },
      targetPetDimensions: { width: 175, height: 175 },
      targetWindowDimensions: { width: 350, height: 350 },
    };
    const layout = createExternalNotificationLayout(target, monitors, workArea, 3);
    expect(layout.notificationPlacement).toBe("right");
    expect(layout.notificationDimensions).toEqual(externalNotificationDialogDimensions(3));
    expect(layout.windowPosition.x + layout.petOffset.x * 2 + 175).toBe(800);
  });

  it("places notifications opposite an existing right-side focus dialog", () => {
    const target = {
      targetCenter: { x: 800, y: 500 },
      targetPetDimensions: { width: 175, height: 175 },
      targetWindowDimensions: { width: 350, height: 350 },
    };
    const focusLayout: FocusPresentationLayout = {
      windowPosition: { x: 625, y: 252 },
      windowLogicalDimensions: { width: 457, height: 248 },
      petOffset: { x: 0, y: 36.5 },
      petDimensions: { width: 175, height: 175 },
      dialogOffset: { x: 193, y: 0 },
      dialogDimensions: { width: 264, height: 248 },
      dialogPlacement: "right",
    };
    const layout = createExternalNotificationLayout(
      target,
      monitors,
      workArea,
      2,
      focusLayout,
    );
    expect(layout.notificationPlacement).toBe("left");
    expect(layout.focusDialogOffset).not.toBeNull();
  });
});
