import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import type {
  ActivityLevel,
  BootstrapPayload,
  Dimensions,
  MonitorPayload,
  Point,
  Rect,
  Settings,
  TimerSnapshot,
  WindowFramePayload,
} from "./types";

type PetMood =
  | "idle"
  | "walk"
  | "run"
  | "sleep"
  | "timer-waiting"
  | "celebrate"
  | "dragged";
type PetFacing = "left" | "right";

interface DragState {
  pointerId: number;
  startScreen: Point;
  offset: Point;
  active: boolean;
}

interface ActivityProfile {
  speed: number;
  runChance: number;
  restMs: [number, number];
}

interface PetSkin {
  id: string;
  draw(ctx: CanvasRenderingContext2D, mood: PetMood, time: number, facing: PetFacing): void;
}

interface SpriteSheetDefinition {
  src: string;
  columns: number;
  rows: number;
  fps: number;
  directionalRows?: Partial<Record<PetFacing, number>>;
}

interface SpriteFrame {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  anchorX: number;
  anchorY: number;
  anchorWidth: number;
  anchorHeight: number;
}

interface LoadedSpriteSheet {
  canvas: HTMLCanvasElement;
  frames: SpriteFrame[];
  columns: number;
  directionalRows?: Partial<Record<PetFacing, number>>;
  fps: number;
}

interface FrameBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface GiantCelebrationState {
  startedAt: number;
  normalCenter: Point;
  normalPetDimensions: Dimensions;
  normalWindowDimensions: Dimensions;
  targetCenter: Point;
  targetPetDimensions: Dimensions;
  targetWindowDimensions: Dimensions;
  restorePetDimensions: Dimensions;
  restoreWindowDimensions: Dimensions;
  lastPresentationSync: number;
}

interface GiantPresentationFrame {
  center: Point;
  petDimensions: Dimensions;
  windowDimensions: Dimensions;
  alwaysOnTop: boolean;
}

interface TemporaryPetPresentation {
  position: Point;
  dimensions: Dimensions;
  alwaysOnTop: boolean;
}

const activityProfiles: Record<ActivityLevel, ActivityProfile> = {
  quiet: { speed: 55, runChance: 0.08, restMs: [5000, 9000] },
  standard: { speed: 86, runChance: 0.2, restMs: [2800, 5600] },
  lively: { speed: 128, runChance: 0.34, restMs: [1200, 3400] },
};

const clickThreshold = 7;
const hoverFrameCheckIntervalMs = 250;
const spriteTargetWidth = 28;
const spriteTargetHeight = 25;
const spriteTargetCenterX = 16;
const spriteTargetBaselineY = 30;
const spriteCanvasSize = 32;
const spriteFramePadding = 2;
const spriteMaxDrawWidth = spriteCanvasSize - spriteFramePadding * 2;
const spriteMaxDrawHeight = spriteCanvasSize - spriteFramePadding * 2;
const giantCelebrationEnterMs = 3000;
const giantCelebrationHoldMs = 3000;
const giantCelebrationRestoreMs = 1000;
const giantCelebrationTotalMs =
  giantCelebrationEnterMs + giantCelebrationHoldMs + giantCelebrationRestoreMs;
const giantCelebrationMinPhysicalSize = 320;
const giantCelebrationMaxPhysicalSize = 560;
const giantPresentationSyncIntervalMs = 33;
const defaultSlimeSkin: PetSkin = {
  id: "pixel-slime-default",
  draw: drawSlime,
};

const slimeSpriteSheets: Record<PetMood, SpriteSheetDefinition> = {
  idle: {
    src: new URL("./assets/slime/idle.png", import.meta.url).href,
    columns: 6,
    rows: 1,
    fps: 4,
  },
  walk: {
    src: new URL("./assets/slime/walk.png", import.meta.url).href,
    columns: 6,
    rows: 2,
    fps: 5,
    directionalRows: { left: 0, right: 1 },
  },
  run: {
    src: new URL("./assets/slime/run.png", import.meta.url).href,
    columns: 6,
    rows: 2,
    fps: 8,
    directionalRows: { right: 0, left: 1 },
  },
  sleep: {
    src: new URL("./assets/slime/sleep.png", import.meta.url).href,
    columns: 6,
    rows: 1,
    fps: 3,
  },
  "timer-waiting": {
    src: new URL("./assets/slime/timer-waiting.png", import.meta.url).href,
    columns: 6,
    rows: 1,
    fps: 4,
  },
  celebrate: {
    src: new URL("./assets/slime/celebrate.png", import.meta.url).href,
    columns: 6,
    rows: 1,
    fps: 8,
  },
  dragged: {
    src: new URL("./assets/slime/dragged.png", import.meta.url).href,
    columns: 6,
    rows: 1,
    fps: 4,
  },
};

export function mountPet(root: HTMLElement): void {
  root.className = "pet-root";
  const canvas = document.createElement("canvas");
  canvas.id = "pet-canvas";
  canvas.ariaLabel = "Deskmon";
  root.append(canvas);

  const app = new PetController(canvas);
  app.start();
}

