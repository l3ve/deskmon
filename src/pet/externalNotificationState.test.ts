import { describe, expect, it } from "vitest";
import {
  clearExternalNotifications,
  createExternalNotificationState,
  enqueueExternalNotification,
  externalNotificationCountLabel,
  externalNotificationDurationMs,
  externalNotificationsExpired,
  normalizeExternalNotification,
  pauseExternalNotifications,
  splitGraphemes,
  startExternalNotifications,
  visibleExternalNotificationText,
} from "./externalNotificationState";

describe("external notification text", () => {
  it("normalizes whitespace and keeps at most three paragraphs", () => {
    expect(
      normalizeExternalNotification({
        title: "  Codex\n完成  ",
        text: " 第一段 \n\n 第二段\n第三段\n第四段 ",
      }),
    ).toEqual({
      title: "Codex 完成",
      text: "第一段\n第二段\n第三段 第四段",
    });
  });

  it("ignores empty body even when a title exists", () => {
    expect(normalizeExternalNotification({ title: "Codex", text: " \n " })).toBeNull();
  });

  it("truncates title and body by complete graphemes with an ellipsis", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(splitGraphemes(family)).toEqual([family]);
    const normalized = normalizeExternalNotification({
      title: `123456789${family}尾`,
      text: `${"好".repeat(49)}${family}尾`,
    });
    expect(splitGraphemes(normalized?.title ?? "")).toHaveLength(10);
    expect(normalized?.title).toBe("123456789…");
    expect(splitGraphemes(normalized?.text ?? "")).toHaveLength(50);
    expect(normalized?.text).toBe(`${"好".repeat(49)}…`);
  });

  it("keeps markup and URLs as plain display text", () => {
    expect(
      normalizeExternalNotification({
        title: "<b>构建</b>",
        text: "**完成** https://example.com",
      }),
    ).toEqual({
      title: "<b>构建</b>",
      text: "**完成** https://example.com",
    });
  });
});

describe("external notification state", () => {
  it("keeps three newest items and replaces the oldest", () => {
    let state = createExternalNotificationState();
    for (const text of ["一", "二", "三", "四"]) {
      state = enqueueExternalNotification(state, { title: null, text }, 1000).state;
    }
    expect(state.items.map((item) => item.text)).toEqual(["二", "三", "四"]);
  });

  it("deduplicates within ten seconds and caps the visible count", () => {
    let state = createExternalNotificationState();
    state = enqueueExternalNotification(state, { title: "Codex", text: "完成" }, 1000).state;
    for (let index = 0; index < 120; index += 1) {
      state = enqueueExternalNotification(
        state,
        { title: "Codex", text: "完成" },
        1001 + index,
      ).state;
    }
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.count).toBe(100);
    expect(externalNotificationCountLabel(state.items[0]?.count ?? 0)).toBe("×99+");
  });

  it("deduplicates normalized content but keeps different titles separate", () => {
    let state = createExternalNotificationState();
    state = enqueueExternalNotification(
      state,
      { title: " Codex\n任务 ", text: " 构建   完成 " },
      1000,
    ).state;
    state = enqueueExternalNotification(
      state,
      { title: "Codex 任务", text: "构建 完成" },
      2000,
    ).state;
    state = enqueueExternalNotification(
      state,
      { title: "CI", text: "构建 完成" },
      3000,
    ).state;
    expect(state.items.map(({ title, count }) => ({ title, count }))).toEqual([
      { title: "Codex 任务", count: 2 },
      { title: "CI", count: 1 },
    ]);
  });

  it("treats the same content outside the duplicate window as a new item", () => {
    let state = createExternalNotificationState();
    state = enqueueExternalNotification(state, { title: null, text: "完成" }, 1000).state;
    state = enqueueExternalNotification(state, { title: null, text: "完成" }, 11_001).state;
    expect(state.items).toHaveLength(2);
  });

  it("starts timing only when displayed and resets for new messages", () => {
    let state = createExternalNotificationState();
    state = enqueueExternalNotification(state, { title: null, text: "完成" }, 1000).state;
    expect(state.expiresAt).toBeNull();
    state = startExternalNotifications(state, 2000);
    expect(state.expiresAt).toBe(5000);
    expect(externalNotificationsExpired(state, 4999)).toBe(false);
    state = enqueueExternalNotification(state, { title: null, text: "再次完成" }, 4000).state;
    expect(state.expiresAt).toBe(7000);
    expect(externalNotificationsExpired(state, 7000)).toBe(true);
  });

  it("resets expiry for duplicates without restarting an existing typewriter", () => {
    let state = createExternalNotificationState();
    state = enqueueExternalNotification(state, { title: null, text: "任务已经完成" }, 1000).state;
    state = startExternalNotifications(state, 2000);
    const revealedAt = state.items[0]?.revealedAt;
    state = enqueueExternalNotification(state, { title: null, text: "任务已经完成" }, 4000).state;
    expect(state.items[0]?.revealedAt).toBe(revealedAt);
    expect(state.items[0]?.count).toBe(2);
    expect(state.expiresAt).toBe(7000);
  });

  it("pauses pending notifications and restarts their reveal time", () => {
    let state = createExternalNotificationState();
    state = enqueueExternalNotification(state, { title: null, text: "完成" }, 1000).state;
    state = startExternalNotifications(state, 2000);
    state = pauseExternalNotifications(state);
    expect(state.presenting).toBe(false);
    expect(state.items[0]?.revealedAt).toBeNull();
    state = startExternalNotifications(state, 5000);
    expect(visibleExternalNotificationText(state.items[0]!, 5000)).toBe("完");
  });

  it("clears messages without reusing ids", () => {
    let state = createExternalNotificationState();
    state = enqueueExternalNotification(state, { title: null, text: "完成" }, 1000).state;
    const nextId = state.nextId;
    state = clearExternalNotifications(state);
    expect(state.items).toEqual([]);
    expect(state.nextId).toBe(nextId);
  });

  it("uses a fixed three-second duration", () => {
    expect(externalNotificationDurationMs("短消息")).toBe(3000);
    expect(externalNotificationDurationMs("长".repeat(50))).toBe(3000);
  });
});
