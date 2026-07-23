import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import {
  clampPointToRect,
  cursorInsideFrame,
  distance,
  monitorForPoint,
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
  giantCelebrationEnterMs,
  giantCelebrationHoldMs,
  giantCelebrationRestoreMs,
  giantPresentationSyncIntervalMs,
  type GiantCelebrationState,
  type GiantPresentationFrame,
  type TemporaryPetPresentation,
} from "./pet/giantCelebration";
import { createFocusDialog, type FocusDialogController } from "./pet/focusDialog";
import {
  createExternalNotificationDialog,
  type ExternalNotificationDialogController,
} from "./pet/externalNotificationDialog";
import {
  createExternalNotificationLayout,
  createExternalNotificationPresentation,
  externalNotificationEnterFrame,
  externalNotificationEnterMs,
  externalNotificationRestoreFrame,
  externalNotificationRestoreMs,
  externalNotificationRestoreTarget,
  externalNotificationSyncIntervalMs,
  type ExternalNotificationLayout,
  type ExternalNotificationPresentationFrame,
  type ExternalNotificationPresentationState,
} from "./pet/externalNotificationPresentation";
import {
  clearExternalNotifications,
  createExternalNotificationState,
  enqueueExternalNotification,
  externalNotificationsExpired,
  pauseExternalNotifications,
  startExternalNotifications,
  type ExternalNotificationPayload,
  type ExternalNotificationState,
} from "./pet/externalNotificationState";
import {
  createFocusPresentationLayout,
  presentationMonitorIsAvailable,
  type FocusPresentationLayout,
} from "./pet/focusPresentation";
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
import { spriteSlimeSkin, type PetFacing, type PetMood, type PetSkin } from "./pet/slime";
import type {
  BootstrapPayload,
  Dimensions,
  FocusPresentationContext,
  FocusSessionAction,
  FocusSessionSnapshot,
  MonitorPayload,
  Point,
  Rect,
  Settings,
  TimerKind,
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

  const app = new PetController(root, canvas);
  app.start();
}

type FlowPresentationMode = "entering" | "holding" | "restoring";
type ExternalPresentationMode = "entering" | "holding" | "restoring";

class PetController {
  private activityArea: Rect = { x: 0, y: 0, width: 800, height: 500 };
  private drag: DragState | null = null;
  private isMovingFast = false;
  private lastFrameTime = performance.now();
  private lastHoverFrameCheck = 0;
  private lastExternalPresentationMonitorCheck = 0;
  private lastWindowSync = 0;
  private lastPresentationMonitorCheck = 0;
  private facing: PetFacing = "right";
  private giantCelebration: GiantCelebrationState | null = null;
  private externalDialog: ExternalNotificationDialogController;
  private externalNotifications: ExternalNotificationState = createExternalNotificationState();
  private externalPresentation: ExternalNotificationPresentationState | null = null;
  private externalPresentationMode: ExternalPresentationMode | null = null;
  private externalPresentationLayout: ExternalNotificationLayout | null = null;
  private externalRestoreStartedAt = 0;
  private externalPresentationContextInFlight = false;
  private screenshotActive = false;
  private flowPresentationMode: FlowPresentationMode | null = null;
  private flowPresentationLayout: FocusPresentationLayout | null = null;
  private flowRestoreStartedAt = 0;
  private focusDialog: FocusDialogController;
  private focusPresentationContextInFlight = false;
  private pendingFocusPresentation = false;
  private presentationRequestId = 0;
  private completionCelebrateUntil = 0;
  private cursorInteraction: CursorInteractionState = createCursorInteractionState();
  private cursorInteractionAppliedPhase: CursorInteractionPhase = "idle";
  private cursorInteractionBlocked = false;
  private cursorInteractionEpoch = 0;
  private cursorInteractionSuppressedUntil = 0;
  private cursorSampleInFlight = false;
  private lastCursorSampleAt = 0;
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
  private focusSession: FocusSessionSnapshot = {
    phase: "idle",
    isRunning: false,
    kind: null,
    durationSeconds: 0,
    remainingSeconds: 0,
    endsAtMs: null,
    baseFocusMinutes: null,
    breakMinutes: null,
  };

