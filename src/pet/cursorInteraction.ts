import type { ActivityLevel, Dimensions, Point, Rect } from "../types";
import { clampPointToRect, distance, topLeftFromCenter } from "./geometry";

export type CursorInteractionPhase =
  | "idle"
  | "noticing"
  | "chasing"
  | "observing"
  | "cooldown";

interface CursorSample {
  at: number;
  point: Point;
  distanceFromPet: number;
}

export interface CursorInteractionState {
  phase: CursorInteractionPhase;
  phaseStartedAt: number;
  samples: CursorSample[];
  latestCursor: Point | null;
  chaseOrigin: Point | null;
  chaseTarget: Point | null;
}

export interface CursorInteractionEnvironment {
  time: number;
  petPosition: Point;
  petWindowDimensions: Dimensions;
  activityArea: Rect;
  coordinateScale: number;
}

export interface CursorInteractionSample extends CursorInteractionEnvironment {
  cursor: Point;
}

export interface CursorInteractionBlockers {
  petVisible: boolean;
  movementPaused: boolean;
  focusActive: boolean;
  screenshotActive: boolean;
  dragActive: boolean;
  pointerOverPet: boolean;
  presentationActive: boolean;
  suppressionActive: boolean;
}

export const cursorInteractionCadence = {
  sampleIntervalMs: 100,
  sampleWindowMs: 400,
  quickTravelLogical: 90,
  noticingMs: 100,
  observingMs: 1000,
  cooldownMs: 2000,
  chaseMaxMs: 1200,
  chaseMaxTravelLogical: 200,
  outerRadiusWindowMultiplier: 3.5,
  safeRadiusWindowMultiplier: 1.2,
  movingAwayLogical: 24,
  targetArrivalLogical: 4,
  pointerExitProtectionMs: 800,
  menuProtectionMs: 1500,
  noticeLiftLogical: 5,
} as const;

const chaseSpeeds: Record<ActivityLevel, number> = {
  quiet: 190,
  standard: 210,
  lively: 235,
};

export function createCursorInteractionState(): CursorInteractionState {
  return {
    phase: "idle",
    phaseStartedAt: 0,
    samples: [],
    latestCursor: null,
    chaseOrigin: null,
    chaseTarget: null,
  };
}

export function cancelCursorInteraction(): CursorInteractionState {
  return createCursorInteractionState();
}

export function cursorChaseSpeed(activityLevel: ActivityLevel): number {
  return chaseSpeeds[activityLevel];
}

export function cursorInteractionAllowed(
  blockers: CursorInteractionBlockers,
): boolean {
  return (
    blockers.petVisible &&
    !blockers.movementPaused &&
    !blockers.focusActive &&
    !blockers.screenshotActive &&
    !blockers.dragActive &&
    !blockers.pointerOverPet &&
    !blockers.presentationActive &&
    !blockers.suppressionActive
  );
}

export function sampleCursorInteraction(
  state: CursorInteractionState,
  input: CursorInteractionSample,
): CursorInteractionState {
  const scale = normalizedScale(input.coordinateScale);
  const petCenter = {
    x: input.petPosition.x + input.petWindowDimensions.width * 0.5,
    y: input.petPosition.y + input.petWindowDimensions.height * 0.5,
  };
  const cursorDistance = distance(petCenter, input.cursor);
  const outerRadius =
    input.petWindowDimensions.width * cursorInteractionCadence.outerRadiusWindowMultiplier;
  const safeRadius =
    input.petWindowDimensions.width * cursorInteractionCadence.safeRadiusWindowMultiplier;
  const samples = appendSample(state.samples, {
    at: input.time,
    point: input.cursor,
    distanceFromPet: cursorDistance,
  });
  const quickMovement =
    cumulativeTravel(samples) >= cursorInteractionCadence.quickTravelLogical * scale;
  const previous = samples.length >= 2 ? samples[samples.length - 2] : undefined;
  const movingAway =
    previous !== undefined &&
    cursorDistance - previous.distanceFromPet >=
      cursorInteractionCadence.movingAwayLogical * scale;

  if (state.phase === "cooldown" || state.phase === "observing") {
    return {
      ...state,
      samples,
      latestCursor: { ...input.cursor },
    };
  }

  if (cursorDistance <= safeRadius) {
    if (state.phase === "noticing" || state.phase === "chasing" || quickMovement) {
      return beginObserving(state, input.time, input.cursor, samples);
    }
    return {
      ...state,
      samples,
      latestCursor: { ...input.cursor },
    };
  }

  if (cursorDistance > outerRadius) {
    if (state.phase === "noticing" || state.phase === "chasing") {
      return beginObserving(state, input.time, input.cursor, samples);
    }
    return {
      ...state,
      samples,
      latestCursor: { ...input.cursor },
    };
  }

  if (state.phase === "idle") {
    if (!quickMovement) {
      return {
        ...state,
        samples,
        latestCursor: { ...input.cursor },
      };
    }
    if (movingAway) {
      return beginChasing(state, input, samples);
    }
    return {
      ...state,
      phase: "noticing",
      phaseStartedAt: input.time,
      samples,
      latestCursor: { ...input.cursor },
      chaseOrigin: null,
      chaseTarget: null,
    };
  }

  if (state.phase === "noticing") {
    return {
      ...state,
      samples,
      latestCursor: { ...input.cursor },
    };
  }

  return {
    ...state,
    samples,
    latestCursor: { ...input.cursor },
    chaseTarget: chaseTarget(input.cursor, input.activityArea, input.petWindowDimensions),
  };
}

