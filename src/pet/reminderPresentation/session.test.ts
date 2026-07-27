import { describe, expect, it } from "vitest";
import type {
  ReminderDialogController,
  ReminderDialogHandlers,
} from "./dialog";
import {
  createReminderPresentationSession,
  type ReminderPresentationEnvironment,
  type ReminderPresentationStatus,
} from "./session";

class FakeScheduler {
  callback: FrameRequestCallback | null = null;
  currentTime = 0;
  nextId = 1;

  cancel = (): void => {
    this.callback = null;
  };

  now = (): number => this.currentTime;

  request = (callback: FrameRequestCallback): number => {
    this.callback = callback;
    return this.nextId++;
  };

  fire(time: number): void {
    this.currentTime = time;
    const callback = this.callback;
    this.callback = null;
    callback?.(time);
  }
}

function environment(
  overrides: Partial<ReminderPresentationEnvironment> = {},
): ReminderPresentationEnvironment {
  return {
    petPosition: { x: 400, y: 700 },
    petDimensions: { width: 104, height: 104 },
    petWindowDimensions: { width: 104, height: 104 },
    monitors: [
      {
        name: "main",
        position: { x: 0, y: 0 },
        size: { width: 1440, height: 900 },
        workArea: { x: 0, y: 0, width: 1440, height: 860 },
        scaleFactor: 1,
      },
    ],
    fallbackArea: { x: 0, y: 0, width: 1440, height: 860 },
    alwaysOnTop: true,
    visible: true,
    ...overrides,
  };
}

function createHarness(
  projectWindow: (projection: unknown) => Promise<void> = async () => {},
) {
  const scheduler = new FakeScheduler();
  const statuses: ReminderPresentationStatus[] = [];
  let handlers: ReminderDialogHandlers | null = null;
  const dialog: ReminderDialogController = {
    applyLayout: () => {},
    clear: () => {},
    destroy: () => {},
    measureHeight: () => 152,
    render: () => {},
  };
  const session = createReminderPresentationSession(
    {
      root: {} as HTMLElement,
      canvas: {} as HTMLCanvasElement,
      onStatusChanged: (status) => statuses.push(status),
    },
    {
      createDialog: (nextHandlers) => {
        handlers = nextHandlers;
        return dialog;
      },
      projectWindow,
      scheduler,
    },
  );
  session.anchorChanged(environment());
  return {
    handlers: () => handlers,
    scheduler,
    session,
    statuses,
  };
}

describe("reminder presentation session", () => {
  it("only resumes after every pause reason has cleared", () => {
    const { scheduler, session, statuses } = createHarness();
    session.receive({ title: null, text: "完成", tone: "normal" });
    expect(statuses[statuses.length - 1]).toEqual({ active: true, tone: "normal" });
    expect(scheduler.callback).not.toBeNull();

    scheduler.currentTime = 100;
    session.pause("hover");
    session.pause("drag");
    expect(scheduler.callback).toBeNull();

    scheduler.currentTime = 200;
    session.resume("hover");
    expect(scheduler.callback).toBeNull();
    expect(statuses[statuses.length - 1]?.active).toBe(true);

    scheduler.currentTime = 300;
    session.resume("drag");
    expect(scheduler.callback).not.toBeNull();
    expect(statuses[statuses.length - 1]?.active).toBe(true);
  });

  it("keeps queued reminders hidden while any pause reason is active", () => {
    const { scheduler, session, statuses } = createHarness();
    session.pause("drag");
    session.pause("screenshot");
    session.receive({ title: "Deskmon", text: "稍后显示", tone: "normal" });
    expect(statuses).toEqual([]);
    expect(scheduler.callback).toBeNull();

    session.resume("drag");
    expect(statuses).toEqual([]);
    session.resume("screenshot");
    expect(statuses[statuses.length - 1]).toEqual({ active: true, tone: "normal" });
  });

  it("coalesces stale layouts and restores the latest pet window last", async () => {
    const projections: Array<Record<string, unknown>> = [];
    const resolvers: Array<() => void> = [];
    const projectWindow = (projection: unknown): Promise<void> => {
      projections.push(projection as Record<string, unknown>);
      return new Promise((resolve) => resolvers.push(resolve));
    };
    const { scheduler, session, statuses } = createHarness(projectWindow);
    session.receive({ title: null, text: "完成", tone: "normal" });
    expect(projections).toHaveLength(1);

    session.anchorChanged(environment({ petPosition: { x: 520, y: 720 } }));
    scheduler.fire(4000);
    expect(statuses[statuses.length - 1]).toEqual({ active: false, tone: null });
    expect(projections).toHaveLength(1);

    resolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(projections).toHaveLength(2);
    expect(projections[1]).toMatchObject({
      x: 520,
      y: 720,
      width: 104,
      height: 104,
      visible: true,
    });
  });
});
