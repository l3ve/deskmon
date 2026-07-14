export type PetSize = "small" | "medium" | "large";
export type ActivityLevel = "quiet" | "standard" | "lively";
export type TimerKind = "focus" | "break";
export type FocusSessionPhase =
  | "idle"
  | "focusRunning"
  | "focusComplete"
  | "breakRunning"
  | "breakComplete";
export type FocusSessionAction =
  | "cancelRound"
  | "startBreak"
  | "extendFocus"
  | "finishBreakEarly"
  | "resumeFocus"
  | "extendBreak"
  | "endRound";

export interface Point {
  x: number;
  y: number;
}

export interface Dimensions {
  width: number;
  height: number;
}

export interface Rect extends Point, Dimensions {}

export interface Settings {
  petSize: PetSize;
  activityLevel: ActivityLevel;
  alwaysOnTop: boolean;
  focusTimer: FocusTimerPreferences;
  screenshot: ScreenshotPreferences;
  petVisible: boolean;
  movementPaused: boolean;
  customActivityArea: Rect | null;
  lastPosition: Point | null;
}

export interface ScreenshotPreferences {
  saveDirectory: string | null;
}

export interface FocusTimerPreferences {
  focusMinutes: [number, number, number];
  breakMinutes: number;
  focusFinishedMessage: string;
  breakFinishedMessage: string;
  breakSoundEnabled: boolean;
}

export interface UserPreferences {
  petSize: PetSize;
  activityLevel: ActivityLevel;
  alwaysOnTop: boolean;
  focusTimer: FocusTimerPreferences;
  screenshot: ScreenshotPreferences;
  customActivityArea: Rect | null;
}

export interface MonitorPayload {
  name: string | null;
  position: Point;
  size: Dimensions;
  workArea: Rect;
  scaleFactor: number;
}

export interface FocusSessionSnapshot {
  phase: FocusSessionPhase;
  isRunning: boolean;
  kind: TimerKind | null;
  durationSeconds: number;
  remainingSeconds: number;
  endsAtMs: number | null;
  baseFocusMinutes: number | null;
  breakMinutes: number | null;
}

export interface BootstrapPayload {
  settings: Settings;
  monitors: MonitorPayload[];
  activityArea: Rect;
  defaultActivityArea: Rect;
  petDimensions: Dimensions;
  petWindowDimensions: Dimensions;
  petPosition: Point;
  focusSession: FocusSessionSnapshot;
  screenshotDirectory: string;
}

export interface WindowFramePayload {
  position: Point;
  size: Dimensions;
  cursor: Point;
}

export interface FocusPresentationContext {
  monitors: MonitorPayload[];
  cursor: Point;
}

export type RememberSource = "recent" | "notebook";

export interface RememberItem {
  id: string;
  text: string;
  preview: string;
  pinned: boolean;
  truncated: boolean;
}

export interface RememberVariableItem {
  id: string;
  key: string;
  note: string | null;
}

export interface RememberSnapshot {
  recent: RememberItem[];
  notebook: RememberItem[];
  variables: RememberVariableItem[];
  error: string | null;
  recentLimit: number;
  notebookLimit: number;
  variableLimit: number;
  variableClipboardCleanupEnabled: boolean;
  textLimit: number;
  previewChars: number;
}
