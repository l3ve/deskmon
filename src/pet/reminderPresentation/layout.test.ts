import { describe, expect, it } from "vitest";
import {
  createReminderLayout,
  reminderDialogHeight,
  reminderDialogWidth,
} from "./layout";

const monitor = {
  name: "main",
  position: { x: 0, y: 0 },
  size: { width: 1440, height: 900 },
  workArea: { x: 0, y: 0, width: 1440, height: 860 },
  scaleFactor: 1,
};

describe("reminder presentation layout", () => {
  it("reserves the design footprint for the pixel bubble and its physical stack", () => {
    expect(reminderDialogWidth).toBe(360);
    expect(reminderDialogHeight).toBe(152);
  });

  it("keeps the pet in place and prefers the right side", () => {
    const layout = createReminderLayout({
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

  it("uses the measured dialog height without moving the pet anchor", () => {
    const layout = createReminderLayout({
      petPosition: { x: 200, y: 200 },
      petDimensions: { width: 104, height: 104 },
      petWindowDimensions: { width: 104, height: 104 },
      monitors: [monitor],
      fallbackArea: monitor.workArea,
      notificationHeight: 220,
    });

    expect(layout.notificationDimensions.height).toBe(220);
    expect(layout.windowPosition).toEqual({ x: 200, y: 142 });
    expect(layout.petOffset).toEqual({ x: 0, y: 58 });
  });

  it("keeps a side placement clear of the pet along the bottom screen edge", () => {
    for (const notificationHeight of [152, 220]) {
      const layout = createReminderLayout({
        petPosition: { x: 500, y: 756 },
        petDimensions: { width: 104, height: 104 },
        petWindowDimensions: { width: 104, height: 104 },
        monitors: [monitor],
        fallbackArea: monitor.workArea,
        notificationHeight,
      });

      const petRight = layout.petOffset.x + 104;
      expect(layout.notificationPlacement).toBe("right");
      expect(layout.notificationOffset.x).toBeGreaterThanOrEqual(petRight + 14);
    }
  });

  it("falls back to the left near the right screen edge", () => {
    const layout = createReminderLayout({
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
    const layout = createReminderLayout({
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
    const layout = createReminderLayout({
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
