import { describe, expect, it } from "vitest";
import {
  externalNotificationFrameHeightForCardHeight,
  externalNotificationFrameMinHeight,
} from "./externalNotificationFrame";

describe("external notification frame height", () => {
  it("keeps short content at the compact minimum height", () => {
    expect(externalNotificationFrameHeightForCardHeight(80)).toBe(
      externalNotificationFrameMinHeight,
    );
    expect(externalNotificationFrameHeightForCardHeight(116)).toBe(
      externalNotificationFrameMinHeight,
    );
  });

  it("expands tall content on the four-pixel grid", () => {
    expect(externalNotificationFrameHeightForCardHeight(117)).toBe(156);
    expect(externalNotificationFrameHeightForCardHeight(181)).toBe(220);
  });
});
