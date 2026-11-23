type ShortcutEvent = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "repeat">;

export function shortcutFromEvent(event: ShortcutEvent): string | null {
  if (event.isComposing || event.repeat || !(event.metaKey || event.ctrlKey || event.altKey)) return null;
  if (!/^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Space|F([1-9]|1[0-2]))$/.test(event.code)) return null;
  if (event.code === "KeyV" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return null;
  return [event.ctrlKey && "Control", event.altKey && "Alt", event.metaKey && "Super", event.shiftKey && "Shift", event.code].filter(Boolean).join("+");
}

export function formatShortcut(shortcut: string | null): string {
  if (!shortcut) return "未设置";
  const parts = shortcut.split("+");
  const code = parts[parts.length - 1];
  const keyLabels: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "空格" };
  const modifiers = [["Control", "⌃"], ["Alt", "⌥"], ["Shift", "⇧"], ["Super", "⌘"]];
  return modifiers.filter(([name]) => parts.some((part) => part.toLowerCase() === name.toLowerCase())).map(([, symbol]) => symbol).join("") + (keyLabels[code] ?? code.replace(/^(Key|Digit)/, ""));
}

export class ShortcutRecorder {
  recording = false;
  ready = false;
  private version = 0;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly setRecording: (recording: boolean) => Promise<void>) {}
  start(): Promise<void> {
    if (this.recording) return this.queue;
    const version = ++this.version;
    this.recording = true;
    this.ready = false;
    return this.enqueue(async () => {
      try {
        await this.setRecording(true);
        if (this.version === version && this.recording) this.ready = true;
      } catch (error) {
        if (this.version === version) this.recording = false;
        throw error;
      }
    });
  }
  cancel(): Promise<void> {
    ++this.version;
    this.recording = false;
    this.ready = false;
    return this.enqueue(() => this.setRecording(false));
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
}
