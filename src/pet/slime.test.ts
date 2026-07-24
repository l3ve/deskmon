import { describe, expect, it } from "vitest";
import { spriteFrameRenderScales } from "./slime";

describe("sprite frame render scales", () => {
  it("keeps a celebration body at its normal target size when particles widen the frame", () => {
    const scales = spriteFrameRenderScales({
      sourceWidth: 384,
      sourceHeight: 237,
      anchorWidth: 216,
      anchorHeight: 213,
    });

    expect(scales.effect * 216).toBeLessThan(16);
    expect(scales.body * 216).toBeCloseTo(25.35, 1);
    expect(scales.body * 213).toBeCloseTo(25, 1);
  });

  it("uses one scale when the body already fills the source frame", () => {
    const scales = spriteFrameRenderScales({
      sourceWidth: 248,
      sourceHeight: 232,
      anchorWidth: 248,
      anchorHeight: 232,
    });

    expect(scales.body).toBeCloseTo(scales.effect);
  });
});