class PetController {
  private activityArea: Rect = { x: 0, y: 0, width: 800, height: 500 };
  private drag: DragState | null = null;
  private isMovingFast = false;
  private lastFrameTime = performance.now();
  private lastHoverFrameCheck = 0;
  private lastWindowSync = 0;
  private facing: PetFacing = "right";
  private giantCelebration: GiantCelebrationState | null = null;
  private mood: PetMood = "idle";
  private monitors: MonitorPayload[] = [];
  private moveInFlight = false;
  private pendingMoveTarget: Point | null = null;
  private pendingTemporaryPresentation: TemporaryPetPresentation | null = null;
  private persistAfterMove = false;
  private petDimensions: Dimensions = { width: 104, height: 104 };
  private petWindowDimensions: Dimensions = { width: 104, height: 104 };
  private pointerOverPet = false;
  private hoverFrameCheckInFlight = false;
  private position: Point = { x: 0, y: 0 };
  private restUntil = 0;
  private settings: Settings | null = null;
  private skin: PetSkin = spriteSlimeSkin;
  private target: Point | null = null;
  private temporaryPresentationInFlight = false;
  private timer: TimerSnapshot = {
    isRunning: false,
    durationSeconds: 0,
    remainingSeconds: 0,
    endsAtMs: null,
  };
  private celebrateUntil = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.canvas.addEventListener("pointerenter", () => {
      this.pointerOverPet = true;
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.pointerOverPet = false;
    });
    this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    this.canvas.addEventListener("pointercancel", () => this.finishDrag());
    this.canvas.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (this.giantCelebration) {
        return;
      }
      void invoke("show_pet_menu");
    });
  }

  async start(): Promise<void> {
    const bootstrap = await invoke<BootstrapPayload>("get_bootstrap");
    this.applyBootstrap(bootstrap);
    void ensureNotificationPermission();
    this.installListeners();
    this.resizeCanvas();
    window.addEventListener("resize", () => this.resizeCanvas());
    this.pickTarget();
    requestAnimationFrame((time) => this.tick(time));
  }

  private installListeners(): void {
    void listen<boolean>("deskmon-pause-changed", (event) => {
      if (this.settings) {
        this.settings.movementPaused = event.payload;
      }
    });
    void listen<TimerSnapshot>("deskmon-timer-changed", (event) => {
      this.timer = event.payload;
      if (event.payload.isRunning && this.giantCelebration) {
        this.finishGiantCelebration();
        this.mood = "timer-waiting";
      }
    });
    void listen("deskmon-timer-finished", () => {
      this.timer = {
        isRunning: false,
        durationSeconds: 0,
        remainingSeconds: 0,
        endsAtMs: null,
      };
      this.handleTimerFinished(performance.now());
    });
    void listen<boolean>("deskmon-visibility-changed", (event) => {
      if (this.settings) {
        this.settings.petVisible = event.payload;
      }
      if (!event.payload && this.giantCelebration) {
        this.finishGiantCelebration();
      }
    });
    void listen("deskmon-settings-changed", async () => {
      const bootstrap = await invoke<BootstrapPayload>("get_desktop_snapshot");
      this.applyBootstrap(bootstrap);
      if (!this.giantCelebration) {
        this.resizeCanvas();
        this.pickTarget();
      }
    });
  }

  private applyBootstrap(bootstrap: BootstrapPayload): void {
    this.settings = bootstrap.settings;
    this.monitors = bootstrap.monitors;
    this.activityArea = bootstrap.activityArea;
    this.timer = bootstrap.timer;
    if (this.giantCelebration) {
      this.giantCelebration.restorePetDimensions = bootstrap.petDimensions;
      this.giantCelebration.restoreWindowDimensions = bootstrap.petWindowDimensions;
      return;
    }
    this.petDimensions = bootstrap.petDimensions;
    this.petWindowDimensions = bootstrap.petWindowDimensions;
    this.position = bootstrap.petPosition;
  }

  private resizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${this.petDimensions.width}px`;
    this.canvas.style.height = `${this.petDimensions.height}px`;
    const width = Math.max(1, Math.round(this.petDimensions.width * dpr));
    const height = Math.max(1, Math.round(this.petDimensions.height * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  private tick(time: number): void {
    const dtSeconds = Math.min(0.05, (time - this.lastFrameTime) / 1000);
    this.lastFrameTime = time;
    this.updateMovement(time, dtSeconds);
    this.draw(time);
    requestAnimationFrame((nextTime) => this.tick(nextTime));
  }

  private updateMovement(time: number, dtSeconds: number): void {
    const settings = this.settings;
    if (!settings) {
      return;
    }

    if (this.giantCelebration) {
      this.updateGiantCelebration(time);
      return;
    }

    if (this.drag?.active) {
      this.mood = "dragged";
      return;
    }

    if (time < this.celebrateUntil) {
      this.mood = "celebrate";
      return;
    }

    if (this.timer.isRunning) {
      this.mood = "timer-waiting";
    }

    if (this.pointerOverPet) {
      this.reconcilePointerHover(time);
    }

    if (this.pointerOverPet) {
      this.mood = this.timer.isRunning ? "timer-waiting" : "idle";
      return;
    }

    if (settings.movementPaused) {
      if (!this.timer.isRunning && time > this.restUntil + 7000) {
        this.mood = "sleep";
      }
      return;
    }

    if (time < this.restUntil) {
      this.mood = this.timer.isRunning ? "timer-waiting" : "idle";
      return;
    }

    const coordinateScale = this.coordinateScale();

    if (!this.target || near(this.position, this.target, 10 * coordinateScale)) {
      this.requestWindowMove(this.position, true);
      this.pickTarget();
      const profile = activityProfiles[settings.activityLevel];
      this.restUntil = time + randomBetween(profile.restMs[0], profile.restMs[1]);
      this.mood = Math.random() > 0.82 ? "sleep" : "idle";
      return;
    }

    const profile = activityProfiles[settings.activityLevel];
    const speed = profile.speed * coordinateScale * (this.isMovingFast ? 1.55 : 1);
    const next = moveTowards(this.position, this.target, speed * dtSeconds);
    this.updateFacing(next.x - this.position.x);
    this.position = clampPointToRect(next, this.activityArea, this.petWindowDimensions);
    this.mood = this.timer.isRunning ? "timer-waiting" : this.isMovingFast ? "run" : "walk";
    this.syncWindowPosition(time);
  }

  private updateFacing(deltaX: number): void {
    if (Math.abs(deltaX) < 0.2) {
      return;
    }
    this.facing = deltaX < 0 ? "left" : "right";
  }

  private coordinateScale(): number {
    return this.petDimensions.width > 0
      ? Math.max(1, this.petWindowDimensions.width / this.petDimensions.width)
      : 1;
  }

  private reconcilePointerHover(time: number): void {
    if (
      this.hoverFrameCheckInFlight ||
      time - this.lastHoverFrameCheck < hoverFrameCheckIntervalMs
    ) {
      return;
    }

    this.hoverFrameCheckInFlight = true;
    this.lastHoverFrameCheck = time;
    invoke<WindowFramePayload>("get_pet_window_frame")
      .then((frame) => {
        this.pointerOverPet = cursorInsideFrame(frame);
      })
      .catch(() => {
        // Keep the DOM hover state if the native cursor probe is unavailable.
      })
      .finally(() => {
        this.hoverFrameCheckInFlight = false;
      });
  }

  private pickTarget(): void {
    const settings = this.settings;
    const profile = settings ? activityProfiles[settings.activityLevel] : activityProfiles.standard;
    this.isMovingFast = Math.random() < profile.runChance;

    if (!pointInsideRect(this.position, this.activityArea, this.petWindowDimensions)) {
      this.target = {
        x:
          this.activityArea.x +
          this.activityArea.width * 0.5 -
          this.petWindowDimensions.width * 0.5,
        y:
          this.activityArea.y +
          this.activityArea.height * 0.5 -
          this.petWindowDimensions.height * 0.5,
      };
      return;
    }

    this.target = {
      x:
        this.activityArea.x +
        Math.random() * Math.max(1, this.activityArea.width - this.petWindowDimensions.width),
      y:
        this.activityArea.y +
        Math.random() * Math.max(1, this.activityArea.height - this.petWindowDimensions.height),
    };
  }

  private syncWindowPosition(time: number): void {
    if (time - this.lastWindowSync < 55) {
      return;
    }
    this.lastWindowSync = time;
    this.requestWindowMove(this.position);
  }

  private requestWindowMove(point: Point, persistAfterMove = false): void {
    this.pendingMoveTarget = { ...point };
    this.persistAfterMove ||= persistAfterMove;
    this.flushWindowMove();
  }

  private flushWindowMove(): void {
    if (this.moveInFlight || !this.pendingMoveTarget) {
      return;
    }

    const point = this.pendingMoveTarget;
    this.pendingMoveTarget = null;
    this.moveInFlight = true;
    invoke<Point>("move_pet_window", { x: point.x, y: point.y })
      .then((savedPoint) => {
        if (!this.pendingMoveTarget) {
          this.position = savedPoint;
        }
      })
      .catch(() => {
        // Keep animating locally if a transient native move fails.
      })
      .finally(() => {
        this.moveInFlight = false;
        if (this.pendingMoveTarget) {
          this.flushWindowMove();
          return;
        }
        if (this.persistAfterMove) {
          this.persistAfterMove = false;
          void invoke("persist_pet_position").catch(() => {
            // Position persistence is best-effort; movement itself already succeeded.
          });
        }
      });
  }

  private handleTimerFinished(time: number): void {
    if (this.settings?.petVisible === false || this.drag?.active) {
      this.celebrateUntil = 0;
      return;
    }

    const celebration = this.createGiantCelebration(time);
    if (!celebration) {
      this.celebrateUntil = time + 5200;
      return;
    }

    this.celebrateUntil = 0;
    this.giantCelebration = celebration;
    this.pointerOverPet = false;
    this.target = null;
    this.mood = "celebrate";
    this.updateGiantCelebration(time, true);
  }

  private createGiantCelebration(startedAt: number): GiantCelebrationState | null {
    const normalPetDimensions = { ...this.petDimensions };
    const normalWindowDimensions = { ...this.petWindowDimensions };
    const normalCenter = centerOf(this.position, normalWindowDimensions);
    const monitor = monitorForPoint(normalCenter, this.monitors) ?? this.monitors[0];
    const workArea = monitor?.workArea ?? this.activityArea;
    const scaleFactor = monitor?.scaleFactor ?? this.coordinateScale();
    const physicalLimit = Math.max(1, Math.min(workArea.width, workArea.height));
    const targetSide = Math.min(
      physicalLimit,
      clamp(
        physicalLimit * 0.45,
        Math.min(giantCelebrationMinPhysicalSize, physicalLimit),
        Math.min(giantCelebrationMaxPhysicalSize, physicalLimit),
      ),
    );
    if (targetSide <= 0 || scaleFactor <= 0) {
      return null;
    }

    const targetWindowDimensions = { width: targetSide, height: targetSide };
    const targetPetDimensions = {
      width: targetSide / scaleFactor,
      height: targetSide / scaleFactor,
    };
    const sizeProgress = clamp(
      (targetSide - giantCelebrationMinPhysicalSize) /
        (giantCelebrationMaxPhysicalSize - giantCelebrationMinPhysicalSize),
      0,
      1,
    );
    const targetCenter = centerOf(
      clampPointToRect(
        {
          x: workArea.x + workArea.width * 0.5 - targetWindowDimensions.width * 0.5,
          y:
            workArea.y +
            workArea.height * lerp(0.58, 0.52, sizeProgress) -
            targetWindowDimensions.height * 0.5,
        },
        workArea,
        targetWindowDimensions,
      ),
      targetWindowDimensions,
    );

    return {
      startedAt,
      normalCenter,
      normalPetDimensions,
      normalWindowDimensions,
      targetCenter,
      targetPetDimensions,
      targetWindowDimensions,
      restorePetDimensions: normalPetDimensions,
      restoreWindowDimensions: normalWindowDimensions,
      lastPresentationSync: 0,
    };
  }

  private updateGiantCelebration(time: number, forceSync = false): void {
    const celebration = this.giantCelebration;
    if (!celebration) {
      return;
    }

    const elapsed = time - celebration.startedAt;
    if (elapsed >= giantCelebrationTotalMs) {
      this.finishGiantCelebration();
      return;
    }

    const frame = this.getGiantPresentationFrame(celebration, elapsed);
    this.applyGiantPresentationFrame(frame, time, forceSync);
    this.mood = "celebrate";
  }

  private getGiantPresentationFrame(
    celebration: GiantCelebrationState,
    elapsed: number,
  ): GiantPresentationFrame {
    if (elapsed < giantCelebrationEnterMs) {
      const progress = easeOutCubic(elapsed / giantCelebrationEnterMs);
      return {
        center: lerpPoint(celebration.normalCenter, celebration.targetCenter, progress),
        petDimensions: lerpDimensions(
          celebration.normalPetDimensions,
          celebration.targetPetDimensions,
          progress,
        ),
        windowDimensions: lerpDimensions(
          celebration.normalWindowDimensions,
          celebration.targetWindowDimensions,
          progress,
        ),
        alwaysOnTop: true,
      };
    }

    if (elapsed < giantCelebrationEnterMs + giantCelebrationHoldMs) {
      return {
        center: celebration.targetCenter,
        petDimensions: celebration.targetPetDimensions,
        windowDimensions: celebration.targetWindowDimensions,
        alwaysOnTop: true,
      };
    }

    const restoreTarget = this.getGiantRestoreTarget(celebration);
    const progress = easeInOutCubic(
      (elapsed - giantCelebrationEnterMs - giantCelebrationHoldMs) /
        giantCelebrationRestoreMs,
    );
    return {
      center: lerpPoint(celebration.targetCenter, restoreTarget.center, progress),
      petDimensions: lerpDimensions(
        celebration.targetPetDimensions,
        restoreTarget.petDimensions,
        progress,
      ),
      windowDimensions: lerpDimensions(
        celebration.targetWindowDimensions,
        restoreTarget.windowDimensions,
        progress,
      ),
      alwaysOnTop: true,
    };
  }

  private getGiantRestoreTarget(celebration: GiantCelebrationState): GiantPresentationFrame {
    const workArea =
      monitorForPoint(celebration.normalCenter, this.monitors)?.workArea ?? this.activityArea;
    const position = clampPointToRect(
      topLeftFromCenter(celebration.normalCenter, celebration.restoreWindowDimensions),
      workArea,
      celebration.restoreWindowDimensions,
    );
    return {
      center: centerOf(position, celebration.restoreWindowDimensions),
      petDimensions: celebration.restorePetDimensions,
      windowDimensions: celebration.restoreWindowDimensions,
      alwaysOnTop: this.settings?.alwaysOnTop ?? true,
    };
  }

  private applyGiantPresentationFrame(
    frame: GiantPresentationFrame,
    time: number,
    forceSync = false,
  ): void {
    const position = topLeftFromCenter(frame.center, frame.windowDimensions);
    this.petDimensions = frame.petDimensions;
    this.petWindowDimensions = frame.windowDimensions;
    this.position = position;
    this.resizeCanvas();

    const celebration = this.giantCelebration;
    if (
      !celebration ||
      (!forceSync &&
        time - celebration.lastPresentationSync < giantPresentationSyncIntervalMs)
    ) {
      return;
    }
    celebration.lastPresentationSync = time;
    this.requestTemporaryPetPresentation({
      position,
      dimensions: frame.petDimensions,
      alwaysOnTop: frame.alwaysOnTop,
    });
  }

  private finishGiantCelebration(): void {
    const celebration = this.giantCelebration;
    if (!celebration) {
      return;
    }

    const restoreTarget = this.getGiantRestoreTarget(celebration);
    const position = topLeftFromCenter(restoreTarget.center, restoreTarget.windowDimensions);
    this.giantCelebration = null;
    this.petDimensions = restoreTarget.petDimensions;
    this.petWindowDimensions = restoreTarget.windowDimensions;
    this.position = position;
    this.mood = this.timer.isRunning ? "timer-waiting" : "idle";
    this.restUntil = performance.now() + 1800;
    this.resizeCanvas();
    this.requestTemporaryPetPresentation({
      position,
      dimensions: restoreTarget.petDimensions,
      alwaysOnTop: restoreTarget.alwaysOnTop,
    });
    this.pickTarget();
  }

  private requestTemporaryPetPresentation(presentation: TemporaryPetPresentation): void {
    this.pendingTemporaryPresentation = presentation;
    this.flushTemporaryPetPresentation();
  }

  private flushTemporaryPetPresentation(): void {
    if (this.temporaryPresentationInFlight || !this.pendingTemporaryPresentation) {
      return;
    }

    const presentation = this.pendingTemporaryPresentation;
    this.pendingTemporaryPresentation = null;
    this.temporaryPresentationInFlight = true;
    invoke("set_pet_temporary_presentation", {
      x: presentation.position.x,
      y: presentation.position.y,
      width: presentation.dimensions.width,
      height: presentation.dimensions.height,
      alwaysOnTop: presentation.alwaysOnTop,
    })
      .catch(() => {
        // A transient native presentation failure should not break the pet loop.
      })
      .finally(() => {
        this.temporaryPresentationInFlight = false;
        if (this.pendingTemporaryPresentation) {
          this.flushTemporaryPetPresentation();
        }
      });
  }

  private async onPointerDown(event: PointerEvent): Promise<void> {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    if (this.giantCelebration) {
      return;
    }
    this.canvas.setPointerCapture(event.pointerId);
    const dpr = window.devicePixelRatio || 1;
    let frame: WindowFramePayload | null = null;
    try {
      frame = await invoke<WindowFramePayload>("get_pet_window_frame");
    } catch {
      frame = null;
    }
    this.drag = {
      pointerId: event.pointerId,
      active: false,
      startScreen: {
        x: event.screenX * dpr,
        y: event.screenY * dpr,
      },
      offset: frame
        ? {
            x: frame.cursor.x - frame.position.x,
            y: frame.cursor.y - frame.position.y,
          }
        : {
            x: event.clientX * dpr,
            y: event.clientY * dpr,
          },
    };
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.giantCelebration) {
      return;
    }
    if (!this.drag || this.drag.pointerId !== event.pointerId) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const screen = {
      x: event.screenX * dpr,
      y: event.screenY * dpr,
    };
    const moved = distance(screen, this.drag.startScreen);
    if (!this.drag.active && moved > clickThreshold * dpr) {
      this.drag.active = true;
      this.mood = "dragged";
    }
    if (!this.drag.active) {
      return;
    }
    event.preventDefault();
    const next = {
      x: screen.x - this.drag.offset.x,
      y: screen.y - this.drag.offset.y,
    };
    this.position = next;
    this.requestWindowMove(next);
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.giantCelebration) {
      this.finishDrag();
      return;
    }
    if (!this.drag || this.drag.pointerId !== event.pointerId) {
      return;
    }
    const wasDrag = this.drag.active;
    const finalPosition = { ...this.position };
    this.finishDrag();
    if (wasDrag) {
      this.requestWindowMove(finalPosition, true);
      this.restUntil = performance.now() + 1800;
      this.pickTarget();
    }
  }

  private finishDrag(): void {
    if (this.drag) {
      try {
        this.canvas.releasePointerCapture(this.drag.pointerId);
      } catch {
        // The pointer may already be released by the OS.
      }
    }
    this.drag = null;
  }

  private draw(time: number): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const width = this.canvas.width;
    const height = this.canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = false;

    const grid = 32;
    const scale = Math.floor(Math.min(width, height) / grid);
    const offsetX = Math.floor((width - grid * scale) / 2);
    const offsetY = Math.floor((height - grid * scale) / 2);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    this.skin.draw(ctx, this.mood, time, this.facing);
    ctx.restore();
  }
}

async function ensureNotificationPermission(): Promise<void> {
  try {
    if (await isPermissionGranted()) {
      return;
    }
    await requestPermission();
  } catch {
    // Timer completion still emits an in-app event if the OS denies notifications.
  }
}

class SpriteSheetSlimeSkin implements PetSkin {
  id = "sprite-sheet-slime";
  private readonly sheets = new Map<PetMood, LoadedSpriteSheet>();

  constructor(
    definitions: Record<PetMood, SpriteSheetDefinition>,
    private readonly fallback: PetSkin,
  ) {
    for (const [mood, definition] of Object.entries(definitions) as [
      PetMood,
      SpriteSheetDefinition,
    ][]) {
      void loadSpriteSheet(definition)
        .then((sheet) => {
          this.sheets.set(mood, sheet);
        })
        .catch(() => {
          this.sheets.delete(mood);
        });
    }
  }

  draw(ctx: CanvasRenderingContext2D, mood: PetMood, time: number, facing: PetFacing): void {
    const sheet = this.sheets.get(mood);
    if (!sheet) {
      this.fallback.draw(ctx, mood, time, facing);
      return;
    }

    const frameIndex = getSpriteFrameIndex(sheet, time, facing);
    const frame = sheet.frames[frameIndex];
    const scale = Math.min(
      spriteTargetWidth / frame.anchorWidth,
      spriteTargetHeight / frame.anchorHeight,
      spriteMaxDrawWidth / frame.sourceWidth,
      spriteMaxDrawHeight / frame.sourceHeight,
    );
    const width = Math.round(frame.sourceWidth * scale);
    const height = Math.round(frame.sourceHeight * scale);
    const anchorX = frame.anchorX * scale;
    const anchorY = frame.anchorY * scale;
    const anchorWidth = frame.anchorWidth * scale;
    const anchorHeight = frame.anchorHeight * scale;
    const x = clampSpritePosition(
      Math.round(spriteTargetCenterX - anchorX - anchorWidth * 0.5),
      width,
    );
    const y = clampSpritePosition(
      Math.round(spriteTargetBaselineY - anchorY - anchorHeight),
      height,
    );

    ctx.drawImage(
      sheet.canvas,
      frame.sourceX,
      frame.sourceY,
      frame.sourceWidth,
      frame.sourceHeight,
      x,
      y,
      width,
      height,
    );
  }
}

const spriteSlimeSkin = new SpriteSheetSlimeSkin(slimeSpriteSheets, defaultSlimeSkin);

async function loadSpriteSheet(definition: SpriteSheetDefinition): Promise<LoadedSpriteSheet> {
  const image = await loadImage(definition.src);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Sprite sheet canvas context is unavailable");
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const frameWidth = Math.floor(canvas.width / definition.columns);
  const frameHeight = Math.floor(canvas.height / definition.rows);
  const frames: SpriteFrame[] = [];

  for (let row = 0; row < definition.rows; row += 1) {
    for (let column = 0; column < definition.columns; column += 1) {
      frames.push(
        getFrameBounds(
          imageData,
          canvas.width,
          column * frameWidth,
          row * frameHeight,
          frameWidth,
          frameHeight,
        ),
      );
    }
  }

  return {
    canvas,
    frames,
    columns: definition.columns,
    directionalRows: definition.directionalRows,
    fps: definition.fps,
  };
}

function getSpriteFrameIndex(
  sheet: LoadedSpriteSheet,
  time: number,
  facing: PetFacing,
): number {
  const animationFrame = Math.floor((time / 1000) * sheet.fps);
  const directionalRow = sheet.directionalRows?.[facing];
  if (directionalRow !== undefined) {
    return directionalRow * sheet.columns + (animationFrame % sheet.columns);
  }
  return animationFrame % sheet.frames.length;
}

function clampSpritePosition(value: number, size: number): number {
  if (size >= spriteCanvasSize - spriteFramePadding * 2) {
    return spriteFramePadding;
  }
  return clamp(value, spriteFramePadding, spriteCanvasSize - spriteFramePadding - size);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load sprite sheet: ${src}`));
    image.src = src;
  });
}

