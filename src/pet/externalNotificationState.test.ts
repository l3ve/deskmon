import { describe, expect, it } from "vitest";
import {
  advanceExternalNotification,
  completeExternalNotificationReveal,
  createExternalNotificationState,
  enqueueExternalNotification,
  externalNotificationDurationMs,
  externalNotificationLayerCount,
  externalNotificationRevealComplete,
  externalNotificationsExpired,
  pauseExternalNotifications,
  resumeExternalNotifications,
  startExternalNotifications,
  visibleExternalNotificationText,
  type ExternalNotificationPayload,
} from "./externalNotificationState";

const normal = (text: string): ExternalNotificationPayload => ({
  title: "Deskmon",
  text,
  tone: "normal",
});

describe("external notification state", () => {
  it("plays notifications in FIFO order", () => {
    let state = createExternalNotificationState();
    state = enqueueExternalNotification(state, normal("第一条"), 0).state;
    state = enqueueExternalNotification(state, normal("第二条"), 1).state;
    state = startExternalNotifications(state, 10);
    expect(state.items[0]?.text).toBe("第一条");
    state = advanceExternalNotification(state, 100);
    expect(state.items[0]?.text).toBe("第二条");
  });

  it("keeps twenty entries and preserves the current message", () => {
    let state = createExternalNotificationState();
    state = enqueueExternalNotification(state, normal("当前"), 0).state;
    state = startExternalNotifications(state, 1);
    for (let index = 1; index <= 24; index += 1) {
      state = enqueueExternalNotification(state, normal(`消息 ${index}`), index + 10_000).state;
    }
    expect(state.items).toHaveLength(20);
    expect(state.items[0]?.text).toBe("当前");
    expect(state.items[state.items.length - 1]?.text).toBe("消息 24");
    expect(externalNotificationLayerCount(state)).toBe(4);
  });

  it("merges duplicates received in the duplicate window", () => {
    let state = createExternalNotificationState();
    state = enqueueExternalNotification(state, normal("相同"), 0).state;
    state = startExternalNotifications(state, 10);
    state = enqueueExternalNotification(state, normal("相同"), 100).state;
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.count).toBe(2);
    expect(state.expiresAt).toBe(4100);
  });

  it("uses four seconds for normal messages and eight for errors", () => {
    expect(externalNotificationDurationMs("normal")).toBe(4000);
    expect(externalNotificationDurationMs("error")).toBe(8000);
  });

  it("pauses without consuming display time", () => {
    let state = enqueueExternalNotification(
      createExternalNotificationState(),
      normal("暂停"),
      0,
    ).state;
    state = startExternalNotifications(state, 100);
    state = pauseExternalNotifications(state, 1100);
    expect(externalNotificationsExpired(state, 10_000)).toBe(false);
    state = resumeExternalNotifications(state, 3100);
    expect(externalNotificationsExpired(state, 6099)).toBe(false);
    expect(externalNotificationsExpired(state, 6100)).toBe(true);
  });

  it("can complete the typewriter before advancing", () => {
    let state = enqueueExternalNotification(
      createExternalNotificationState(),
      normal("逐字动画"),
      0,
    ).state;
    state = startExternalNotifications(state, 0);
    expect(visibleExternalNotificationText(state.items[0]!, 0)).toBe("逐");
    expect(externalNotificationRevealComplete(state.items[0]!, 0)).toBe(false);
    state = completeExternalNotificationReveal(state);
    expect(externalNotificationRevealComplete(state.items[0]!, 0)).toBe(true);
  });
});
