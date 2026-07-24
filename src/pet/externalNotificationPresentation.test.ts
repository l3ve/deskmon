import { describe, expect, it } from "vitest";
import {
  createExternalNotificationLayout,
  externalNotificationDialogHeight,
  externalNotificationDialogWidth,
} from "./externalNotificationPresentation";

const monitor = {
  name: "main",
  position: { x: 0, y: 0 },
  size: { width: 1440, height: 900 },
  workArea: { x: 0, y: 0, width: 1440, height: 860 },
  scaleFactor: 1,
};

describe("external notification layout", () => {
  it("reserves the design footprint for the pixel bubble and its physical stack", () => {
    expect(externalNotificationDialogWidth).toBe(360);
    expect(externalNotificationDialogHeight).toBe(152);
  });

  it("keeps the pet in place and prefers the right side", () => {
    const layout = createExternalNotificationLayout({
      petPosition: { x: 200, y: 200 },
      petDimensions: { width: 104, height: 104 },
      petWindowDimensions: { width: 104, height: 104 },
      monitors: [monitor],
      fallbackArea: monitor.workArea,
    });

    expect(layout.notificationPlacement).toBe("right");
    expect(layout.windowPosition).toEqual({ x: 200, y: 176 });
    expect(layout.petOffset).toEqual({ x: 0, y: 24 });
  });

  it("falls back to the left near the right screen edge", () => {
    const layout = createExternalNotificationLayout({
      petPosition: { x: 1320, y: 300 },
      petDimensions: { width: 104, height: 104 },
      petWindowDimensions: { width: 104, height: 104 },
      monitors: [monitor],
      fallbackArea: monitor.workArea,
    });

    expect(layout.notificationPlacement).toBe("left");
    expect(layout.notificationOffset.x).toBe(0);
    expect(layout.petOffset.x).toBeGreaterThan(layout.notificationOffset.x);
  });

  it("uses the lower placement when neither side fits", () => {
    const narrow = {
      ...monitor,
      size: { width: 320, height: 800 },
      workArea: { x: 0, y: 0, width: 320, height: 760 },
    };
    const layout = createExternalNotificationLayout({
      petPosition: { x: 108, y: 100 },
      petDimensions: { width: 104, height: 104 },
      petWindowDimensions: { width: 104, height: 104 },
      monitors: [narrow],
      fallbackArea: narrow.workArea,
    });

    expect(layout.notificationPlacement).toBe("below");
    expect(layout.notificationOffset.y).toBeGreaterThan(layout.petOffset.y);
  });

  it("keeps the current side while dragging", () => {
    const layout = createExternalNotificationLayout({
      petPosition: { x: 1320, y: 300 },
      petDimensions: { width: 104, height: 104 },
      petWindowDimensions: { width: 104, height: 104 },
      monitors: [monitor],
      fallbackArea: monitor.workArea,
      lockedPlacement: "right",
    });

    expect(layout.notificationPlacement).toBe("right");
  });
});
