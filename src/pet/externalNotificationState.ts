export interface ExternalNotificationPayload {
  title: string | null;
  text: string;
}

export interface ExternalNotificationItem {
  id: number;
  title: string | null;
  text: string;
  count: number;
  lastReceivedAt: number;
  revealedAt: number | null;
}

export interface ExternalNotificationState {
  items: ExternalNotificationItem[];
  nextId: number;
  presenting: boolean;
  expiresAt: number | null;
  lastDurationMs: number;
}

interface EnqueueResult {
  state: ExternalNotificationState;
  accepted: boolean;
}

interface Segment {
  segment: string;
}

interface SegmenterLike {
  segment(value: string): Iterable<Segment>;
}

interface SegmenterConstructor {
  new (locales?: string | string[], options?: { granularity: "grapheme" }): SegmenterLike;
}

const titleLimit = 10;
const bodyLimit = 50;
const duplicateWindowMs = 10_000;
const maxItems = 3;
const typewriterIntervalMs = 28;
const notificationDurationMs = 3000;

export function createExternalNotificationState(): ExternalNotificationState {
  return {
    items: [],
    nextId: 1,
    presenting: false,
    expiresAt: null,
    lastDurationMs: notificationDurationMs,
  };
}

export function normalizeExternalNotification(
  payload: ExternalNotificationPayload,
): ExternalNotificationPayload | null {
  const title = truncateGraphemes(normalizeInline(payload.title ?? ""), titleLimit) || null;
  const text = truncateGraphemes(normalizeBody(payload.text), bodyLimit);
  return text ? { title, text } : null;
}

export function enqueueExternalNotification(
  state: ExternalNotificationState,
  payload: ExternalNotificationPayload,
  now: number,
): EnqueueResult {
  const normalized = normalizeExternalNotification(payload);
  if (!normalized) {
    return { state, accepted: false };
  }

  const duration = externalNotificationDurationMs(normalized.text);
  const duplicateIndex = state.items.findIndex(
    (item) =>
      item.title === normalized.title &&
      item.text === normalized.text &&
      now - item.lastReceivedAt <= duplicateWindowMs,
  );
  let items: ExternalNotificationItem[];
  let nextId = state.nextId;
  if (duplicateIndex >= 0) {
    items = state.items.map((item, index) =>
      index === duplicateIndex
        ? {
            ...item,
            count: Math.min(100, item.count + 1),
            lastReceivedAt: now,
            revealedAt: state.presenting ? (item.revealedAt ?? now) : null,
          }
        : item,
    );
  } else {
    items = [
      ...state.items,
      {
        id: nextId,
        title: normalized.title,
        text: normalized.text,
        count: 1,
        lastReceivedAt: now,
        revealedAt: state.presenting ? now : null,
      },
    ];
    nextId += 1;
    if (items.length > maxItems) {
      items = items.slice(items.length - maxItems);
    }
  }

  return {
    accepted: true,
    state: {
      items,
      nextId,
      presenting: state.presenting,
      expiresAt: state.presenting ? now + duration : null,
      lastDurationMs: duration,
    },
  };
}

export function startExternalNotifications(
  state: ExternalNotificationState,
  now: number,
): ExternalNotificationState {
  if (state.items.length === 0) {
    return state;
  }
  return {
    ...state,
    items: state.items.map((item) => ({
      ...item,
      revealedAt: item.revealedAt ?? now,
    })),
    presenting: true,
    expiresAt: now + state.lastDurationMs,
  };
}

export function pauseExternalNotifications(
  state: ExternalNotificationState,
): ExternalNotificationState {
  if (!state.presenting) {
    return state;
  }
  return {
    ...state,
    items: state.items.map((item) => ({ ...item, revealedAt: null })),
    presenting: false,
    expiresAt: null,
  };
}

export function clearExternalNotifications(
  state: ExternalNotificationState,
): ExternalNotificationState {
  return {
    ...createExternalNotificationState(),
    nextId: state.nextId,
  };
}

export function externalNotificationsExpired(
  state: ExternalNotificationState,
  now: number,
): boolean {
  return state.presenting && state.expiresAt !== null && now >= state.expiresAt;
}

export function visibleExternalNotificationText(
  item: ExternalNotificationItem,
  now: number,
): string {
  if (item.revealedAt === null) {
    return "";
  }
  const graphemes = splitGraphemes(item.text);
  const count = Math.min(
    graphemes.length,
    Math.max(1, Math.floor((now - item.revealedAt) / typewriterIntervalMs) + 1),
  );
  return graphemes.slice(0, count).join("");
}

export function externalNotificationCountLabel(count: number): string {
  if (count <= 1) {
    return "";
  }
  return count >= 100 ? "×99+" : `×${count}`;
}

export function externalNotificationDurationMs(_text: string): number {
  return notificationDurationMs;
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeBody(value: string): string {
  const paragraphs = value
    .replace(/\r\n?/gu, "\n")
    .split(/\n+/gu)
    .map((paragraph) => paragraph.replace(/[^\S\n]+/gu, " ").trim())
    .filter(Boolean);
  if (paragraphs.length <= 3) {
    return paragraphs.join("\n");
  }
  return [paragraphs[0], paragraphs[1], paragraphs.slice(2).join(" ")].join("\n");
}

function truncateGraphemes(value: string, limit: number): string {
  const graphemes = splitGraphemes(value);
  if (graphemes.length <= limit) {
    return value;
  }
  return `${graphemes.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

export function splitGraphemes(value: string): string[] {
  const constructor = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
  if (constructor) {
    const segmenter = new constructor(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), ({ segment }) => segment);
  }
  return Array.from(value);
}
