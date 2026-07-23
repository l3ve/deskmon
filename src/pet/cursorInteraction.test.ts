import { describe, expect, it } from "vitest";
import type { Point } from "../types";
import {
  advanceCursorInteraction,
  createCursorInteractionState,
  cursorChaseSpeed,
  cursorInteractionAllowed,
  cursorInteractionCadence,
  cursorNoticeOffset,
  sampleCursorInteraction,
  type CursorInteractionEnvironment,
  type CursorInteractionState,
} from "./cursorInteraction";

const environment: Omit<CursorInteractionEnvironment, "time"> = {
  petPosition: { x: 100, y: 100 },
  petWindowDimensions: { width: 100, height: 100 },
  activityArea: { x: 0, y: 0, width: 1000, height: 800 },
  coordinateScale: 1,
};

function sample(
  state: CursorInteractionState,
  time: number,
  cursor: Point,
  overrides: Partial<Omit<CursorInteractionEnvironment, "time">> = {},
): CursorInteractionState {
  return sampleCursorInteraction(state, {
    ...environment,
    ...overrides,
    time,
    cursor,
  });
}

function advance(
  state: CursorInteractionState,
  time: number,
  overrides: Partial<Omit<CursorInteractionEnvironment, "time">> = {},
): CursorInteractionState {
  return advanceCursorInteraction(state, {
    ...environment,
    ...overrides,
    time,
  });
}

function startChase(): CursorInteractionState {
  let state = createCursorInteractionState();
  state = sample(state, 0, { x: 260, y: 150 });
  state = sample(state, 100, { x: 320, y: 150 });
  state = sample(state, 180, { x: 390, y: 150 });
  expect(state.phase).toBe("chasing");
  return state;
}

describe("cursor interaction trigger", () => {
  it("only runs without higher-priority blockers", () => {
    const available = {
      petVisible: true,
      movementPaused: false,
      focusActive: false,
      screenshotActive: false,
      dragActive: false,
      pointerOverPet: false,
      presentationActive: false,
      suppressionActive: false,
    };
    expect(cursorInteractionAllowed(available)).toBe(true);
    for (const blocker of [
      "movementPaused",
      "focusActive",
      "screenshotActive",
      "dragActive",
      "pointerOverPet",
      "presentationActive",
      "suppressionActive",
    ] as const) {
      expect(cursorInteractionAllowed({ ...available, [blocker]: true })).toBe(false);
    }
    expect(cursorInteractionAllowed({ ...available, petVisible: false })).toBe(false);
  });

  it("ignores slow movement and expired samples", () => {
    let state = createCursorInteractionState();
    state = sample(state, 0, { x: 380, y: 150 });
    state = sample(state, 300, { x: 350, y: 150 });
    state = sample(state, 700, { x: 320, y: 150 });
    expect(state.phase).toBe("idle");
  });

  it("notices fast movement in the outer ring before chasing", () => {
    let state = createCursorInteractionState();
    state = sample(state, 0, { x: 440, y: 150 });
    state = sample(state, 100, { x: 395, y: 150 });
    state = sample(state, 180, { x: 350, y: 150 });
    expect(state.phase).toBe("noticing");
    expect(cursorNoticeOffset(state, 205)).toBeCloseTo(-2.5, 4);
    expect(cursorNoticeOffset(state, 230)).toBeCloseTo(-5, 4);
    state = advance(state, 280);
    expect(state.phase).toBe("chasing");
  });

  it("holds still when a fast approach enters the click-safe ring", () => {
    let state = createCursorInteractionState();
    state = sample(state, 0, { x: 430, y: 150 });
    state = sample(state, 100, { x: 320, y: 150 });
    state = sample(state, 180, { x: 240, y: 150 });
    expect(state.phase).toBe("observing");
    expect(state.chaseTarget).toBeNull();
  });

  it("starts chasing promptly when the cursor moves away", () => {
    const state = startChase();
    expect(state.chaseOrigin).toEqual(environment.petPosition);
    expect(state.chaseTarget).toEqual({ x: 340, y: 100 });
  });

  it("scales the quick-movement threshold for Retina coordinates", () => {
    const scaled = {
      petPosition: { x: 200, y: 200 },
      petWindowDimensions: { width: 200, height: 200 },
      coordinateScale: 2,
    };
    let state = createCursorInteractionState();
    state = sample(state, 0, { x: 520, y: 300 }, scaled);
    state = sample(state, 100, { x: 640, y: 300 }, scaled);
    expect(state.phase).toBe("idle");
    state = sample(state, 180, { x: 780, y: 300 }, scaled);
    expect(state.phase).toBe("chasing");
  });
});

describe("cursor chase lifecycle", () => {
  it("updates the live target and clamps it to the activity area", () => {
    let state = startChase();
    state = sample(
      state,
      260,
      { x: 420, y: 150 },
      { activityArea: { x: 0, y: 0, width: 400, height: 300 } },
    );
    expect(state.chaseTarget).toEqual({ x: 300, y: 100 });
  });

  it("stops when the cursor enters the click-safe ring", () => {
    let state = startChase();
    state = sample(state, 260, { x: 245, y: 150 });
    expect(state.phase).toBe("observing");
  });

  it("stops at the duration or travel limit", () => {
    const state = startChase();
    expect(
      advance(state, state.phaseStartedAt + cursorInteractionCadence.chaseMaxMs).phase,
    ).toBe("observing");
    expect(
      advance(state, state.phaseStartedAt + 200, {
        petPosition: { x: 301, y: 100 },
      }).phase,
    ).toBe("observing");
  });

  it("observes, cools down, and returns to idle", () => {
    let state = startChase();
    state = sample(state, 260, { x: 245, y: 150 });
    state = advance(
      state,
      state.phaseStartedAt + cursorInteractionCadence.observingMs,
    );
    expect(state.phase).toBe("cooldown");
    state = advance(
      state,
      state.phaseStartedAt + cursorInteractionCadence.cooldownMs - 1,
    );
    expect(state.phase).toBe("cooldown");
    state = advance(
      state,
      state.phaseStartedAt + cursorInteractionCadence.cooldownMs,
    );
    expect(state).toEqual(createCursorInteractionState());
  });

  it("keeps activity levels ordered without changing lifecycle timing", () => {
    expect(cursorChaseSpeed("quiet")).toBeLessThan(cursorChaseSpeed("standard"));
    expect(cursorChaseSpeed("lively")).toBeGreaterThan(cursorChaseSpeed("standard"));
  });
});
