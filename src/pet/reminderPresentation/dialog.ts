import {
  reminderCountLabel,
  visibleReminderText,
  type ReminderItem,
} from "./state";
import {
  createReminderFrame,
  reminderCardMinHeight,
  reminderFrameHeightForCardHeight,
  reminderFrameOverhang,
} from "./frame";
import type { ReminderLayout } from "./layout";

export interface ReminderDialogController {
  applyLayout(layout: ReminderLayout): void;
  clear(): void;
  destroy(): void;
  measureHeight(item: ReminderItem, layerCount: number): number;
  render(item: ReminderItem | null, layerCount: number, time: number): void;
}

export interface ReminderDialogHandlers {
  onActivate(): void;
  onHoverChanged(hovered: boolean): void;
}

interface PointerStart {
  pointerId: number;
  screenX: number;
  screenY: number;
}

const clickThreshold = 7;

export function createReminderDialog(
  root: HTMLElement,
  canvas: HTMLCanvasElement,
  handlers: ReminderDialogHandlers,
): ReminderDialogController {
  const element = document.createElement("section");
  element.className = "reminder-presentation";
  element.hidden = true;
  element.setAttribute("aria-label", "Deskmon 提醒");
  element.setAttribute("aria-live", "polite");

  let frame = createReminderFrame();
  const article = document.createElement("article");
  article.className = "reminder-card";
  const header = document.createElement("header");
  header.className = "reminder-header";
  const title = document.createElement("strong");
  title.className = "reminder-title";
  const count = document.createElement("span");
  count.className = "reminder-count";
  header.append(title, count);
  const body = document.createElement("p");
  body.className = "reminder-body";
  article.append(header, body);
  element.append(frame, article);
  root.append(element);

  let pointerStart: PointerStart | null = null;
  const handlePointerEnter = (): void => handlers.onHoverChanged(true);
  const handlePointerLeave = (): void => handlers.onHoverChanged(false);
  const handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !element.contains(event.target as Node)) {
      return;
    }
    pointerStart = {
      pointerId: event.pointerId,
      screenX: event.screenX,
      screenY: event.screenY,
    };
  };
  const handlePointerUp = (event: PointerEvent): void => {
    if (!pointerStart || pointerStart.pointerId !== event.pointerId) {
      return;
    }
    const distance = Math.hypot(
      event.screenX - pointerStart.screenX,
      event.screenY - pointerStart.screenY,
    );
    pointerStart = null;
    if (distance <= clickThreshold) {
      handlers.onActivate();
    }
  };
  const handlePointerCancel = (): void => {
    pointerStart = null;
  };
  element.addEventListener("pointerenter", handlePointerEnter);
  element.addEventListener("pointerleave", handlePointerLeave);
  root.addEventListener("pointerdown", handlePointerDown, true);
  root.addEventListener("pointerup", handlePointerUp, true);
  root.addEventListener("pointercancel", handlePointerCancel, true);

  const updateMetadata = (item: ReminderItem, layerCount: number): void => {
    const countLabel = reminderCountLabel(item.count);
    title.textContent = item.title ?? "";
    title.hidden = !item.title;
    count.textContent = countLabel;
    count.hidden = !countLabel;
    header.hidden = !item.title && !countLabel;
    element.dataset.layers = String(Math.max(1, Math.min(4, layerCount)));
    element.dataset.tone = item.tone;
    article.setAttribute(
      "aria-label",
      [item.title, item.text, countLabel].filter(Boolean).join("，"),
    );
  };

  const applyHeight = (height: number): void => {
    const cardHeight = height - reminderFrameOverhang;
    element.style.setProperty("--notification-card-height", `${cardHeight}px`);
    element.style.setProperty("--notification-frame-height", `${height}px`);
    const nextFrame = createReminderFrame(height);
    frame.replaceWith(nextFrame);
    frame = nextFrame;
  };

  return {
    applyLayout(layout: ReminderLayout): void {
      const style = element.style;
      style.left = `${layout.notificationOffset.x}px`;
      style.top = `${layout.notificationOffset.y}px`;
      style.width = `${layout.notificationDimensions.width}px`;
      style.height = `${layout.notificationDimensions.height}px`;
      element.dataset.placement = layout.notificationPlacement;
      canvas.style.left = `${layout.petOffset.x}px`;
      canvas.style.top = `${layout.petOffset.y}px`;
    },
    clear(): void {
      element.hidden = true;
      delete element.dataset.layers;
      delete element.dataset.tone;
      canvas.style.left = "0px";
      canvas.style.top = "0px";
    },
    destroy(): void {
      element.removeEventListener("pointerenter", handlePointerEnter);
      element.removeEventListener("pointerleave", handlePointerLeave);
      root.removeEventListener("pointerdown", handlePointerDown, true);
      root.removeEventListener("pointerup", handlePointerUp, true);
      root.removeEventListener("pointercancel", handlePointerCancel, true);
      element.remove();
    },
    measureHeight(item: ReminderItem, layerCount: number): number {
      updateMetadata(item, layerCount);
      body.textContent = item.text;
      element.dataset.measuring = "true";
      element.hidden = false;
      const height = reminderFrameHeightForCardHeight(
        Math.max(reminderCardMinHeight, article.scrollHeight),
      );
      applyHeight(height);
      delete element.dataset.measuring;
      return height;
    },
    render(item: ReminderItem | null, layerCount: number, time: number): void {
      if (!item) {
        this.clear();
        return;
      }
      updateMetadata(item, layerCount);
      body.textContent = visibleReminderText(item, time);
      element.hidden = false;
    },
  };
}
