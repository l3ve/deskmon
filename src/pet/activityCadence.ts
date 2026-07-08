import type { ActivityLevel } from "../types";
import type { PetMood } from "./slime";

export interface ActivityProfile {
  speed: number;
  runChance: number;
  runSpeedMultiplier: number;
  restMs: [number, number];
  arrivalThreshold: number;
  sleepChance: number;
}

export const activityProfiles: Record<ActivityLevel, ActivityProfile> = {
  quiet: {
    speed: 42,
    runChance: 0.03,
    runSpeedMultiplier: 1.24,
    restMs: [9000, 15000],
    arrivalThreshold: 8,
    sleepChance: 0.34,
  },
  standard: {
    speed: 70,
    runChance: 0.12,
    runSpeedMultiplier: 1.32,
    restMs: [4200, 7800],
    arrivalThreshold: 9,
    sleepChance: 0.18,
  },
  lively: {
    speed: 102,
    runChance: 0.24,
    runSpeedMultiplier: 1.38,
    restMs: [2200, 4800],
    arrivalThreshold: 11,
    sleepChance: 0.08,
  },
};

export const petCadence = {
  dragReleaseRestMs: 2400,
  facingChangeThreshold: 0.35,
  hoverFrameCheckIntervalMs: 250,
  pausedSleepDelayMs: 8000,
  postCelebrationRestMs: 2400,
  windowSyncIntervalMs: 55,
};

export type RestMood = Extract<PetMood, "idle" | "sleep">;

export function chooseRestMood(profile: ActivityProfile): RestMood {
  return Math.random() < profile.sleepChance ? "sleep" : "idle";
}
