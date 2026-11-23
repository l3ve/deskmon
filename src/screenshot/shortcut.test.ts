import { describe, expect, it } from "vitest";
import { formatShortcut, shortcutFromEvent, ShortcutRecorder } from "./shortcut";

const key = (code: string, modifiers: Partial<KeyboardEvent> = {}) => ({
  code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
  isComposing: false, repeat: false, ...modifiers,
});

describe("截图快捷键", () => {
  it("根据物理按键录入组合并显示 macOS 符号", () => {
    expect(shortcutFromEvent(key("KeyA", { metaKey: true, shiftKey: true }))).toBe("Super+Shift+KeyA");
    expect(shortcutFromEvent(key("Digit2", { ctrlKey: true, altKey: true }))).toBe("Control+Alt+Digit2");
    expect(formatShortcut("Super+Shift+KeyA")).toBe("⇧⌘A");
    expect(formatShortcut("Control+Alt+ArrowLeft")).toBe("⌃⌥←");
    expect(formatShortcut(null)).toBe("未设置");
    expect(formatShortcut("shift+super+KeyA")).toBe("⇧⌘A");
  });

  it("拒绝普通输入、保留的粘贴键和输入法组合", () => {
    for (const event of [
      key("KeyA"), key("KeyA", { shiftKey: true }), key("MetaLeft", { metaKey: true }),
      key("KeyV", { metaKey: true }), key("Escape", { metaKey: true }),
      key("KeyA", { metaKey: true, isComposing: true }), key("KeyA", { metaKey: true, repeat: true }),
      key("AudioVolumeUp", { metaKey: true }),
    ]) expect(shortcutFromEvent(event)).toBeNull();
    expect(shortcutFromEvent(key("KeyV", { metaKey: true, shiftKey: true }))).toBe("Super+Shift+KeyV");
    expect(shortcutFromEvent(key("F12", { altKey: true }))).toBe("Alt+F12");
  });


});

describe("快捷键录入生命周期", () => {
  it("取消发生在暂停注册尚未返回时，也会恢复原热键", async () => {
    let complete!: () => void;
    let paused = false;
    const recorder = new ShortcutRecorder(async (recording) => {
      paused = recording;
      if (recording) await new Promise<void>((resolve) => { complete = resolve; });
    });
    const starting = recorder.start();
    await Promise.resolve();
    const cancelling = recorder.cancel();
    complete();
    await Promise.all([starting, cancelling]);
    expect(paused).toBe(false);
    expect(recorder.recording).toBe(false);
    expect(recorder.ready).toBe(false);
  });

  it("注册失败后可再次录入，取消后不再接受按键", async () => {
    let conflict = true;
    const recorder = new ShortcutRecorder(async () => { if (conflict) throw new Error("conflict"); });
    await expect(recorder.start()).rejects.toThrow("conflict");
    expect(recorder.recording).toBe(false);
    conflict = false;
    await recorder.start();
    expect(recorder.ready).toBe(true);
    await recorder.cancel();
    expect(recorder.ready).toBe(false);
  });
});
