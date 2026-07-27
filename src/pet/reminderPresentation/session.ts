import { invoke } from "@tauri-apps/api/core";
import type { Dimensions, MonitorPayload, Point, Rect } from "../../types";
import {
  createReminderDialog,
  type ReminderDialogController,
  type ReminderDialogHandlers,
} from "./dialog";
import { createReminderLayout, type ReminderLayout } from "./layout";
import {
  advanceReminder,
  clearReminders,
  completeReminderReveal,
  createReminderState,
  enqueueReminder,
  pauseReminders,
  reminderLayerCount,
  reminderRevealComplete,
  remindersExpired,
  resumeReminders,
  startReminders,
  type PetNotificationTone,
  type ReminderPayload,
  type ReminderState,
} from "./state";

export type ReminderPauseReason = "hover" | "drag" | "screenshot";

export interface ReminderPresentationEnvironment {
  petPosition: Point;
  petDimensions: Dimensions;
  petWindowDimensions: Dimensions;
  monitors: MonitorPayload[];
  fallbackArea: Rect;
  alwaysOnTop: boolean;
  visible: boolean;
}

export interface ReminderPresentationStatus {
  active: boolean;
  tone: PetNotificationTone | null;
}

export interface ReminderPresentationSession {
  anchorChanged(environment: ReminderPresentationEnvironment): void;
  dispose(): void;
  pause(reason: ReminderPauseReason): void;
  receive(payload: ReminderPayload): void;
  resume(reason: ReminderPauseReason): void;
}

interface WindowProjection {
  x: number;
  y: number;
  width: number;
  height: number;
  alwaysOnTop: boolean;
  visible: boolean;
  ignoreCursorEvents: boolean;
}

interface FrameScheduler {
  cancel(frameId: number): void;
  now(): number;
  request(callback: FrameRequestCallback): number;
}

interface ReminderPresentationAdapters {
  createDialog?(handlers: ReminderDialogHandlers): ReminderDialogController;
  projectWindow?(projection: WindowProjection): Promise<void>;
  scheduler?: FrameScheduler;
}

interface CreateReminderPresentationSessionOptions {
  canvas: HTMLCanvasElement;
  onStatusChanged(status: ReminderPresentationStatus): void;
  root: HTMLElement;
}

const browserScheduler: FrameScheduler = {
  cancel: (frameId) => cancelAnimationFrame(frameId),
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
};