  constructor(
    private readonly root: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.focusDialog = createFocusDialog((action) => this.performFocusSessionAction(action));
    this.externalDialog = createExternalNotificationDialog();
    this.root.append(this.focusDialog.element);
    this.root.append(this.externalDialog.element);
    this.canvas.addEventListener("pointerenter", () => {
      this.pointerOverPet = true;
      this.invalidateCursorInteraction();
    });
    this.canvas.addEventListener("pointerleave", () => {
      this.pointerOverPet = false;
      this.suppressCursorInteraction(cursorInteractionCadence.pointerExitProtectionMs);
    });
    this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    this.canvas.addEventListener("pointercancel", () => this.finishDrag());
    this.canvas.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.suppressCursorInteraction(cursorInteractionCadence.menuProtectionMs);
      if (this.flowPresentationMode === "restoring" || this.externalPresentationMode) {
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
    void listen<ExternalNotificationPayload>("deskmon-external-notification", (event) => {
      const result = enqueueExternalNotification(
        this.externalNotifications,
        event.payload,
        performance.now(),
      );
      this.externalNotifications = result.state;
      if (result.accepted) {
        if (this.externalPresentationMode === "holding" && this.externalPresentation) {
          this.applyExternalLayout(this.externalPresentation, null, true);
        } else if (this.flowPresentationMode === "holding") {
          this.holdFlowPresentation();
        } else {
          this.tryBeginExternalPresentation();
        }
      }
    });
    void listen<boolean>("deskmon-screenshot-state-changed", (event) => {
      this.screenshotActive = event.payload;
      if (event.payload) {
        this.pauseExternalForInterruption();
      } else {
        this.tryBeginExternalPresentation();
      }
    });
    void listen<FocusSessionSnapshot>("deskmon-focus-session-changed", (event) => {
      const previous = this.focusSession;
      this.focusSession = event.payload;
      this.syncFocusSession(previous);
    });
    void listen<TimerKind>("deskmon-focus-segment-finished", (event) => {
      if (event.payload === "break" && this.flowPresentationMode === "holding") {
        this.completionCelebrateUntil = performance.now() + 1800;
        this.mood = "celebrate";
      }
    });
    void listen<boolean>("deskmon-visibility-changed", (event) => {
      if (this.settings) {
        this.settings.petVisible = event.payload;
      }
      if (!event.payload && this.flowPresentationMode) {
        this.finishFlowPresentation(true);
      }
      if (!event.payload) {
        this.externalNotifications = clearExternalNotifications(this.externalNotifications);
        this.externalDialog.clear();
        this.finishExternalPresentation(true, false);
      } else {
        this.tryBeginExternalPresentation();
      }
    });
    void listen("deskmon-settings-changed", async () => {
      const bootstrap = await invoke<BootstrapPayload>("get_desktop_snapshot");
      this.applyBootstrap(bootstrap);
      if (!this.flowPresentationMode && !this.externalPresentationMode) {
        this.resizeCanvas();
        this.pickTarget();
      }
    });
  }

  private applyBootstrap(bootstrap: BootstrapPayload): void {
    this.settings = bootstrap.settings;
    this.monitors = bootstrap.monitors;
    this.activityArea = bootstrap.activityArea;
    this.focusSession = bootstrap.focusSession;
    if (this.flowPresentationMode && this.giantCelebration) {
      this.giantCelebration.restorePetDimensions = bootstrap.petDimensions;
      this.giantCelebration.restoreWindowDimensions = bootstrap.petWindowDimensions;
      return;
    }
    if (this.externalPresentationMode && this.externalPresentation) {
      this.externalPresentation.restorePetDimensions = bootstrap.petDimensions;
      this.externalPresentation.restoreWindowDimensions = bootstrap.petWindowDimensions;
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
    const petOffset =
      this.externalPresentationLayout?.petOffset ??
      this.flowPresentationLayout?.petOffset ?? { x: 0, y: 0 };
    this.canvas.style.left = `${petOffset.x}px`;
    this.canvas.style.top = `${petOffset.y}px`;
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

    this.updateExternalNotificationLifetime(time);
    const cursorInteractionAllowed = this.syncCursorInteractionAvailability(time);

    if (this.flowPresentationMode) {
      this.updateFlowPresentation(time);
      return;
    }

    if (this.externalPresentationMode) {
      this.updateExternalPresentation(time);
      return;
    }

    if (this.drag?.active) {
      this.mood = "dragged";
      return;
    }

    if (this.focusSession.isRunning) {
      this.mood = "timer-waiting";
    }

    if (this.pointerOverPet) {
      this.reconcilePointerHover(time);
    }

    if (this.pointerOverPet) {
      this.mood = this.focusSession.isRunning ? "timer-waiting" : "idle";
      return;
    }

    if (settings.movementPaused) {
      if (!this.focusSession.isRunning && time > this.restUntil + petCadence.pausedSleepDelayMs) {
        this.mood = "sleep";
      }
      return;
    }

    if (cursorInteractionAllowed && this.updateCursorInteraction(time, dtSeconds)) {
      return;
    }

    if (time < this.restUntil) {
      this.mood = this.focusSession.isRunning ? "timer-waiting" : this.restMood;
      return;
    }

    const coordinateScale = this.coordinateScale();
    const profile = activityProfiles[settings.activityLevel];

    if (!this.target || near(this.position, this.target, profile.arrivalThreshold * coordinateScale)) {
      this.requestWindowMove(this.position, true);
      this.restUntil = time + randomBetween(profile.restMs[0], profile.restMs[1]);
      this.restMood = chooseRestMood(profile);
      this.mood = this.focusSession.isRunning ? "timer-waiting" : this.restMood;
      this.pickTarget();
      return;
    }

    const speed =
      profile.speed * coordinateScale * (this.isMovingFast ? profile.runSpeedMultiplier : 1);
    const next = moveTowards(this.position, this.target, speed * dtSeconds);
    this.updateFacing(next.x - this.position.x);
    this.position = clampPointToRect(next, this.activityArea, this.petWindowDimensions);
    this.mood = this.focusSession.isRunning
      ? "timer-waiting"
      : this.isMovingFast
        ? "run"
        : "walk";
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

  private cursorInteractionIsAllowed(time: number): boolean {
    return cursorInteractionAllowed({
      petVisible: this.settings?.petVisible === true,
      movementPaused: this.settings?.movementPaused !== false,
      focusActive: this.focusSession.phase !== "idle",
      screenshotActive: this.screenshotActive,
      dragActive: this.drag !== null,
      pointerOverPet: this.pointerOverPet,
      presentationActive:
        this.flowPresentationMode !== null ||
        this.externalPresentationMode !== null,
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
      if (
        phase === "observing" &&
        this.cursorInteractionAppliedPhase === "chasing"
      ) {
        this.requestWindowMove(this.position, true);
      }
      if (phase === "cooldown") {
        this.restUntil = time;
        this.pickTarget();
      }
      this.cursorInteractionAppliedPhase = phase;
    }

    if (phase === "noticing") {
      this.target = null;
      this.faceLatestCursor();
      this.mood = "idle";
      return true;
    }

    if (phase === "chasing" && this.cursorInteraction.chaseTarget) {
      this.target = null;
      const speed =
        cursorChaseSpeed(settings.activityLevel) * this.coordinateScale();
      const next = moveTowards(
        this.position,
        this.cursorInteraction.chaseTarget,
        speed * dtSeconds,
      );
      this.updateFacing(next.x - this.position.x);
      this.position = clampPointToRect(
        next,
        this.activityArea,
        this.petWindowDimensions,
      );
      this.mood = "run";
      this.syncWindowPosition(time);
      return true;
    }

    if (phase === "observing") {
      this.target = null;
      this.faceLatestCursor();
      this.mood = "idle";
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
        if (
          epoch !== this.cursorInteractionEpoch ||
          !this.cursorInteractionIsAllowed(sampleTime)
        ) {
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
      .catch(() => {
        // Cursor interaction is optional; ordinary movement continues if a probe fails.
      })
      .finally(() => {
        this.cursorSampleInFlight = false;
      });
  }

  private faceLatestCursor(): void {
    const cursor = this.cursorInteraction.latestCursor;
    if (!cursor) {
      return;
    }
    const petCenterX = this.position.x + this.petWindowDimensions.width * 0.5;
    this.updateFacing(cursor.x - petCenterX);
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

  private canPresentExternalNotification(): boolean {
    return (
      this.settings?.petVisible !== false &&
      !this.screenshotActive &&
      !this.drag
    );
  }

  private tryBeginExternalPresentation(): void {
    if (
      this.externalNotifications.items.length === 0 ||
      this.externalNotifications.presenting ||
      !this.canPresentExternalNotification()
    ) {
      return;
    }

    if (this.flowPresentationMode === "holding") {
      this.externalNotifications = startExternalNotifications(
        this.externalNotifications,
        performance.now(),
      );
      this.holdFlowPresentation();
      return;
    }
    if (
      this.flowPresentationMode ||
      this.externalPresentationMode ||
      this.externalPresentationContextInFlight
    ) {
      return;
    }

    this.externalPresentationContextInFlight = true;
    invoke<FocusPresentationContext>("get_focus_presentation_context")
      .then((context) => {
        if (
          this.externalNotifications.items.length === 0 ||
          !this.canPresentExternalNotification() ||
          this.flowPresentationMode ||
          this.externalPresentationMode
        ) {
          return;
        }
        this.monitors = context.monitors;
        const time = performance.now();
        const presentation = createExternalNotificationPresentation({
          startedAt: time,
          petDimensions: this.petDimensions,
          petWindowDimensions: this.petWindowDimensions,
          position: this.position,
          monitors: this.monitors,
          activityArea: this.activityArea,
          coordinateScale: this.coordinateScale(),
          targetPoint: context.cursor,
        });
        if (!presentation) {
          return;
        }
        this.externalPresentation = presentation;
        this.externalPresentationMode = "entering";
        this.externalPresentationLayout = null;
        this.pointerOverPet = false;
        this.target = null;
        this.root.classList.add("external-presenting", "external-entering");
        this.mood = "celebrate";
        this.updateExternalPresentation(time, true);
      })
      .catch(() => {
        // Keep the reminder queued if native monitor context is temporarily unavailable.
      })
      .finally(() => {
        this.externalPresentationContextInFlight = false;
      });
  }

  private updateExternalNotificationLifetime(time: number): void {
    if (!this.externalNotifications.presenting) {
      return;
    }
    if (externalNotificationsExpired(this.externalNotifications, time)) {
      this.externalNotifications = clearExternalNotifications(this.externalNotifications);
      this.externalDialog.clear();
      if (this.externalPresentationMode) {
        this.beginExternalRestore();
      } else if (this.flowPresentationMode === "holding") {
        if (this.focusUsesCentralPresentation()) {
          this.holdFlowPresentation();
        } else {
          this.beginFlowRestore();
        }
      }
      return;
    }
    this.externalDialog.render(this.externalNotifications.items, time);
  }

  private updateExternalPresentation(time: number, forceSync = false): void {
    const presentation = this.externalPresentation;
    const mode = this.externalPresentationMode;
    if (!presentation || !mode) {
      return;
    }
    if (mode === "entering") {
      const elapsed = time - presentation.startedAt;
      if (elapsed >= externalNotificationEnterMs) {
        this.holdExternalPresentation(time);
        return;
      }
      this.applyExternalSquareFrame(
        externalNotificationEnterFrame(presentation, elapsed),
        time,
        forceSync,
      );
      this.mood = "celebrate";
      return;
    }
    if (mode === "restoring") {
      const elapsed = time - this.externalRestoreStartedAt;
      if (elapsed >= externalNotificationRestoreMs) {
        this.finishExternalPresentation(false, true);
        return;
      }
      this.applyExternalSquareFrame(
        externalNotificationRestoreFrame(
          presentation,
          this.getExternalRestoreTarget(presentation),
          elapsed,
        ),
        time,
        forceSync,
      );
      return;
    }

    this.reconcileExternalPresentationMonitor(time);
    this.mood = "celebrate";
    this.externalDialog.render(this.externalNotifications.items, time);
  }

  private reconcileExternalPresentationMonitor(time: number): void {
    if (
      this.externalPresentationContextInFlight ||
      time - this.lastExternalPresentationMonitorCheck < 2000
    ) {
      return;
    }
    this.lastExternalPresentationMonitorCheck = time;
    this.externalPresentationContextInFlight = true;
    invoke<FocusPresentationContext>("get_focus_presentation_context")
      .then((context) => {
        const presentation = this.externalPresentation;
        if (!presentation || this.externalPresentationMode !== "holding") {
          return;
        }
        this.monitors = context.monitors;
        if (monitorForPoint(presentation.targetCenter, context.monitors)) {
          this.applyExternalLayout(presentation, null, true);
          return;
        }
        const retargeted = createExternalNotificationPresentation({
          startedAt: performance.now() - externalNotificationEnterMs,
          petDimensions: presentation.normalPetDimensions,
          petWindowDimensions: presentation.normalWindowDimensions,
          position: topLeftFromCenter(
            presentation.normalCenter,
            presentation.normalWindowDimensions,
          ),
          monitors: context.monitors,
          activityArea: this.activityArea,
          coordinateScale:
            presentation.normalWindowDimensions.width /
            Math.max(1, presentation.normalPetDimensions.width),
          targetPoint: context.cursor,
        });
        if (!retargeted) {
          return;
        }
        retargeted.restorePetDimensions = presentation.restorePetDimensions;
        retargeted.restoreWindowDimensions = presentation.restoreWindowDimensions;
        this.externalPresentation = retargeted;
        this.applyExternalLayout(retargeted, null, true);
      })
      .catch(() => {
        // Keep the current presentation when monitor refresh is temporarily unavailable.
      })
      .finally(() => {
        this.externalPresentationContextInFlight = false;
      });
  }

  private getExternalRestoreTarget(
    presentation: ExternalNotificationPresentationState,
  ): ExternalNotificationPresentationFrame {
    return externalNotificationRestoreTarget(
      presentation,
      this.monitors,
      this.activityArea,
      this.settings?.alwaysOnTop ?? true,
    );
  }

  private applyExternalSquareFrame(
    frame: ExternalNotificationPresentationFrame,
    time: number,
    forceSync = false,
  ): void {
    const presentation = this.externalPresentation;
    const position = topLeftFromCenter(frame.center, frame.windowDimensions);
    this.externalPresentationLayout = null;
    this.externalDialog.hide();
    this.petDimensions = frame.petDimensions;
    this.petWindowDimensions = frame.windowDimensions;
    this.position = position;
    this.resizeCanvas();
    if (
      !presentation ||
      (!forceSync &&
        time - presentation.lastPresentationSync < externalNotificationSyncIntervalMs)
    ) {
      return;
    }
    presentation.lastPresentationSync = time;
    this.requestTemporaryPetPresentation({
      position,
      dimensions: frame.petDimensions,
      alwaysOnTop: frame.alwaysOnTop,
      visible: true,
      ignoreCursorEvents: true,
    });
  }

  private holdExternalPresentation(time: number): void {
    const presentation = this.externalPresentation;
    if (!presentation) {
      return;
    }
    this.externalPresentationMode = "holding";
    this.root.classList.remove("external-entering");
    this.root.classList.add("external-holding");
    this.externalNotifications = startExternalNotifications(this.externalNotifications, time);
    this.applyExternalLayout(presentation, null, true);
  }

  private applyExternalLayout(
    presentation: Pick<
      ExternalNotificationPresentationState,
      "targetCenter" | "targetPetDimensions" | "targetWindowDimensions"
    >,
    focusLayout: FocusPresentationLayout | null,
    ignoreCursorEvents: boolean,
  ): void {
    const layout = createExternalNotificationLayout(
      presentation,
      this.monitors,
      this.activityArea,
      this.externalNotifications.items.length,
      focusLayout,
    );
    this.externalPresentationLayout = layout;
    this.petDimensions = { ...layout.petDimensions };
    this.petWindowDimensions = { ...presentation.targetWindowDimensions };
    this.position = topLeftFromCenter(
      presentation.targetCenter,
      presentation.targetWindowDimensions,
    );
    this.resizeCanvas();

    if (layout.focusDialogOffset) {
      this.focusDialog.element.style.left = `${layout.focusDialogOffset.x}px`;
      this.focusDialog.element.style.top = `${layout.focusDialogOffset.y}px`;
    }
    const dialogStyle = this.externalDialog.element.style;
    dialogStyle.left = `${layout.notificationOffset.x}px`;
    dialogStyle.top = `${layout.notificationOffset.y}px`;
    dialogStyle.width = `${layout.notificationDimensions.width}px`;
    dialogStyle.height = `${layout.notificationDimensions.height}px`;
    this.externalDialog.setPlacement(layout.notificationPlacement);
    this.externalDialog.render(this.externalNotifications.items, performance.now());
    this.requestTemporaryPetPresentation({
      position: layout.windowPosition,
      dimensions: layout.windowLogicalDimensions,
      alwaysOnTop: true,
      visible: true,
      ignoreCursorEvents,
    });
  }

  private beginExternalRestore(): void {
    const presentation = this.externalPresentation;
    if (!presentation) {
      this.finishExternalPresentation(false, true);
      return;
    }
    this.externalDialog.hide();
    this.root.classList.remove("external-holding");
    this.externalPresentationLayout = null;
    if (this.settings?.petVisible === false || this.externalPresentationMode === "entering") {
      this.finishExternalPresentation(this.settings?.petVisible === false, true);
      return;
    }
    this.externalPresentationMode = "restoring";
    this.externalRestoreStartedAt = performance.now();
    this.petDimensions = { ...presentation.targetPetDimensions };
    this.petWindowDimensions = { ...presentation.targetWindowDimensions };
    this.position = topLeftFromCenter(
      presentation.targetCenter,
      presentation.targetWindowDimensions,
    );
    this.resizeCanvas();
    this.requestTemporaryPetPresentation({
      position: this.position,
      dimensions: presentation.targetPetDimensions,
      alwaysOnTop: true,
      visible: true,
      ignoreCursorEvents: true,
    });
  }

  private finishExternalPresentation(forceHidden = false, resumePending = true): void {
    const presentation = this.externalPresentation;
    this.externalDialog.hide();
    this.root.classList.remove(
      "external-presenting",
      "external-entering",
      "external-holding",
    );
    this.externalPresentationMode = null;
    this.externalPresentationLayout = null;
    this.externalPresentation = null;
    if (!presentation) {
      return;
    }
    const restoreTarget = this.getExternalRestoreTarget(presentation);
    const position = topLeftFromCenter(restoreTarget.center, restoreTarget.windowDimensions);
    this.petDimensions = restoreTarget.petDimensions;
    this.petWindowDimensions = restoreTarget.windowDimensions;
    this.position = position;
    this.mood = this.focusSession.isRunning ? "timer-waiting" : "idle";
    this.resizeCanvas();
    this.requestTemporaryPetPresentation({
      position,
      dimensions: restoreTarget.petDimensions,
      alwaysOnTop: restoreTarget.alwaysOnTop,
      visible: !forceHidden && (this.settings?.petVisible ?? true),
      ignoreCursorEvents: false,
    });
    this.pickTarget();
    if (this.pendingFocusPresentation) {
      this.pendingFocusPresentation = false;
      this.beginFocusPresentation();
    } else if (resumePending) {
      this.tryBeginExternalPresentation();
    }
  }

  private pauseExternalForInterruption(): void {
    if (this.externalNotifications.presenting) {
      this.externalNotifications = pauseExternalNotifications(this.externalNotifications);
    }
    this.externalDialog.hide();
    if (this.externalPresentationMode) {
      this.finishExternalPresentation(false, false);
    } else if (this.flowPresentationMode === "holding") {
      this.holdFlowPresentation();
    }
  }

  private focusUsesCentralPresentation(): boolean {
    return ["focusComplete", "breakRunning", "breakComplete"].includes(
      this.focusSession.phase,
    );
  }

  private syncFocusSession(previous: FocusSessionSnapshot): void {
    const previousUsedCentralPresentation = [
      "focusComplete",
      "breakRunning",
      "breakComplete",
    ].includes(previous.phase);
    if (
      this.focusSession.phase === "focusComplete" ||
      this.focusSession.phase === "breakRunning" ||
      this.focusSession.phase === "breakComplete"
    ) {
      if (!this.flowPresentationMode) {
        if (this.externalPresentationMode) {
          this.pendingFocusPresentation = true;
          this.externalNotifications = pauseExternalNotifications(this.externalNotifications);
          this.beginExternalRestore();
          return;
        }
        this.beginFocusPresentation();
      } else if (this.flowPresentationMode === "holding") {
        this.holdFlowPresentation();
      }
      return;
    }

    this.focusDialog.hide();
    this.pendingFocusPresentation = false;
    if (this.flowPresentationMode) {
      if (
        previousUsedCentralPresentation &&
        this.flowPresentationMode !== "restoring"
      ) {
        if (this.externalNotifications.presenting) {
          this.holdFlowPresentation();
        } else {
          this.beginFlowRestore();
        }
      }
      return;
    }
    this.presentationRequestId += 1;
    this.mood = this.focusSession.isRunning ? "timer-waiting" : "idle";
  }

  private beginFocusPresentation(): void {
    if (this.drag?.active) {
      this.pendingFocusPresentation = true;
      return;
    }
    if (
      this.flowPresentationMode ||
      this.externalPresentationMode ||
      this.focusPresentationContextInFlight
    ) {
      return;
    }

    this.focusPresentationContextInFlight = true;
    const requestId = ++this.presentationRequestId;
    invoke<FocusPresentationContext>("get_focus_presentation_context")
      .then((context) => {
        if (
          requestId !== this.presentationRequestId ||
          ![
            "focusComplete",
            "breakRunning",
            "breakComplete",
          ].includes(this.focusSession.phase)
        ) {
          return;
        }
        this.monitors = context.monitors;
        const time = performance.now();
        const celebration = createGiantCelebration({
          startedAt: time,
          petDimensions: this.petDimensions,
          petWindowDimensions: this.petWindowDimensions,
          position: this.position,
          monitors: this.monitors,
          activityArea: this.activityArea,
          coordinateScale: this.coordinateScale(),
          targetPoint: context.cursor,
          centerInWorkArea: true,
        });
        if (!celebration) {
          return;
        }

        this.giantCelebration = celebration;
        this.flowPresentationMode = "entering";
        this.flowPresentationLayout = null;
        this.pendingFocusPresentation = false;
        this.pointerOverPet = false;
        this.target = null;
        this.focusDialog.hide();
        this.root.classList.add("flow-presenting", "flow-entering");
        this.mood = "celebrate";
        this.updateFlowPresentation(time, true);
      })
      .catch(() => {
        // The session remains pending and the synchronized menu is still usable.
      })
      .finally(() => {
        this.focusPresentationContextInFlight = false;
      });
  }

  private updateFlowPresentation(time: number, forceSync = false): void {
    const celebration = this.giantCelebration;
    const mode = this.flowPresentationMode;
    if (!celebration || !mode) {
      return;
    }

    if (mode === "entering") {
      const elapsed = time - celebration.startedAt;
      if (elapsed >= giantCelebrationEnterMs) {
        this.holdFlowPresentation();
        return;
      }
      const frame = getGiantPresentationFrame(
        celebration,
        elapsed,
        this.getGiantRestoreTarget(celebration),
      );
      this.applySquarePresentationFrame(frame, time, forceSync);
      this.mood = "celebrate";
      return;
    }

    if (mode === "restoring") {
      const elapsed = time - this.flowRestoreStartedAt;
      if (elapsed >= giantCelebrationRestoreMs) {
        this.finishFlowPresentation();
        return;
      }
      const frame = getGiantPresentationFrame(
        celebration,
        giantCelebrationEnterMs + giantCelebrationHoldMs + elapsed,
        this.getGiantRestoreTarget(celebration),
      );
      this.applySquarePresentationFrame(frame, time, forceSync);
      return;
    }

    this.reconcilePresentationMonitor(time);
    if (this.externalNotifications.presenting) {
      this.externalDialog.render(this.externalNotifications.items, time);
      this.mood = "celebrate";
    } else if (this.focusSession.phase === "breakRunning") {
      this.mood = "timer-waiting";
    } else {
      this.mood = time < this.completionCelebrateUntil ? "celebrate" : "idle";
    }
  }

  private getGiantRestoreTarget(celebration: GiantCelebrationState): GiantPresentationFrame {
    return getGiantRestoreTarget(
      celebration,
      this.monitors,
      this.activityArea,
      this.settings?.alwaysOnTop ?? true,
    );
  }

  private applySquarePresentationFrame(
    frame: GiantPresentationFrame,
    time: number,
    forceSync = false,
  ): void {
    const position = topLeftFromCenter(frame.center, frame.windowDimensions);
    this.flowPresentationLayout = null;
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
      visible: true,
    });
  }

  private holdFlowPresentation(): void {
    const celebration = this.giantCelebration;
    if (!celebration) {
      return;
    }

    const focusVisible = this.focusUsesCentralPresentation();
    const layout = focusVisible
      ? createFocusPresentationLayout(celebration, this.monitors, this.activityArea)
      : null;
    this.flowPresentationMode = "holding";
    this.flowPresentationLayout = layout;
    this.root.classList.remove("flow-entering");
    this.root.classList.add("flow-holding");
    this.petDimensions = { ...(layout?.petDimensions ?? celebration.targetPetDimensions) };
    this.petWindowDimensions = { ...celebration.targetWindowDimensions };
    this.position = topLeftFromCenter(
      celebration.targetCenter,
      celebration.targetWindowDimensions,
    );
    this.resizeCanvas();
    if (layout) {
      const dialogStyle = this.focusDialog.element.style;
      dialogStyle.left = `${layout.dialogOffset.x}px`;
      dialogStyle.top = `${layout.dialogOffset.y}px`;
      dialogStyle.width = `${layout.dialogDimensions.width}px`;
      dialogStyle.height = `${layout.dialogDimensions.height}px`;
      this.focusDialog.element.dataset.placement = layout.dialogPlacement;
      this.focusDialog.render(this.focusSession);
    } else {
      this.focusDialog.hide();
    }
    if (
      !this.externalNotifications.presenting &&
      this.externalNotifications.items.length > 0 &&
      this.canPresentExternalNotification()
    ) {
      this.externalNotifications = startExternalNotifications(
        this.externalNotifications,
        performance.now(),
      );
    }
    if (this.externalNotifications.presenting) {
      this.applyExternalLayout(celebration, layout, !layout);
      return;
    }
    this.externalPresentationLayout = null;
    if (!layout) {
      this.beginFlowRestore();
      return;
    }
    this.requestTemporaryPetPresentation({
      position: layout.windowPosition,
      dimensions: layout.windowLogicalDimensions,
      alwaysOnTop: true,
      visible: true,
      ignoreCursorEvents: false,
    });
  }

  private beginFlowRestore(): void {
    const celebration = this.giantCelebration;
    if (!celebration) {
      this.finishFlowPresentation();
      return;
    }
    this.focusDialog.hide();
    this.externalDialog.hide();
    this.root.classList.remove("flow-holding");
    this.flowPresentationLayout = null;
    this.externalPresentationLayout = null;
    this.pendingFocusPresentation = false;

    if (this.settings?.petVisible === false || this.flowPresentationMode === "entering") {
      this.finishFlowPresentation(this.settings?.petVisible === false);
      return;
    }

    this.flowPresentationMode = "restoring";
    this.flowRestoreStartedAt = performance.now();
    this.petDimensions = { ...celebration.targetPetDimensions };
    this.petWindowDimensions = { ...celebration.targetWindowDimensions };
    this.position = topLeftFromCenter(
      celebration.targetCenter,
      celebration.targetWindowDimensions,
    );
    this.resizeCanvas();
    this.requestTemporaryPetPresentation({
      position: this.position,
      dimensions: celebration.targetPetDimensions,
      alwaysOnTop: true,
      visible: true,
      ignoreCursorEvents: true,
    });
  }

  private finishFlowPresentation(forceHidden = false): void {
    const celebration = this.giantCelebration;
    this.presentationRequestId += 1;
    this.focusDialog.hide();
    this.externalDialog.hide();
    this.root.classList.remove("flow-presenting", "flow-entering", "flow-holding");
    this.flowPresentationMode = null;
    this.flowPresentationLayout = null;
    this.externalPresentationLayout = null;
    this.giantCelebration = null;
    this.pendingFocusPresentation = false;
    this.completionCelebrateUntil = 0;
    if (!celebration) {
      return;
    }

    const restoreTarget = this.getGiantRestoreTarget(celebration);
    const position = topLeftFromCenter(restoreTarget.center, restoreTarget.windowDimensions);
    this.petDimensions = restoreTarget.petDimensions;
    this.petWindowDimensions = restoreTarget.windowDimensions;
    this.position = position;
    this.mood = this.focusSession.isRunning ? "timer-waiting" : "idle";
    this.restMood = "idle";
    this.restUntil = performance.now() + petCadence.postCelebrationRestMs;
    this.resizeCanvas();
    this.requestTemporaryPetPresentation({
      position,
      dimensions: restoreTarget.petDimensions,
      alwaysOnTop: restoreTarget.alwaysOnTop,
      visible: !forceHidden && (this.settings?.petVisible ?? true),
      ignoreCursorEvents: false,
    });
    this.pickTarget();
    this.tryBeginExternalPresentation();
  }

  private reconcilePresentationMonitor(time: number): void {
    if (
      this.focusPresentationContextInFlight ||
      time - this.lastPresentationMonitorCheck < 2000
    ) {
      return;
    }
    this.lastPresentationMonitorCheck = time;
    this.focusPresentationContextInFlight = true;
    invoke<FocusPresentationContext>("get_focus_presentation_context")
      .then((context) => {
        const celebration = this.giantCelebration;
        if (!celebration || this.flowPresentationMode !== "holding") {
          return;
        }
        this.monitors = context.monitors;
        if (presentationMonitorIsAvailable(celebration, context.monitors)) {
          return;
        }
        const retargeted = createGiantCelebration({
          startedAt: performance.now() - giantCelebrationEnterMs,
          petDimensions: celebration.normalPetDimensions,
          petWindowDimensions: celebration.normalWindowDimensions,
          position: topLeftFromCenter(
            celebration.normalCenter,
            celebration.normalWindowDimensions,
          ),
          monitors: context.monitors,
          activityArea: this.activityArea,
          coordinateScale:
            celebration.normalWindowDimensions.width /
            Math.max(1, celebration.normalPetDimensions.width),
          targetPoint: context.cursor,
          centerInWorkArea: true,
        });
        if (!retargeted) {
          return;
        }
        retargeted.restorePetDimensions = celebration.restorePetDimensions;
        retargeted.restoreWindowDimensions = celebration.restoreWindowDimensions;
        this.giantCelebration = retargeted;
        this.holdFlowPresentation();
      })
      .finally(() => {
        this.focusPresentationContextInFlight = false;
      });
  }

  private async performFocusSessionAction(action: FocusSessionAction): Promise<void> {
    await invoke<FocusSessionSnapshot>("focus_session_action", { action });
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
      visible: presentation.visible,
      ignoreCursorEvents: presentation.ignoreCursorEvents,
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
    this.suppressCursorInteraction(cursorInteractionCadence.pointerExitProtectionMs);
    if (this.flowPresentationMode || this.externalPresentationMode) {
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
    if (this.flowPresentationMode || this.externalPresentationMode) {
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
    if (this.flowPresentationMode) {
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
    const shouldBeginPresentation = this.pendingFocusPresentation;
    if (this.drag) {
      try {
        this.canvas.releasePointerCapture(this.drag.pointerId);
      } catch {
        // The pointer may already be released by the OS.
      }
    }
    this.drag = null;
    if (shouldBeginPresentation) {
      this.pendingFocusPresentation = false;
      this.beginFocusPresentation();
      return;
    }
    this.tryBeginExternalPresentation();
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
    const noticeOffset = Math.round(
      cursorNoticeOffset(this.cursorInteraction, time) *
        (window.devicePixelRatio || 1),
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
    if (await isPermissionGranted()) {
      return;
    }
    await requestPermission();
  } catch {
    // Timer completion still emits an in-app event if the OS denies notifications.
  }
}
