import { describe, expect, it } from "vitest";
import { screenshotShadeState } from "./visualState";

describe("screenshot shade state", () => {
  it("dims the whole screen before selection and on non-owner monitors", () => {
    expect(screenshotShadeState("selecting", false)).toEqual({
      showFullMask: true,
      showSelectionMask: false,
    });
    expect(screenshotShadeState("blocked", false)).toEqual({
      showFullMask: true,
      showSelectionMask: false,
    });
  });

  it("keeps only the area outside the selection dimmed while editing", () => {
    expect(screenshotShadeState("capturing", true)).toEqual({
      showFullMask: false,
      showSelectionMask: true,
    });
    expect(screenshotShadeState("editing", true)).toEqual({
      showFullMask: false,
      showSelectionMask: true,
    });
  });
});