function getFrameBounds(
  imageData: ImageData,
  imageWidth: number,
  frameX: number,
  frameY: number,
  frameWidth: number,
  frameHeight: number,
): SpriteFrame {
  const content = getContentBounds(imageData, imageWidth, frameX, frameY, frameWidth, frameHeight);
  if (!content) {
    return {
      sourceX: frameX,
      sourceY: frameY,
      sourceWidth: frameWidth,
      sourceHeight: frameHeight,
      anchorX: 0,
      anchorY: 0,
      anchorWidth: frameWidth,
      anchorHeight: frameHeight,
    };
  }

  const anchor =
    getLargestComponentBounds(imageData, imageWidth, frameX, frameY, frameWidth, frameHeight) ??
    content;

  return {
    sourceX: frameX + content.minX,
    sourceY: frameY + content.minY,
    sourceWidth: content.maxX - content.minX + 1,
    sourceHeight: content.maxY - content.minY + 1,
    anchorX: anchor.minX - content.minX,
    anchorY: anchor.minY - content.minY,
    anchorWidth: anchor.maxX - anchor.minX + 1,
    anchorHeight: anchor.maxY - anchor.minY + 1,
  };
}

function getContentBounds(
  imageData: ImageData,
  imageWidth: number,
  frameX: number,
  frameY: number,
  frameWidth: number,
  frameHeight: number,
): FrameBounds | null {
  let minX = frameWidth;
  let minY = frameHeight;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const index = ((frameY + y) * imageWidth + frameX + x) * 4;
      if (imageData.data[index + 3] === 0) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  return minX > maxX || minY > maxY ? null : { minX, minY, maxX, maxY };
}

