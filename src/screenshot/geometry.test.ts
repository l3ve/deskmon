import { describe, expect, it } from "vitest";
import {
  clampPoint,
  isValidSelection,
  placeToolbar,
  rectFromPoints,
} from "./geometry";

describe("screenshot geometry", () => {
  it("normalizes all drag directions", () => {
    expect(rectFromPoints({ x: 80, y: 50 }, { x: 20, y: 10 })).toEqual({
      x: 20,
      y: 10,
      width: 60,
      height: 40,
    });
  });

  it("clamps pointers to the starting monitor", () => {
    expect(clampPoint({ x: -4, y: 900 }, { width: 600, height: 500 })).toEqual({
      x: 0,
      y: 500,
    });
  });

  it("rejects either dimension below ten pixels", () => {
    expect(isValidSelection({ x: 0, y: 0, width: 10, height: 10 })).toBe(true);
    expect(isValidSelection({ x: 0, y: 0, width: 9, height: 20 })).toBe(false);
    expect(isValidSelection({ x: 0, y: 0, width: 20, height: 9 })).toBe(false);
  });

  it("places the toolbar below, above, then inside as space shrinks", () => {
    expect(
      placeToolbar(
        { x: 100, y: 100, width: 200, height: 100 },
        { width: 160, height: 40 },
        { width: 500, height: 500 },
      ),
    ).toEqual({ x: 120, y: 208, insideSelection: false });
    expect(
      placeToolbar(
        { x: 100, y: 440, width: 200, height: 50 },
        { width: 160, height: 40 },
        { width: 500, height: 500 },
      ),
    ).toEqual({ x: 120, y: 392, insideSelection: false });
    expect(
      placeToolbar(
        { x: 0, y: 0, width: 500, height: 500 },
        { width: 300, height: 80 },
        { width: 500, height: 500 },
      ).insideSelection,
    ).toBe(true);
  });
});
