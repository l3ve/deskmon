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
} from "./pet/geometry";
import {
  activityProfiles,
  chooseRestMood,
  petCadence,
  type RestMood,
} from "./pet/activityCadence";
import {
  advanceCursorInteraction,
  cancelCursorInteraction,
  createCursorInteractionState,
  cursorChaseSpeed,
  cursorInteractionAllowed,
  cursorInteractionCadence,
  cursorNoticeOffset,
  sampleCursorInteraction,
  type CursorInteractionPhase,
  type CursorInteractionState,
} from "./pet/cursorInteraction";
import {
  createReminderPresentationSession,
  type ReminderPayload,
  type ReminderPresentationEnvironment,
  type ReminderPresentationSession,
  type ReminderPresentationStatus,
} from "./pet/reminderPresentation/session";
import { spriteSlimeSkin, type PetFacing, type PetMood, type PetSkin } from "./pet/slime";
import type {
  BootstrapPayload,
  CountdownSnapshot,
  Dimensions,
  MonitorPayload,
  Point,
  Rect,
  Settings,
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
  new PetController(root, canvas).start();
}

class PetController {
  private activityArea: Rect = { x: 0, y: 0, width: 800, height: 500 };
  private countdown: CountdownSnapshot = {
    isRunning: false,
    minutes: null,
    durationSeconds: 0,
    remainingSeconds: 0,
    endsAtMs: null,
  };
  private drag: DragState | null = null;
  private facing: PetFacing = "right";
  private hoverFrameCheckInFlight = false;
  private isMovingFast = false;
  private lastFrameTime = performance.now();
  private lastHoverFrameCheck = 0;
  private lastWindowSync = 0;
  private mood: PetMood = "idle";
  private monitors: MonitorPayload[] = [];
  private moveInFlight = false;
  private pendingMoveTarget: Point | null = null;
  private persistAfterMove = false;
  private petDimensions: Dimensions = { width: 104, height: 104 };
  private petWindowDimensions: Dimensions = { width: 104, height: 104 };
  private pointerOverPet = false;
  private position: Point = { x: 0, y: 0 };
  private reminderPresentation: ReminderPresentationSession;
  private reminderStatus: ReminderPresentationStatus = { active: false, tone: null };
  private restMood: RestMood = "idle";
  private restUntil = 0;
  private screenshotActive = false;
  private settings: Settings | null = null;
  private skin: PetSkin = spriteSlimeSkin;
  private target: Point | null = null;
  private cursorInteraction: CursorInteractionState = createCursorInteractionState();
  private cursorInteractionAppliedPhase: CursorInteractionPhase = "idle";
  private cursorInteractionBlocked = false;
  private cursorInteractionEpoch = 0;
  private cursorInteractionSuppressedUntil = 0;
  private cursorSampleInFlight = false;
  private lastCursorSampleAt = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.reminderPresentation = createReminderPresentationSession({
      root,
      canvas,
      onStatusChanged: (status) => {
        const wasActive = this.reminderStatus.active;
        this.reminderStatus = status;
        this.invalidateCursorInteraction();
        if (wasActive && !status.active && this.persistAfterMove) {
          this.requestWindowMove(this.position, true);
        }
      },
    });
    this.canvas.addEventListener("pointerenter", () => {
      this.pointerOverPet = true;
      this.invalidateCursorInteraction();
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.pointerOverPet = false;
      this.suppressCursorInteraction(cursorInteractionCadence.pointerExitProtectionMs);
    });
    this.root.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.root.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.root.addEventListener("pointerup", (event) => this.onPointerUp(event));
    this.root.addEventListener("pointercancel", () => this.finishDrag());
    this.root.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.suppressCursorInteraction(cursorInteractionCadence.menuProtectionMs);
      void invoke("show_pet_menu");
    });
  }

  async start(): Promise<void> {
    this.applyBootstrap(await invoke<BootstrapPayload>("get_bootstrap"));
    void ensureNotificationPermission();
    this.installListeners();
    this.resizeCanvas();
    this.pickTarget();
    requestAnimationFrame((time) => this.tick(time));
  }

  private installListeners(): void {
    void listen<boolean>("deskmon-pause-changed", (event) => {
      if (this.settings) {
        this.settings.movementPaused = event.payload;
      }
    });
    void listen<ReminderPayload>("deskmon-pet-notification", (event) => {
      this.reminderPresentation.receive(event.payload);
    });
    void listen<CountdownSnapshot>("deskmon-countdown-changed", (event) => {
      this.countdown = event.payload;
      this.invalidateCursorInteraction();
    });
    void listen<boolean>("deskmon-screenshot-state-changed", (event) => {
      this.screenshotActive = event.payload;
      if (event.payload) {
        this.reminderPresentation.pause("screenshot");
      } else {
        this.reminderPresentation.resume("screenshot");
      }
    });
    void listen<boolean>("deskmon-visibility-changed", (event) => {
      if (this.settings) {
        this.settings.petVisible = event.payload;
      }
      this.syncReminderAnchor();
    });
    void listen("deskmon-settings-changed", async () => {
      this.applyBootstrap(await invoke<BootstrapPayload>("get_desktop_snapshot"));
      this.resizeCanvas();
      this.pickTarget();
    });
  }

  private applyBootstrap(bootstrap: BootstrapPayload): void {
    this.settings = bootstrap.settings;
    this.monitors = bootstrap.monitors;
    this.activityArea = bootstrap.activityArea;
    this.petDimensions = bootstrap.petDimensions;
    this.petWindowDimensions = bootstrap.petWindowDimensions;
    this.position = bootstrap.petPosition;
    this.countdown = bootstrap.countdown;
    this.syncReminderAnchor();
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
    const cursorAllowed = this.syncCursorInteractionAvailability(time);
    if (this.drag?.active) {
      this.mood = "dragged";
      return;
    }
    if (this.reminderStatus.active) {
      this.mood = this.reminderStatus.tone === "error" ? "idle" : "celebrate";
      return;
    }
    if (this.countdown.isRunning) {
      this.mood = "timer-waiting";
    }
    if (this.pointerOverPet) {
      this.reconcilePointerHover(time);
      return;
    }
    if (settings.movementPaused) {
      if (!this.countdown.isRunning && time > this.restUntil + petCadence.pausedSleepDelayMs) {
        this.mood = "sleep";
      }
      return;
    }
    if (cursorAllowed && this.updateCursorInteraction(time, dtSeconds)) {
      return;
    }
    if (time < this.restUntil) {
      if (!this.reminderStatus.active) {
        this.mood = this.countdown.isRunning ? "timer-waiting" : this.restMood;
      }
      return;
    }
    const profile = activityProfiles[settings.activityLevel];
    const coordinateScale = this.coordinateScale();
    if (!this.target || near(this.position, this.target, profile.arrivalThreshold * coordinateScale)) {
      this.requestWindowMove(this.position, true);
      this.restUntil = time + randomBetween(profile.restMs[0], profile.restMs[1]);
      this.restMood = chooseRestMood(profile);
      this.pickTarget();
      return;
    }
    const speed =
      profile.speed * coordinateScale * (this.isMovingFast ? profile.runSpeedMultiplier : 1);
    const next = moveTowards(this.position, this.target, speed * dtSeconds);
    this.updateFacing(next.x - this.position.x);
    this.position = clampPointToRect(next, this.activityArea, this.petWindowDimensions);
    if (!this.reminderStatus.active) {
      this.mood = this.countdown.isRunning
        ? "timer-waiting"
        : this.isMovingFast
          ? "run"
          : "walk";
    }
    this.syncWindowPosition(time);
  }

  private syncReminderAnchor(): void {
    const settings = this.settings;
    if (!settings) {
      return;
    }
    const environment: ReminderPresentationEnvironment = {
      petPosition: this.position,
      petDimensions: this.petDimensions,
      petWindowDimensions: this.petWindowDimensions,
      monitors: this.monitors,
      fallbackArea: this.activityArea,
      alwaysOnTop: settings.alwaysOnTop,
      visible: settings.petVisible,
    };
    this.reminderPresentation.anchorChanged(environment);
  }

  private coordinateScale(): number {
    return this.petDimensions.width > 0
      ? Math.max(1, this.petWindowDimensions.width / this.petDimensions.width)
      : 1;
  }

  private updateFacing(deltaX: number): void {
    if (Math.abs(deltaX) >= petCadence.facingChangeThreshold) {
      this.facing = deltaX < 0 ? "left" : "right";
    }
  }

  private pickTarget(): void {
    const settings = this.settings;
    const profile = settings ? activityProfiles[settings.activityLevel] : activityProfiles.standard;
    this.isMovingFast = Math.random() < profile.runChance;
    if (!pointInsideRect(this.position, this.activityArea, this.petWindowDimensions)) {
      this.target = {
        x: this.activityArea.x + this.activityArea.width * 0.5 - this.petWindowDimensions.width * 0.5,
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
    if (this.reminderStatus.active) {
      this.position = { ...point };
      this.persistAfterMove ||= persistAfterMove;
      this.syncReminderAnchor();
      return;
    }
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
      .finally(() => {
        this.moveInFlight = false;
        if (this.pendingMoveTarget) {
          this.flushWindowMove();
        } else if (this.persistAfterMove) {
          this.persistAfterMove = false;
          void invoke("persist_pet_position");
        }
      });
  }

  private cursorInteractionIsAllowed(time: number): boolean {
    return cursorInteractionAllowed({
      petVisible: this.settings?.petVisible === true,
      movementPaused: this.settings?.movementPaused !== false,
      focusActive: this.countdown.isRunning,
      screenshotActive: this.screenshotActive,
      dragActive: this.drag !== null,
      pointerOverPet: this.pointerOverPet,
      presentationActive: this.reminderStatus.active,
      suppressionActive: time < this.cursorInteractionSuppressedUntil,
    });
  }

  private syncCursorInteractionAvailability(time: number): boolean {
    const allowed = this.cursorInteractionIsAllowed(time);
    if (!allowed) {
      if (!this.cursorInteractionBlocked) {
        this.cursorInteractionBlocked = true;
        this.invalidateCursorInteraction();
      }
      return false;
    }
    if (this.cursorInteractionBlocked) {
      this.cursorInteractionBlocked = false;
      this.cursorInteractionEpoch += 1;
      this.lastCursorSampleAt = 0;
      this.cursorInteraction = cancelCursorInteraction();
      this.cursorInteractionAppliedPhase = "idle";
    }
    return true;
  }

  private updateCursorInteraction(time: number, dtSeconds: number): boolean {
    const settings = this.settings;
    if (!settings) {
      return false;
    }
    const previousPhase = this.cursorInteraction.phase;
    this.cursorInteraction = advanceCursorInteraction(this.cursorInteraction, {
      time,
      petPosition: this.position,
      petWindowDimensions: this.petWindowDimensions,
      activityArea: this.activityArea,
      coordinateScale: this.coordinateScale(),
    });
    this.requestCursorSample(time);
    const phase = this.cursorInteraction.phase;
    if (phase !== this.cursorInteractionAppliedPhase) {
      if (phase === "observing" && this.cursorInteractionAppliedPhase === "chasing") {
        this.requestWindowMove(this.position, true);
      }
      if (phase === "cooldown") {
        this.restUntil = time;
        this.pickTarget();
      }
      this.cursorInteractionAppliedPhase = phase;
    }
    if (phase === "noticing" || phase === "observing") {
      this.target = null;
      this.faceLatestCursor();
      this.mood = "idle";
      return true;
    }
    if (phase === "chasing" && this.cursorInteraction.chaseTarget) {
      this.target = null;
      const next = moveTowards(
        this.position,
        this.cursorInteraction.chaseTarget,
        cursorChaseSpeed(settings.activityLevel) * this.coordinateScale() * dtSeconds,
      );
      this.updateFacing(next.x - this.position.x);
      this.position = clampPointToRect(next, this.activityArea, this.petWindowDimensions);
      this.mood = "run";
      this.syncWindowPosition(time);
      return true;
    }
    if (previousPhase === "cooldown" && phase === "idle") {
      this.lastCursorSampleAt = 0;
    }
    return false;
  }

  private requestCursorSample(time: number): void {
    if (
      this.cursorSampleInFlight ||
      this.cursorInteraction.phase === "observing" ||
      this.cursorInteraction.phase === "cooldown" ||
      time - this.lastCursorSampleAt < cursorInteractionCadence.sampleIntervalMs
    ) {
      return;
    }
    this.lastCursorSampleAt = time;
    this.cursorSampleInFlight = true;
    const epoch = this.cursorInteractionEpoch;
    void invoke<WindowFramePayload>("get_pet_window_frame")
      .then((frame) => {
        const sampleTime = performance.now();
        if (epoch !== this.cursorInteractionEpoch || !this.cursorInteractionIsAllowed(sampleTime)) {
          return;
        }
        this.cursorInteraction = sampleCursorInteraction(
          advanceCursorInteraction(this.cursorInteraction, {
            time: sampleTime,
            petPosition: this.position,
            petWindowDimensions: this.petWindowDimensions,
            activityArea: this.activityArea,
            coordinateScale: this.coordinateScale(),
          }),
          {
            time: sampleTime,
            cursor: frame.cursor,
            petPosition: this.position,
            petWindowDimensions: this.petWindowDimensions,
            activityArea: this.activityArea,
            coordinateScale: this.coordinateScale(),
          },
        );
      })
      .finally(() => {
        this.cursorSampleInFlight = false;
      });
  }

  private faceLatestCursor(): void {
    const cursor = this.cursorInteraction.latestCursor;
    if (cursor) {
      this.updateFacing(cursor.x - (this.position.x + this.petWindowDimensions.width * 0.5));
    }
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
    void invoke<WindowFramePayload>("get_pet_window_frame")
      .then((frame) => {
        this.pointerOverPet = cursorInsideFrame(frame);
      })
      .finally(() => {
        this.hoverFrameCheckInFlight = false;
      });
  }

  private suppressCursorInteraction(durationMs: number): void {
    this.cursorInteractionSuppressedUntil = Math.max(
      this.cursorInteractionSuppressedUntil,
      performance.now() + durationMs,
    );
    this.invalidateCursorInteraction();
  }

  private invalidateCursorInteraction(): void {
    this.cursorInteractionEpoch += 1;
    this.cursorInteraction = cancelCursorInteraction();
    this.cursorInteractionAppliedPhase = "idle";
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    this.suppressCursorInteraction(cursorInteractionCadence.pointerExitProtectionMs);
    this.root.setPointerCapture(event.pointerId);
    const dpr = window.devicePixelRatio || 1;
    const fallbackCursor = { x: event.screenX * dpr, y: event.screenY * dpr };
    const drag: DragState = {
      pointerId: event.pointerId,
      active: false,
      startScreen: fallbackCursor,
      offset: {
        x: fallbackCursor.x - this.position.x,
        y: fallbackCursor.y - this.position.y,
      },
    };
    this.drag = drag;
    this.reminderPresentation.pause("drag");
    void invoke<WindowFramePayload>("get_pet_window_frame")
      .then((frame) => {
        if (this.drag !== drag || drag.active) {
          return;
        }
        drag.startScreen = frame.cursor;
        drag.offset = {
          x: frame.cursor.x - this.position.x,
          y: frame.cursor.y - this.position.y,
        };
      })
      .catch(() => {
        // Screen coordinates already provide a usable drag fallback.
      });
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.drag || this.drag.pointerId !== event.pointerId) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const screen = { x: event.screenX * dpr, y: event.screenY * dpr };
    if (!this.drag.active && distance(screen, this.drag.startScreen) > clickThreshold * dpr) {
      this.drag.active = true;
      this.mood = "dragged";
    }
    if (this.drag.active) {
      const next = {
        x: screen.x - this.drag.offset.x,
        y: screen.y - this.drag.offset.y,
      };
      this.position = this.reminderStatus.active
        ? clampPointToRect(next, this.activityArea, this.petWindowDimensions)
        : next;
      this.requestWindowMove(this.position);
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.drag || this.drag.pointerId !== event.pointerId) {
      return;
    }
    const { active } = this.drag;
    const finalPosition = { ...this.position };
    this.finishDrag();
    if (active) {
      this.requestWindowMove(finalPosition, true);
      this.restUntil = performance.now() + petCadence.dragReleaseRestMs;
      this.pickTarget();
    }
  }

  private finishDrag(): void {
    if (this.drag) {
      try {
        this.root.releasePointerCapture(this.drag.pointerId);
      } catch {
        // The OS may already have released the pointer.
      }
    }
    this.drag = null;
    this.reminderPresentation.resume("drag");
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
    const scale = Math.max(1, Math.floor(Math.min(width, height) / spriteCanvasSize));
    const offsetX = Math.floor((width - spriteCanvasSize * scale) / 2);
    const offsetY = Math.floor((height - spriteCanvasSize * scale) / 2);
    const noticeOffset = Math.round(
      cursorNoticeOffset(this.cursorInteraction, time) * (window.devicePixelRatio || 1),
    );
    ctx.save();
    ctx.translate(offsetX, offsetY + noticeOffset);
    ctx.scale(scale, scale);
    this.skin.draw(ctx, this.mood, time, this.facing);
    ctx.restore();
  }
}

async function ensureNotificationPermission(): Promise<void> {
  try {
    if (!(await isPermissionGranted())) {
      await requestPermission();
    }
  } catch {
    // Hidden-pet reminders may be unavailable when macOS permission is denied.
  }
}
