import {
  externalNotificationCountLabel,
  visibleExternalNotificationText,
  type ExternalNotificationItem,
} from "./externalNotificationState";
import { createExternalNotificationFrame } from "./externalNotificationFrame";
import type { ExternalNotificationPlacement } from "./externalNotificationPresentation";

export interface ExternalNotificationDialogController {
  element: HTMLElement;
  clear(): void;
  render(item: ExternalNotificationItem | null, layerCount: number, time: number): void;
  setPlacement(placement: ExternalNotificationPlacement): void;
}

export function createExternalNotificationDialog(): ExternalNotificationDialogController {
  const element = document.createElement("section");
  element.className = "external-notifications";
  element.hidden = true;
  element.setAttribute("aria-label", "Deskmon 提醒");
  element.setAttribute("aria-live", "polite");

  const frame = createExternalNotificationFrame();
  const article = document.createElement("article");
  article.className = "external-notification-card";
  const header = document.createElement("header");
  header.className = "external-notification-header";
  const title = document.createElement("strong");
  title.className = "external-notification-title";
  const count = document.createElement("span");
  count.className = "external-notification-count";
  header.append(title, count);
  const body = document.createElement("p");
  body.className = "external-notification-body";
  article.append(header, body);
  element.append(frame, article);

  return {
    element,
    clear(): void {
      element.hidden = true;
      delete element.dataset.layers;
      delete element.dataset.tone;
    },
    render(item: ExternalNotificationItem | null, layerCount: number, time: number): void {
      if (!item) {
        this.clear();
        return;
      }
      const countLabel = externalNotificationCountLabel(item.count);
      title.textContent = item.title ?? "";
      title.hidden = !item.title;
      count.textContent = countLabel;
      count.hidden = !countLabel;
      header.hidden = !item.title && !countLabel;
      body.textContent = visibleExternalNotificationText(item, time);
      element.dataset.layers = String(Math.max(1, Math.min(4, layerCount)));
      element.dataset.tone = item.tone;
      article.setAttribute(
        "aria-label",
        [item.title, item.text, countLabel].filter(Boolean).join("，"),
      );
      element.hidden = false;
    },
    setPlacement(placement: ExternalNotificationPlacement): void {
      element.dataset.placement = placement;
    },
  };
}
