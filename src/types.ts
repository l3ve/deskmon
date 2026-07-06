export type PetSize = "small" | "medium" | "large";
export type ActivityLevel = "quiet" | "standard" | "lively";

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
  petVisible: boolean;
  movementPaused: boolean;
  customActivityArea: Rect | null;
  lastPosition: Point | null;
}

export interface UserPreferences {
  petSize: PetSize;
  activityLevel: ActivityLevel;
  alwaysOnTop: boolean;
  customActivityArea: Rect | null;
}

export interface MonitorPayload {
  name: string | null;
  position: Point;
  size: Dimensions;
  workArea: Rect;
  scaleFactor: number;
}

export interface TimerSnapshot {
  isRunning: boolean;
  durationSeconds: number;
  remainingSeconds: number;
  endsAtMs: number | null;
}

export interface BootstrapPayload {
  settings: Settings;
  monitors: MonitorPayload[];
  activityArea: Rect;
  defaultActivityArea: Rect;
  petDimensions: Dimensions;
  petWindowDimensions: Dimensions;
  petPosition: Point;
  timer: TimerSnapshot;
}

export interface WindowFramePayload {
  position: Point;
  size: Dimensions;
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
