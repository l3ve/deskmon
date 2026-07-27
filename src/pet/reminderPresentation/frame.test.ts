import { describe, expect, it } from "vitest";
import {
  reminderFrameHeightForCardHeight,
  reminderFrameMinHeight,
} from "./frame";

describe("reminder frame height", () => {
  it("keeps short content at the compact minimum height", () => {
    expect(reminderFrameHeightForCardHeight(80)).toBe(
      reminderFrameMinHeight,
    );
    expect(reminderFrameHeightForCardHeight(116)).toBe(
      reminderFrameMinHeight,
    );
  });

  it("expands tall content on the four-pixel grid", () => {
    expect(reminderFrameHeightForCardHeight(117)).toBe(156);
    expect(reminderFrameHeightForCardHeight(181)).toBe(220);
  });
});
