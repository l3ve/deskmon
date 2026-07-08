import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import {
  clampPointToRect,
  cursorInsideFrame,
  distance,
  moveTowards,
  near,
  pointInsideRect,
  randomBetween,
  topLeftFromCenter,
} from "./pet/geometry";
import {
  createGiantCelebration,
  getGiantPresentationFrame,
  getGiantRestoreTarget,
  giantCelebrationTotalMs,
  giantPresentationSyncIntervalMs,
  type GiantCelebrationState,
  type GiantPresentationFrame,
  type TemporaryPetPresentation,
} from "./pet/giantCelebration";
import {
  activityProfiles,
  chooseRestMood,
  petCadence,
  type RestMood,
} from "./pet/activityCadence";
import { spriteSlimeSkin, type PetFacing, type PetMood, type PetSkin } from "./pet/slime";
import type {
  BootstrapPayload,
  Dimensions,
  MonitorPayload,
  Point,
  Rect,
  Settings,
  TimerSnapshot,
  WindowFramePayload,
} from "./types";

interface DragState {
  pointerId: number;
  startScreen: Point;
  offset: Point;
  active: boolean;
}

const clickThreshold = 7;
const spriteCanvasSize = 32;

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
  private restMood: RestMood = "idle";
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
      if (!this.timer.isRunning && time > this.restUntil + petCadence.pausedSleepDelayMs) {
        this.mood = "sleep";
      }
      return;
    }

    if (time < this.restUntil) {
      this.mood = this.timer.isRunning ? "timer-waiting" : this.restMood;
      return;
    }

    const coordinateScale = this.coordinateScale();
    const profile = activityProfiles[settings.activityLevel];

    if (!this.target || near(this.position, this.target, profile.arrivalThreshold * coordinateScale)) {
      this.requestWindowMove(this.position, true);
      this.restUntil = time + randomBetween(profile.restMs[0], profile.restMs[1]);
      this.restMood = chooseRestMood(profile);
      this.mood = this.timer.isRunning ? "timer-waiting" : this.restMood;
      this.pickTarget();
      return;
    }

    const speed =
      profile.speed * coordinateScale * (this.isMovingFast ? profile.runSpeedMultiplier : 1);
    const next = moveTowards(this.position, this.target, speed * dtSeconds);
    this.updateFacing(next.x - this.position.x);
    this.position = clampPointToRect(next, this.activityArea, this.petWindowDimensions);
    this.mood = this.timer.isRunning ? "timer-waiting" : this.isMovingFast ? "run" : "walk";
    this.syncWindowPosition(time);
  }

  private updateFacing(deltaX: number): void {
    if (Math.abs(deltaX) < petCadence.facingChangeThreshold) {
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
      time - this.lastHoverFrameCheck < petCadence.hoverFrameCheckIntervalMs
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
    if (time - this.lastWindowSync < petCadence.windowSyncIntervalMs) {
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

    const celebration = createGiantCelebration({
      startedAt: time,
      petDimensions: this.petDimensions,
      petWindowDimensions: this.petWindowDimensions,
      position: this.position,
      monitors: this.monitors,
      activityArea: this.activityArea,
      coordinateScale: this.coordinateScale(),
    });
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

    const frame = getGiantPresentationFrame(
      celebration,
      elapsed,
      this.getGiantRestoreTarget(celebration),
    );
    this.applyGiantPresentationFrame(frame, time, forceSync);
    this.mood = "celebrate";
  }

  private getGiantRestoreTarget(celebration: GiantCelebrationState): GiantPresentationFrame {
    return getGiantRestoreTarget(
      celebration,
      this.monitors,
      this.activityArea,
      this.settings?.alwaysOnTop ?? true,
    );
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
    this.restMood = "idle";
    this.restUntil = performance.now() + petCadence.postCelebrationRestMs;
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
      this.restMood = "idle";
      this.restUntil = performance.now() + petCadence.dragReleaseRestMs;
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

    const grid = spriteCanvasSize;
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