function getLargestComponentBounds(
  imageData: ImageData,
  imageWidth: number,
  frameX: number,
  frameY: number,
  frameWidth: number,
  frameHeight: number,
): FrameBounds | null {
  const visited = new Uint8Array(frameWidth * frameHeight);
  let bestBounds: FrameBounds | null = null;
  let bestArea = 0;

  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const localIndex = y * frameWidth + x;
      if (visited[localIndex]) {
        continue;
      }
      const index = ((frameY + y) * imageWidth + frameX + x) * 4;
      if (imageData.data[index + 3] === 0) {
        visited[localIndex] = 1;
        continue;
      }

      const component = collectComponentBounds(
        imageData,
        imageWidth,
        frameX,
        frameY,
        frameWidth,
        frameHeight,
        x,
        y,
        visited,
      );
      if (component.area > bestArea) {
        bestArea = component.area;
        bestBounds = component.bounds;
      }
    }
  }

  return bestBounds;
}

function collectComponentBounds(
  imageData: ImageData,
  imageWidth: number,
  frameX: number,
  frameY: number,
  frameWidth: number,
  frameHeight: number,
  startX: number,
  startY: number,
  visited: Uint8Array,
): { bounds: FrameBounds; area: number } {
  const stack: number[] = [];
  const bounds: FrameBounds = { minX: startX, minY: startY, maxX: startX, maxY: startY };
  let area = 0;
  pushComponentPixel(
    stack,
    visited,
    imageData,
    imageWidth,
    frameX,
    frameY,
    frameWidth,
    frameHeight,
    startX,
    startY,
  );

  while (stack.length > 0) {
    const localIndex = stack.pop();
    if (localIndex === undefined) {
      continue;
    }
    const x = localIndex % frameWidth;
    const y = Math.floor(localIndex / frameWidth);

    area += 1;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);

    pushComponentPixel(
      stack,
      visited,
      imageData,
      imageWidth,
      frameX,
      frameY,
      frameWidth,
      frameHeight,
      x + 1,
      y,
    );
    pushComponentPixel(
      stack,
      visited,
      imageData,
      imageWidth,
      frameX,
      frameY,
      frameWidth,
      frameHeight,
      x - 1,
      y,
    );
    pushComponentPixel(
      stack,
      visited,
      imageData,
      imageWidth,
      frameX,
      frameY,
      frameWidth,
      frameHeight,
      x,
      y + 1,
    );
    pushComponentPixel(
      stack,
      visited,
      imageData,
      imageWidth,
      frameX,
      frameY,
      frameWidth,
      frameHeight,
      x,
      y - 1,
    );
  }

  return { bounds, area };
}