export function createReminderPresentationSession(
  options: CreateReminderPresentationSessionOptions,
  adapters: ReminderPresentationAdapters = {},
): ReminderPresentationSession {
  const scheduler = adapters.scheduler ?? browserScheduler;
  const projectWindow =
    adapters.projectWindow ??
    ((projection: WindowProjection) =>
      invoke<void>("set_pet_temporary_presentation", { ...projection }));

  let disposed = false;
  let environment: ReminderPresentationEnvironment | null = null;
  let frameId: number | null = null;
  let layout: ReminderLayout | null = null;
  let pendingProjection: WindowProjection | null = null;
  let projectionInFlight = false;
  let state: ReminderState = createReminderState();
  let status: ReminderPresentationStatus = { active: false, tone: null };
  const pauseReasons = new Set<ReminderPauseReason>();

  const dialogHandlers: ReminderDialogHandlers = {
    onActivate: () => activateCurrent(),
    onHoverChanged: (hovered) => {
      if (hovered) {
        pause("hover");
      } else {
        resume("hover");
      }
    },
  };
  const dialog =
    adapters.createDialog?.(dialogHandlers) ??
    createReminderDialog(options.root, options.canvas, dialogHandlers);

  function emitStatus(): void {
    const next: ReminderPresentationStatus = {
      active: state.presenting,
      tone: state.items[0]?.tone ?? null,
    };
    if (next.active === status.active && next.tone === status.tone) {
      return;
    }
    status = next;
    options.onStatusChanged(next);
  }

  function queueProjection(projection: WindowProjection): void {
    pendingProjection = projection;
    void flushProjection();
  }

  async function flushProjection(): Promise<void> {
    if (projectionInFlight || !pendingProjection) {
      return;
    }
    const projection = pendingProjection;
    pendingProjection = null;
    projectionInFlight = true;
    try {
      await projectWindow(projection);
    } catch {
      // A transient native resize must not stall the reminder queue.
    } finally {
      projectionInFlight = false;
      if (pendingProjection) {
        void flushProjection();
      }
    }
  }

  function restorePetWindow(): void {
    if (!environment) {
      return;
    }
    queueProjection({
      x: environment.petPosition.x,
      y: environment.petPosition.y,
      width: environment.petDimensions.width,
      height: environment.petDimensions.height,
      alwaysOnTop: environment.alwaysOnTop,
      visible: environment.visible,
      ignoreCursorEvents: false,
    });
  }

  function cancelFrame(): void {
    if (frameId === null) {
      return;
    }
    scheduler.cancel(frameId);
    frameId = null;
  }

  function scheduleFrame(): void {
    if (
      disposed ||
      frameId !== null ||
      !state.presenting ||
      pauseReasons.size > 0
    ) {
      return;
    }
    frameId = scheduler.request(onFrame);
  }

  function onFrame(time: number): void {
    frameId = null;
    if (disposed || !state.presenting) {
      return;
    }
    if (remindersExpired(state, time)) {
      state = advanceReminder(state, time);
      if (!state.presenting) {
        finishPresentation();
        return;
      }
      syncPresentation();
    } else {
      render(time);
    }
    scheduleFrame();
  }

  function render(time: number): void {
    dialog.render(
      state.items[0] ?? null,
      reminderLayerCount(state),
      state.pausedAt ?? time,
    );
  }

  function syncPresentation(): void {
    if (!environment || !state.presenting) {
      return;
    }
    const current = state.items[0];
    if (!current) {
      return;
    }
    const layerCount = reminderLayerCount(state);
    const notificationHeight = dialog.measureHeight(current, layerCount);
    layout = createReminderLayout({
      petPosition: environment.petPosition,
      petDimensions: environment.petDimensions,
      petWindowDimensions: environment.petWindowDimensions,
      monitors: environment.monitors,
      fallbackArea: environment.fallbackArea,
      notificationHeight,
      lockedPlacement: pauseReasons.has("drag")
        ? layout?.notificationPlacement
        : undefined,
    });
    dialog.applyLayout(layout);
    render(scheduler.now());
    queueProjection({
      x: layout.windowPosition.x,
      y: layout.windowPosition.y,
      width: layout.windowLogicalDimensions.width,
      height: layout.windowLogicalDimensions.height,
      alwaysOnTop: true,
      visible: true,
      ignoreCursorEvents: false,
    });
    emitStatus();
    scheduleFrame();
  }

  function startIfReady(): void {
    if (
      disposed ||
      state.presenting ||
      state.items.length === 0 ||
      pauseReasons.size > 0 ||
      environment?.visible !== true
    ) {
      return;
    }
    state = startReminders(state, scheduler.now());
    syncPresentation();
  }

  function finishPresentation(): void {
    cancelFrame();
    dialog.clear();
    layout = null;
    emitStatus();
    restorePetWindow();
  }

  function clearPresentation(): void {
    state = clearReminders(state);
    finishPresentation();
  }

  function pause(reason: ReminderPauseReason): void {
    if (disposed || pauseReasons.has(reason)) {
      return;
    }
    const wasUnpaused = pauseReasons.size === 0;
    pauseReasons.add(reason);
    if (!wasUnpaused || !state.presenting) {
      return;
    }
    state = pauseReminders(state, scheduler.now());
    cancelFrame();
    render(scheduler.now());
  }

  function resume(reason: ReminderPauseReason): void {
    if (disposed || !pauseReasons.delete(reason) || pauseReasons.size > 0) {
      return;
    }
    if (state.presenting) {
      state = resumeReminders(state, scheduler.now());
      syncPresentation();
      return;
    }
    startIfReady();
  }

  function activateCurrent(): void {
    const current = state.items[0];
    if (disposed || !state.presenting || !current) {
      return;
    }
    const now = scheduler.now();
    const revealTime = state.pausedAt ?? now;
    if (!reminderRevealComplete(current, revealTime)) {
      state = completeReminderReveal(state);
      render(now);
      return;
    }
    state = advanceReminder(state, now);
    if (!state.presenting) {
      finishPresentation();
      return;
    }
    if (pauseReasons.size > 0) {
      state = pauseReminders(state, now);
    }
    syncPresentation();
  }

  return {
    anchorChanged(nextEnvironment): void {
      if (disposed) {
        return;
      }
      environment = nextEnvironment;
      if (!nextEnvironment.visible) {
        pauseReasons.delete("hover");
        pauseReasons.delete("drag");
        clearPresentation();
        return;
      }
      if (state.presenting) {
        syncPresentation();
      } else {
        startIfReady();
      }
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      clearPresentation();
      pauseReasons.clear();
      disposed = true;
      dialog.destroy();
    },
    pause,
    receive(payload): void {
      if (disposed || environment?.visible !== true) {
        return;
      }
      const result = enqueueReminder(state, payload, scheduler.now());
      state = result.state;
      if (!result.accepted) {
        return;
      }
      if (state.presenting) {
        syncPresentation();
      } else {
        startIfReady();
      }
    },
    resume,
  };
}

export type { PetNotificationTone, ReminderPayload };
