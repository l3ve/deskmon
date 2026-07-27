import { describe, expect, it } from "vitest";
import {
  advanceReminder,
  completeReminderReveal,
  createReminderState,
  enqueueReminder,
  reminderDurationMs,
  reminderLayerCount,
  reminderRevealComplete,
  remindersExpired,
  pauseReminders,
  resumeReminders,
  startReminders,
  visibleReminderText,
  type ReminderPayload,
} from "./state";

const normal = (text: string): ReminderPayload => ({
  title: "Deskmon",
  text,
  tone: "normal",
});

describe("reminder presentation state", () => {
  it("plays notifications in FIFO order", () => {
    let state = createReminderState();
    state = enqueueReminder(state, normal("第一条"), 0).state;
    state = enqueueReminder(state, normal("第二条"), 1).state;
    state = startReminders(state, 10);
    expect(state.items[0]?.text).toBe("第一条");
    state = advanceReminder(state, 100);
    expect(state.items[0]?.text).toBe("第二条");
  });

  it("keeps twenty entries and preserves the current message", () => {
    let state = createReminderState();
    state = enqueueReminder(state, normal("当前"), 0).state;
    state = startReminders(state, 1);
    for (let index = 1; index <= 24; index += 1) {
      state = enqueueReminder(state, normal(`消息 ${index}`), index + 10_000).state;
    }
    expect(state.items).toHaveLength(20);
    expect(state.items[0]?.text).toBe("当前");
    expect(state.items[state.items.length - 1]?.text).toBe("消息 24");
    expect(reminderLayerCount(state)).toBe(4);
  });

  it("merges duplicates received in the duplicate window", () => {
    let state = createReminderState();
    state = enqueueReminder(state, normal("相同"), 0).state;
    state = startReminders(state, 10);
    state = enqueueReminder(state, normal("相同"), 100).state;
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.count).toBe(2);
    expect(state.expiresAt).toBe(4100);
  });

  it("uses four seconds for normal messages and eight for errors", () => {
    expect(reminderDurationMs("normal")).toBe(4000);
    expect(reminderDurationMs("error")).toBe(8000);
  });

  it("pauses without consuming display time", () => {
    let state = enqueueReminder(
      createReminderState(),
      normal("暂停"),
      0,
    ).state;
    state = startReminders(state, 100);
    state = pauseReminders(state, 1100);
    expect(remindersExpired(state, 10_000)).toBe(false);
    state = resumeReminders(state, 3100);
    expect(remindersExpired(state, 6099)).toBe(false);
    expect(remindersExpired(state, 6100)).toBe(true);
  });

  it("can complete the typewriter before advancing", () => {
    let state = enqueueReminder(
      createReminderState(),
      normal("逐字动画"),
      0,
    ).state;
    state = startReminders(state, 0);
    expect(visibleReminderText(state.items[0]!, 0)).toBe("逐");
    expect(reminderRevealComplete(state.items[0]!, 0)).toBe(false);
    state = completeReminderReveal(state);
    expect(reminderRevealComplete(state.items[0]!, 0)).toBe(true);
  });
});
