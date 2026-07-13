import type { FocusSessionAction, FocusSessionSnapshot } from "../types";

interface DialogAction {
  action: FocusSessionAction;
  label: string;
  tone: "primary" | "secondary" | "quiet";
}

export interface FocusDialogController {
  element: HTMLElement;
  hide(): void;
  render(snapshot: FocusSessionSnapshot): void;
}

export function createFocusDialog(
  onAction: (action: FocusSessionAction) => Promise<void>,
): FocusDialogController {
  const dialog = document.createElement("section");
  dialog.className = "focus-dialog";
  dialog.hidden = true;
  dialog.tabIndex = 0;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "false");
  dialog.setAttribute("aria-labelledby", "focus-dialog-title");

  const eyebrow = document.createElement("p");
  eyebrow.className = "focus-dialog-eyebrow";
  eyebrow.textContent = "Deskmon";

  const title = document.createElement("h2");
  title.id = "focus-dialog-title";

  const message = document.createElement("p");
  message.className = "focus-dialog-message";

  const countdown = document.createElement("output");
  countdown.className = "focus-dialog-countdown";
  countdown.setAttribute("aria-live", "polite");

  const actions = document.createElement("div");
  actions.className = "focus-dialog-actions";
  dialog.append(eyebrow, title, message, countdown, actions);

  let renderedKey = "";
  let busy = false;

  const setBusy = (nextBusy: boolean): void => {
    busy = nextBusy;
    dialog.classList.toggle("busy", nextBusy);
    actions.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.disabled = nextBusy;
    });
  };

  const trigger = async (action: FocusSessionAction): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await onAction(action);
    } finally {
      setBusy(false);
    }
  };

  const renderActions = (items: DialogAction[]): void => {
    actions.replaceChildren();
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `focus-dialog-button ${item.tone}`;
      button.textContent = item.label;
      button.addEventListener("click", () => void trigger(item.action));
      actions.append(button);
    }
  };

  dialog.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof HTMLButtonElement)) {
      dialog.focus({ preventScroll: true });
    }
  });

  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const buttons = Array.from(
      actions.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    );
    if (buttons.length === 0) {
      return;
    }
    if (event.key === "Enter" && event.target === dialog) {
      event.preventDefault();
      buttons[0].click();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const current = document.activeElement instanceof HTMLButtonElement
      ? buttons.indexOf(document.activeElement)
      : -1;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = current < 0 ? 0 : (current + delta + buttons.length) % buttons.length;
    buttons[next].focus();
  });

  return {
    element: dialog,
    hide(): void {
      dialog.hidden = true;
      renderedKey = "";
    },
    render(snapshot: FocusSessionSnapshot): void {
      const breakMinutes = snapshot.breakMinutes ?? 5;
      const baseFocusMinutes = snapshot.baseFocusMinutes ?? 25;
      let key = snapshot.phase;
      let nextTitle = "";
      let nextMessage = "";
      let nextCountdown = "";
      let nextActions: DialogAction[] = [];

      if (snapshot.phase === "focusComplete") {
        key += `:${breakMinutes}`;
        nextTitle = "专注完成";
        nextMessage = "接下来想怎么安排？";
        nextActions = [
          { action: "startBreak", label: `休息 ${breakMinutes} 分钟`, tone: "primary" },
          { action: "extendFocus", label: "再专注 5 分钟", tone: "secondary" },
          { action: "endRound", label: "结束本轮", tone: "quiet" },
        ];
      } else if (snapshot.phase === "breakRunning") {
        nextTitle = "休息一下";
        nextMessage = "让注意力真正离开一会儿";
        nextCountdown = formatRemaining(snapshot.remainingSeconds);
        nextActions = [
          { action: "finishBreakEarly", label: "提前结束休息", tone: "secondary" },
        ];
      } else if (snapshot.phase === "breakComplete") {
        key += `:${baseFocusMinutes}`;
        nextTitle = "休息结束";
        nextMessage = "准备好继续了吗？";
        nextActions = [
          {
            action: "resumeFocus",
            label: `继续专注 ${baseFocusMinutes} 分钟`,
            tone: "primary",
          },
          { action: "extendBreak", label: "再休息 5 分钟", tone: "secondary" },
          { action: "endRound", label: "结束本轮", tone: "quiet" },
        ];
      } else {
        this.hide();
        return;
      }

      dialog.hidden = false;
      title.textContent = nextTitle;
      message.textContent = nextMessage;
      countdown.textContent = nextCountdown;
      countdown.hidden = nextCountdown.length === 0;
      if (key !== renderedKey) {
        renderActions(nextActions);
        renderedKey = key;
      }
    },
  };
}

function formatRemaining(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}