export function advanceCursorInteraction(
  state: CursorInteractionState,
  input: CursorInteractionEnvironment,
): CursorInteractionState {
  const scale = normalizedScale(input.coordinateScale);

  if (state.phase === "noticing") {
    if (
      state.latestCursor &&
      input.time - state.phaseStartedAt >= cursorInteractionCadence.noticingMs
    ) {
      return beginChasing(
        state,
        {
          ...input,
          cursor: state.latestCursor,
        },
        state.samples,
      );
    }
    return state;
  }

  if (state.phase === "chasing") {
    const exceededTime =
      input.time - state.phaseStartedAt >= cursorInteractionCadence.chaseMaxMs;
    const exceededTravel =
      state.chaseOrigin !== null &&
      distance(state.chaseOrigin, input.petPosition) >=
        cursorInteractionCadence.chaseMaxTravelLogical * scale;
    const reachedTarget =
      state.chaseTarget !== null &&
      distance(state.chaseTarget, input.petPosition) <=
        cursorInteractionCadence.targetArrivalLogical * scale;
    if (exceededTime || exceededTravel || reachedTarget) {
      return beginObserving(
        state,
        input.time,
        state.latestCursor,
        state.samples,
      );
    }
    return state;
  }

  if (
    state.phase === "observing" &&
    input.time - state.phaseStartedAt >= cursorInteractionCadence.observingMs
  ) {
    return {
      ...state,
      phase: "cooldown",
      phaseStartedAt: input.time,
      samples: [],
      chaseOrigin: null,
      chaseTarget: null,
    };
  }

  if (
    state.phase === "cooldown" &&
    input.time - state.phaseStartedAt >= cursorInteractionCadence.cooldownMs
  ) {
    return createCursorInteractionState();
  }

  return state;
}

export function cursorNoticeOffset(
  state: CursorInteractionState,
  time: number,
): number {
  if (state.phase !== "noticing") {
    return 0;
  }
  const progress = Math.min(
    1,
    Math.max(0, (time - state.phaseStartedAt) / cursorInteractionCadence.noticingMs),
  );
  const lift = progress <= 0.5 ? progress * 2 : (1 - progress) * 2;
  return -cursorInteractionCadence.noticeLiftLogical * lift;
}

function beginChasing(
  state: CursorInteractionState,
  input: CursorInteractionSample,
  samples: CursorSample[],
): CursorInteractionState {
  return {
    ...state,
    phase: "chasing",
    phaseStartedAt: input.time,
    samples,
    latestCursor: { ...input.cursor },
    chaseOrigin: { ...input.petPosition },
    chaseTarget: chaseTarget(input.cursor, input.activityArea, input.petWindowDimensions),
  };
}

function beginObserving(
  state: CursorInteractionState,
  time: number,
  cursor: Point | null,
  samples: CursorSample[],
): CursorInteractionState {
  return {
    ...state,
    phase: "observing",
    phaseStartedAt: time,
    samples,
    latestCursor: cursor ? { ...cursor } : state.latestCursor,
    chaseOrigin: null,
    chaseTarget: null,
  };
}

function chaseTarget(cursor: Point, activityArea: Rect, dimensions: Dimensions): Point {
  return clampPointToRect(topLeftFromCenter(cursor, dimensions), activityArea, dimensions);
}

function appendSample(samples: CursorSample[], sample: CursorSample): CursorSample[] {
  return [
    ...samples.filter(
      (item) => sample.at - item.at <= cursorInteractionCadence.sampleWindowMs,
    ),
    sample,
  ];
}

function cumulativeTravel(samples: CursorSample[]): number {
  let total = 0;
  for (let index = 1; index < samples.length; index += 1) {
    total += distance(samples[index - 1].point, samples[index].point);
  }
  return total;
}

function normalizedScale(value: number): number {
  return Math.max(1, value);
}
