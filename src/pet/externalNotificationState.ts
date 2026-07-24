export type PetNotificationTone = "normal" | "error";

export interface ExternalNotificationPayload {
  title: string | null;
  text: string;
  tone: PetNotificationTone;
}

export interface ExternalNotificationItem {
  id: number;
  title: string | null;
  text: string;
  tone: PetNotificationTone;
  count: number;
  lastReceivedAt: number;
  revealedAt: number | null;
}

export interface ExternalNotificationState {
  items: ExternalNotificationItem[];
  nextId: number;
  presenting: boolean;
  expiresAt: number | null;
  pausedAt: number | null;
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

const titleLimit = 24;
const bodyLimit = 120;
const duplicateWindowMs = 10_000;
const maxItems = 20;
const maxVisibleLayers = 4;
const typewriterIntervalMs = 28;

export function createExternalNotificationState(): ExternalNotificationState {
  return {
    items: [],
    nextId: 1,
    presenting: false,
    expiresAt: null,
    pausedAt: null,
  };
}

export function normalizeExternalNotification(
  payload: ExternalNotificationPayload,
): ExternalNotificationPayload | null {
  const title = truncateGraphemes(normalizeInline(payload.title ?? ""), titleLimit) || null;
  const text = truncateGraphemes(normalizeBody(payload.text), bodyLimit);
  return text ? { title, text, tone: payload.tone === "error" ? "error" : "normal" } : null;
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

  const duplicateIndex = state.items.findIndex(
    (item) =>
      item.title === normalized.title &&
      item.text === normalized.text &&
      item.tone === normalized.tone &&
      now - item.lastReceivedAt <= duplicateWindowMs,
  );
  let items = [...state.items];
  let nextId = state.nextId;
  if (duplicateIndex >= 0) {
    items[duplicateIndex] = {
      ...items[duplicateIndex]!,
      count: Math.min(100, items[duplicateIndex]!.count + 1),
      lastReceivedAt: now,
    };
  } else {
    items.push({
      id: nextId,
      title: normalized.title,
      text: normalized.text,
      tone: normalized.tone,
      count: 1,
      lastReceivedAt: now,
      revealedAt: null,
    });
    nextId += 1;
    if (items.length > maxItems) {
      items.splice(state.presenting ? 1 : 0, items.length - maxItems);
    }
  }

  return {
    accepted: true,
    state: {
      ...state,
      items,
      nextId,
      expiresAt:
        duplicateIndex === 0 && state.presenting
          ? now + externalNotificationDurationMs(items[0]!.tone)
          : state.expiresAt,
      pausedAt:
        duplicateIndex === 0 && state.pausedAt !== null ? now : state.pausedAt,
    },
  };
}

export function startExternalNotifications(
  state: ExternalNotificationState,
  now: number,
): ExternalNotificationState {
  const current = state.items[0];
  if (!current || state.presenting) {
    return state;
  }
  return {
    ...state,
    items: [{ ...current, revealedAt: now }, ...state.items.slice(1)],
    presenting: true,
    expiresAt: now + externalNotificationDurationMs(current.tone),
    pausedAt: null,
  };
}

export function pauseExternalNotifications(
  state: ExternalNotificationState,
  now: number,
): ExternalNotificationState {
  if (!state.presenting || state.pausedAt !== null) {
    return state;
  }
  return { ...state, pausedAt: now };
}

export function resumeExternalNotifications(
  state: ExternalNotificationState,
  now: number,
): ExternalNotificationState {
  if (state.pausedAt === null) {
    return state;
  }
  const pausedFor = Math.max(0, now - state.pausedAt);
  const current = state.items[0];
  return {
    ...state,
    items: current
      ? [
          {
            ...current,
            revealedAt:
              current.revealedAt === null ? now : current.revealedAt + pausedFor,
          },
          ...state.items.slice(1),
        ]
      : state.items,
    expiresAt: state.expiresAt === null ? null : state.expiresAt + pausedFor,
    pausedAt: null,
  };
}

export function completeExternalNotificationReveal(
  state: ExternalNotificationState,
): ExternalNotificationState {
  const current = state.items[0];
  if (!current) {
    return state;
  }
  return {
    ...state,
    items: [{ ...current, revealedAt: Number.NEGATIVE_INFINITY }, ...state.items.slice(1)],
  };
}

export function advanceExternalNotification(
  state: ExternalNotificationState,
  now: number,
): ExternalNotificationState {
  const items = state.items.slice(1);
  if (items.length === 0) {
    return { ...state, items, presenting: false, expiresAt: null, pausedAt: null };
  }
  const current = { ...items[0]!, revealedAt: now };
  return {
    ...state,
    items: [current, ...items.slice(1)],
    presenting: true,
    expiresAt: now + externalNotificationDurationMs(current.tone),
    pausedAt: null,
  };
}

export function clearExternalNotifications(
  state: ExternalNotificationState,
): ExternalNotificationState {
  return { ...createExternalNotificationState(), nextId: state.nextId };
}

export function externalNotificationsExpired(
  state: ExternalNotificationState,
  now: number,
): boolean {
  return (
    state.presenting &&
    state.pausedAt === null &&
    state.expiresAt !== null &&
    now >= state.expiresAt
  );
}

export function externalNotificationRevealComplete(
  item: ExternalNotificationItem,
  now: number,
): boolean {
  return visibleExternalNotificationText(item, now) === item.text;
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

export function externalNotificationLayerCount(state: ExternalNotificationState): number {
  return Math.min(maxVisibleLayers, state.items.length);
}

export function externalNotificationDurationMs(tone: PetNotificationTone): number {
  return tone === "error" ? 8000 : 4000;
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
  return paragraphs.slice(0, 3).join("\n");
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