function pushComponentPixel(
  stack: number[],
  visited: Uint8Array,
  imageData: ImageData,
  imageWidth: number,
  frameX: number,
  frameY: number,
  frameWidth: number,
  frameHeight: number,
  x: number,
  y: number,
): void {
  if (x < 0 || y < 0 || x >= frameWidth || y >= frameHeight) {
    return;
  }
  const localIndex = y * frameWidth + x;
  if (visited[localIndex]) {
    return;
  }
  visited[localIndex] = 1;
  const index = ((frameY + y) * imageWidth + frameX + x) * 4;
  if (imageData.data[index + 3] === 0) {
    return;
  }
  stack.push(localIndex);
}

function drawSlime(ctx: CanvasRenderingContext2D, mood: PetMood, time: number): void {
  const wave = Math.sin(time / 180);
  const hop = mood === "walk" || mood === "run" ? Math.max(0, wave) : 0;
  const squash = mood === "dragged" ? 1 : mood === "run" ? 0.88 + hop * 0.1 : 1;
  const yShift = mood === "sleep" ? 2 : -hop * (mood === "run" ? 2 : 1);

  pixel(ctx, 7, 25, 18, 2, "#274533");
  pixel(ctx, 8, 24, 16, 1, "#3f6f4e");

  ctx.save();
  ctx.translate(0, yShift);
  ctx.scale(1, squash);

  const body = mood === "timer-waiting" ? "#5eb97f" : "#58c57f";
  const bodyDark = "#248052";
  const bodyMid = "#36a967";
  const shine = "#b9ffd0";

  pixel(ctx, 11, 7, 10, 1, bodyMid);
  pixel(ctx, 8, 8, 16, 2, bodyMid);
  pixel(ctx, 6, 10, 20, 4, body);
  pixel(ctx, 5, 14, 22, 7, body);
  pixel(ctx, 6, 21, 20, 3, bodyDark);
  pixel(ctx, 8, 24, 16, 1, bodyDark);
  pixel(ctx, 7, 11, 5, 2, shine);
  pixel(ctx, 9, 10, 3, 1, "#e9fff0");
  pixel(ctx, 23, 15, 2, 4, bodyMid);
  pixel(ctx, 6, 18, 2, 3, bodyMid);

  if (mood === "sleep") {
    pixel(ctx, 10, 16, 5, 1, "#183223");
    pixel(ctx, 18, 16, 5, 1, "#183223");
    pixel(ctx, 14, 20, 5, 1, "#1f5a39");
  } else {
    const eyeY = mood === "celebrate" ? 14 : 15;
    pixel(ctx, 10, eyeY, 3, 4, "#10251b");
    pixel(ctx, 20, eyeY, 3, 4, "#10251b");
    pixel(ctx, 11, eyeY, 1, 1, "#f7fff9");
    pixel(ctx, 21, eyeY, 1, 1, "#f7fff9");
    if (mood === "timer-waiting") {
      pixel(ctx, 15, 19, 3, 1, "#19432c");
      pixel(ctx, 16, 20, 1, 1, "#19432c");
    } else {
      pixel(ctx, 14, 20, 5, 1, "#19432c");
      pixel(ctx, 15, 21, 3, 1, "#19432c");
    }
  }

  if (mood === "timer-waiting") {
    pixel(ctx, 14, 5, 5, 1, "#2f6d55");
    pixel(ctx, 15, 6, 3, 2, "#f2d16b");
    pixel(ctx, 16, 8, 1, 1, "#2f6d55");
  }

  ctx.restore();

  if (mood === "celebrate") {
    const colors = ["#f26d6d", "#ffd166", "#4aa8ff", "#7bd88f"];
    for (let index = 0; index < 10; index += 1) {
      const angle = time / 260 + index * 0.9;
      const radius = 10 + (index % 3) * 3 + Math.sin(time / 170 + index) * 2;
      const x = 16 + Math.cos(angle) * radius;
      const y = 13 + Math.sin(angle) * radius;
      pixel(ctx, Math.round(x), Math.round(y), 1, 1, colors[index % colors.length]);
    }
  }
}

