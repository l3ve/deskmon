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
  createExternalNotificationDialog,
  type ExternalNotificationDialogController,
} from "./pet/externalNotificationDialog";
import {
  createExternalNotificationLayout,
  type ExternalNotificationLayout,
} from "./pet/externalNotificationPresentation";
import {
  advanceExternalNotification,
  clearExternalNotifications,
  completeExternalNotificationReveal,
  createExternalNotificationState,
  enqueueExternalNotification,
  externalNotificationLayerCount,
  externalNotificationRevealComplete,
  externalNotificationsExpired,
  pauseExternalNotifications,
  resumeExternalNotifications,
  startExternalNotifications,
  type ExternalNotificationPayload,
  type ExternalNotificationState,
} from "./pet/externalNotificationState";
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
  fromDialog: boolean;
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
  private externalDialog: ExternalNotificationDialogController;
  private externalLayout: ExternalNotificationLayout | null = null;
  private externalNotifications: ExternalNotificationState = createExternalNotificationState();
  private facing: PetFacing = "right";
  private hoverFrameCheckInFlight = false;
  private isMovingFast = false;
  private lastFrameTime = performance.now();
  private lastHoverFrameCheck = 0;
  private lastWindowSync = 0;
  private mood: PetMood = "idle";
  private monitors: MonitorPayload[] = [];
  private moveInFlight = false;
  private notificationPresentationInFlight = false;
  private pendingMoveTarget: Point | null = null;
  private pendingPresentationSync = false;
  private persistAfterMove = false;
  private petDimensions: Dimensions = { width: 104, height: 104 };
  private petWindowDimensions: Dimensions = { width: 104, height: 104 };
  private pointerOverPet = false;
  private position: Point = { x: 0, y: 0 };
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
    this.externalDialog = createExternalNotificationDialog();
    this.root.append(this.externalDialog.element);
    this.canvas.addEventListener("pointerenter", () => {
      this.pointerOverPet = true;
      this.invalidateCursorInteraction();
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.pointerOverPet = false;
      this.suppressCursorInteraction(cursorInteractionCadence.pointerExitProtectionMs);
    });
    this.externalDialog.element.addEventListener("pointerenter", () => {
      this.externalNotifications = pauseExternalNotifications(
        this.externalNotifications,
        performance.now(),
      );
    });
    this.externalDialog.element.addEventListener("pointerleave", () => {
      if (!this.drag) {
        this.externalNotifications = resumeExternalNotifications(
          this.externalNotifications,
          performance.now(),
        );
      }
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
    void listen<ExternalNotificationPayload>("deskmon-pet-notification", (event) => {
      const result = enqueueExternalNotification(
        this.externalNotifications,
        event.payload,
        performance.now(),
      );
      this.externalNotifications = result.state;
      if (result.accepted && !this.drag && !this.screenshotActive) {
        this.beginNotifications();
      }
    });
    void listen<CountdownSnapshot>("deskmon-countdown-changed", (event) => {
      this.countdown = event.payload;
      this.invalidateCursorInteraction();
    });
    void listen<boolean>("deskmon-screenshot-state-changed", (event) => {
      this.screenshotActive = event.payload;
      if (event.payload) {
        this.externalNotifications = pauseExternalNotifications(
          this.externalNotifications,
          performance.now(),
        );
      } else {
        this.externalNotifications = resumeExternalNotifications(
          this.externalNotifications,
          performance.now(),
        );
        this.beginNotifications();
      }
    });
    void listen<boolean>("deskmon-visibility-changed", (event) => {
      if (this.settings) {
        this.settings.petVisible = event.payload;
      }
      if (!event.payload) {
        this.externalNotifications = clearExternalNotifications(this.externalNotifications);
        this.finishNotifications(true);
      }
    });
    void listen("deskmon-settings-changed", async () => {
      this.applyBootstrap(await invoke<BootstrapPayload>("get_desktop_snapshot"));
      this.resizeCanvas();
      this.pickTarget();
      if (this.externalNotifications.presenting) {
        this.syncNotificationPresentation();
      }
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
  }

  private resizeCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${this.petDimensions.width}px`;
    this.canvas.style.height = `${this.petDimensions.height}px`;
    this.canvas.style.left = `${this.externalLayout?.petOffset.x ?? 0}px`;
    this.canvas.style.top = `${this.externalLayout?.petOffset.y ?? 0}px`;
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
    this.updateNotificationLifetime(time);
    this.updateMovement(time, dtSeconds);
    this.renderNotification(time);
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
    if (this.externalNotifications.presenting) {
      this.mood =
        this.externalNotifications.items[0]?.tone === "error" ? "idle" : "celebrate";
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
      if (!this.externalNotifications.presenting) {
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
    if (!this.externalNotifications.presenting) {
      this.mood = this.countdown.isRunning
        ? "timer-waiting"
        : this.isMovingFast
          ? "run"
          : "walk";
    }
    this.syncWindowPosition(time);
  }

  private beginNotifications(): void {
    if (
      this.drag ||
      this.screenshotActive ||
      this.externalNotifications.items.length === 0
    ) {
      return;
    }
    this.externalNotifications = startExternalNotifications(
      this.externalNotifications,
      performance.now(),
    );
    this.invalidateCursorInteraction();
    this.syncNotificationPresentation();
  }

  private updateNotificationLifetime(time: number): void {
    if (!externalNotificationsExpired(this.externalNotifications, time)) {
      return;
    }
    this.externalNotifications = advanceExternalNotification(this.externalNotifications, time);
    if (this.externalNotifications.presenting) {
      this.syncNotificationPresentation();
    } else {
      this.finishNotifications(false);
    }
  }

  private renderNotification(time: number): void {
    if (!this.externalNotifications.presenting) {
      return;
    }
    this.externalDialog.render(
      this.externalNotifications.items[0] ?? null,
      externalNotificationLayerCount(this.externalNotifications),
      this.externalNotifications.pausedAt ?? time,
    );
  }

  private handleNotificationClick(): void {
    const current = this.externalNotifications.items[0];
    if (!current) {
      return;
    }
    const now = performance.now();
    const revealTime = this.externalNotifications.pausedAt ?? now;
    if (!externalNotificationRevealComplete(current, revealTime)) {
      this.externalNotifications = completeExternalNotificationReveal(
        this.externalNotifications,
      );
      return;
    }
    this.externalNotifications = advanceExternalNotification(this.externalNotifications, now);
    if (this.externalNotifications.presenting) {
      if (this.externalDialog.element.matches(":hover")) {
        this.externalNotifications = pauseExternalNotifications(
          this.externalNotifications,
          now,
        );
      }
      this.syncNotificationPresentation();
    } else {
      this.finishNotifications(false);
    }
  }

  private syncNotificationPresentation(): void {
    if (!this.externalNotifications.presenting) {
      return;
    }
    const layout = createExternalNotificationLayout({
      petPosition: this.position,
      petDimensions: this.petDimensions,
      petWindowDimensions: this.petWindowDimensions,
      monitors: this.monitors,
      fallbackArea: this.activityArea,
      lockedPlacement: this.drag?.active
        ? this.externalLayout?.notificationPlacement
        : undefined,
    });
    this.externalLayout = layout;
    this.resizeCanvas();
    const style = this.externalDialog.element.style;
    style.left = `${layout.notificationOffset.x}px`;
    style.top = `${layout.notificationOffset.y}px`;
    style.width = `${layout.notificationDimensions.width}px`;
    style.height = `${layout.notificationDimensions.height}px`;
    this.externalDialog.setPlacement(layout.notificationPlacement);
    this.renderNotification(performance.now());
    this.pendingPresentationSync = true;
    this.flushNotificationPresentation();
  }

  private flushNotificationPresentation(): void {
    if (this.notificationPresentationInFlight || !this.pendingPresentationSync) {
      return;
    }
    const layout = this.externalLayout;
    if (!layout) {
      this.pendingPresentationSync = false;
      return;
    }
    this.pendingPresentationSync = false;
    this.notificationPresentationInFlight = true;
    invoke("set_pet_temporary_presentation", {
      x: layout.windowPosition.x,
      y: layout.windowPosition.y,
      width: layout.windowLogicalDimensions.width,
      height: layout.windowLogicalDimensions.height,
      alwaysOnTop: true,
      visible: true,
      ignoreCursorEvents: false,
    })
      .catch(() => {
        // Keep the queue alive if a transient native resize fails.
      })
      .finally(() => {
        this.notificationPresentationInFlight = false;
        if (this.pendingPresentationSync) {
          this.flushNotificationPresentation();
        }
      });
  }

  private finishNotifications(forceHidden: boolean): void {
    this.externalDialog.clear();
    this.externalLayout = null;
    this.resizeCanvas();
    void invoke("set_pet_temporary_presentation", {
      x: this.position.x,
      y: this.position.y,
      width: this.petDimensions.width,
      height: this.petDimensions.height,
      alwaysOnTop: this.settings?.alwaysOnTop ?? true,
      visible: !forceHidden && (this.settings?.petVisible ?? true),
      ignoreCursorEvents: false,
    });
    if (!forceHidden) {
      this.requestWindowMove(this.position, true);
    }
    this.invalidateCursorInteraction();
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
    if (this.externalNotifications.presenting) {
      this.position = { ...point };
      this.persistAfterMove ||= persistAfterMove;
      this.syncNotificationPresentation();
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
      presentationActive: this.externalNotifications.presenting,
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
      fromDialog: this.externalDialog.element.contains(event.target as Node),
    };
    this.drag = drag;
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
    if (this.externalNotifications.presenting) {
      this.externalNotifications = pauseExternalNotifications(
        this.externalNotifications,
        performance.now(),
      );
    }
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
      this.position = this.externalNotifications.presenting
        ? clampPointToRect(next, this.activityArea, this.petWindowDimensions)
        : next;
      this.requestWindowMove(this.position);
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.drag || this.drag.pointerId !== event.pointerId) {
      return;
    }
    const { active, fromDialog } = this.drag;
    const finalPosition = { ...this.position };
    this.finishDrag();
    if (active) {
      this.requestWindowMove(finalPosition, true);
      this.restUntil = performance.now() + petCadence.dragReleaseRestMs;
      this.pickTarget();
    } else if (fromDialog) {
      this.handleNotificationClick();
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
    if (!this.externalDialog.element.matches(":hover")) {
      this.externalNotifications = resumeExternalNotifications(
        this.externalNotifications,
        performance.now(),
      );
    }
    this.beginNotifications();
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
