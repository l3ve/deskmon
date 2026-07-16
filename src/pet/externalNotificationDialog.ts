import {
  externalNotificationCountLabel,
  visibleExternalNotificationText,
  type ExternalNotificationItem,
} from "./externalNotificationState";
import type { ExternalNotificationPlacement } from "./externalNotificationPresentation";

interface NotificationCardElements {
  article: HTMLElement;
  header: HTMLElement;
  title: HTMLElement;
  body: HTMLElement;
  count: HTMLElement;
}

export interface ExternalNotificationDialogController {
  element: HTMLElement;
  clear(): void;
  hide(): void;
  render(items: ExternalNotificationItem[], time: number): void;
  setPlacement(placement: ExternalNotificationPlacement): void;
}

export function createExternalNotificationDialog(): ExternalNotificationDialogController {
  const element = document.createElement("section");
  element.className = "external-notifications";
  element.hidden = true;
  element.setAttribute("aria-label", "Deskmon 外部提醒");
  element.setAttribute("aria-live", "polite");
  element.setAttribute("aria-relevant", "additions text");

  const cards = new Map<number, NotificationCardElements>();

  const createCard = (item: ExternalNotificationItem): NotificationCardElements => {
    const article = document.createElement("article");
    article.className = "external-notification-card";
    article.dataset.notificationId = String(item.id);

    const header = document.createElement("header");
    header.className = "external-notification-header";
    const title = document.createElement("strong");
    title.className = "external-notification-title";
    const count = document.createElement("span");
    count.className = "external-notification-count";
    header.append(title, count);

    const body = document.createElement("p");
    body.className = "external-notification-body";
    body.setAttribute("aria-hidden", "true");
    article.append(header, body);
    return { article, header, title, body, count };
  };

  return {
    element,
    clear(): void {
      cards.clear();
      element.replaceChildren();
      element.hidden = true;
    },
    hide(): void {
      element.hidden = true;
    },
    render(items: ExternalNotificationItem[], time: number): void {
      const activeIds = new Set(items.map((item) => item.id));
      for (const [id, card] of cards) {
        if (!activeIds.has(id)) {
          card.article.remove();
          cards.delete(id);
        }
      }
      for (const [index, item] of items.entries()) {
        let card = cards.get(item.id);
        if (!card) {
          card = createCard(item);
          cards.set(item.id, card);
        }
        card.title.textContent = item.title ?? "";
        card.title.hidden = !item.title;
        const countLabel = externalNotificationCountLabel(item.count);
        card.count.textContent = countLabel;
        card.count.hidden = !countLabel;
        card.header.hidden = !item.title && !countLabel;
        card.body.textContent = visibleExternalNotificationText(item, time);
        card.article.setAttribute(
          "aria-label",
          [item.title, item.text, countLabel].filter(Boolean).join("，"),
        );
        if (element.children.item(index) !== card.article) {
          element.insertBefore(card.article, element.children.item(index));
        }
      }
      element.hidden = items.length === 0;
    },
    setPlacement(placement: ExternalNotificationPlacement): void {
      element.dataset.placement = placement;
    },
  };
}