function pixel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function centerOf(position: Point, dimensions: Dimensions): Point {
  return {
    x: position.x + dimensions.width * 0.5,
    y: position.y + dimensions.height * 0.5,
  };
}

function topLeftFromCenter(center: Point, dimensions: Dimensions): Point {
  return {
    x: center.x - dimensions.width * 0.5,
    y: center.y - dimensions.height * 0.5,
  };
}

function monitorForPoint(point: Point, monitors: MonitorPayload[]): MonitorPayload | null {
  return (
    monitors.find(
      (monitor) =>
        point.x >= monitor.workArea.x &&
        point.x <= monitor.workArea.x + monitor.workArea.width &&
        point.y >= monitor.workArea.y &&
        point.y <= monitor.workArea.y + monitor.workArea.height,
    ) ?? null
  );
}

function cursorInsideFrame(frame: WindowFramePayload): boolean {
  return (
    frame.cursor.x >= frame.position.x &&
    frame.cursor.y >= frame.position.y &&
    frame.cursor.x <= frame.position.x + frame.size.width &&
    frame.cursor.y <= frame.position.y + frame.size.height
  );
}

function near(a: Point, b: Point, threshold: number): boolean {
  return distance(a, b) <= threshold;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function moveTowards(current: Point, target: Point, maxDistance: number): Point {
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  const length = Math.hypot(dx, dy);
  if (length <= maxDistance || length === 0) {
    return target;
  }
  return {
    x: current.x + (dx / length) * maxDistance,
    y: current.y + (dy / length) * maxDistance,
  };
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function lerpPoint(start: Point, end: Point, progress: number): Point {
  return {
    x: lerp(start.x, end.x, progress),
    y: lerp(start.y, end.y, progress),
  };
}

function lerpDimensions(start: Dimensions, end: Dimensions, progress: number): Dimensions {
  return {
    width: lerp(start.width, end.width, progress),
    height: lerp(start.height, end.height, progress),
  };
}

function easeOutCubic(progress: number): number {
  const t = clamp(progress, 0, 1);
  return 1 - (1 - t) ** 3;
}

function easeInOutCubic(progress: number): number {
  const t = clamp(progress, 0, 1);
  return t < 0.5 ? 4 * t ** 3 : 1 - ((-2 * t + 2) ** 3) / 2;
}

function pointInsideRect(point: Point, rect: Rect, dimensions: Dimensions): boolean {
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x + dimensions.width <= rect.x + rect.width &&
    point.y + dimensions.height <= rect.y + rect.height
  );
}

function clampPointToRect(point: Point, rect: Rect, dimensions: Dimensions): Point {
  return {
    x: clamp(point.x, rect.x, Math.max(rect.x, rect.x + rect.width - dimensions.width)),
    y: clamp(point.y, rect.y, Math.max(rect.y, rect.y + rect.height - dimensions.height)),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
