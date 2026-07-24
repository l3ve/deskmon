export type PetSize = "small" | "medium" | "large";
export type ActivityLevel = "quiet" | "standard" | "lively";
export type CliInstallationState = "notInstalled" | "installed" | "updatable" | "conflict";
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
  countdown: CountdownPreferences;
  screenshot: ScreenshotPreferences;
  petVisible: boolean;
  movementPaused: boolean;
  customActivityArea: Rect | null;
  lastPosition: Point | null;
}

export interface ScreenshotPreferences {
  saveDirectory: string | null;
}

export interface CountdownPreferences {
  minutes: number;
}

export interface UserPreferences {
  petSize: PetSize;
  activityLevel: ActivityLevel;
  alwaysOnTop: boolean;
  countdown: CountdownPreferences;
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

export interface CountdownSnapshot {
  isRunning: boolean;
  minutes: number | null;
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
  countdown: CountdownSnapshot;
  screenshotDirectory: string;
  cliInstallationState: CliInstallationState;
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
