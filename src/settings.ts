import { invoke } from "@tauri-apps/api/core";
import type {
  ActivityLevel,
  BootstrapPayload,
  Dimensions,
  PetSize,
  Point,
  Rect,
  UserPreferences,
} from "./types";

const sizeLabels: Record<PetSize, string> = {
  small: "小",
  medium: "中",
  large: "大",
};

const activityLabels: Record<ActivityLevel, string> = {
  quiet: "安静",
  standard: "标准",
  lively: "活泼",
};

export function mountSettings(root: HTMLElement): void {
  const app = new SettingsController(root);
  app.start();
}

class SettingsController {
  private bootstrap: BootstrapPayload | null = null;
  private customArea: Rect | null = null;
  private dragStart: Point | null = null;
  private draftArea: Rect | null = null;
  private readonly canvas = document.createElement("canvas");
  private readonly status = document.createElement("p");
  private draftPreferences: UserPreferences | null = null;
  private saveQueue: Promise<BootstrapPayload | null> = Promise.resolve(null);
  private statusMessage: string | null = null;
  private statusTone: "neutral" | "success" | "warning" | "error" = "neutral";

  constructor(private readonly root: HTMLElement) {}

  async start(): Promise<void> {
    this.root.className = "settings-root";
    this.bootstrap = await invoke<BootstrapPayload>("get_desktop_snapshot");
    this.customArea = this.bootstrap.settings.customActivityArea;
    this.render();
    this.installCanvasHandlers();
  }

  private render(): void {
    if (!this.bootstrap) {
      return;
    }
    const settings = this.bootstrap.settings;
    this.root.replaceChildren();

    const shell = element("section", "settings-shell");
    const header = element("header", "settings-header");
    const titleBlock = element("div", "settings-title-block");
    titleBlock.append(element("span", "settings-app-mark"), element("h1", "", "偏好设置"));
    header.append(titleBlock);

    const sidebar = element("aside", "settings-sidebar");
    sidebar.append(
      element("p", "settings-sidebar-title", "Deskmon"),
      this.summaryItem("尺寸", sizeLabels[settings.petSize]),
      this.summaryItem("活跃", activityLabels[settings.activityLevel]),
      this.summaryItem("置顶", settings.alwaysOnTop ? "开启" : "关闭"),
      this.summaryItem("区域", this.customArea ? formatDimensions(this.customArea) : "默认"),
    );

    const controls = element("section", "settings-panel settings-controls");
    controls.append(element("h2", "", "桌宠行为"));
    const fields = element("div", "settings-fields");
    fields.append(
      this.segmentedControl<PetSize>(
        "尺寸",
        settings.petSize,
        ["small", "medium", "large"],
        sizeLabels,
        (petSize) => this.save({ petSize }),
      ),
      this.segmentedControl<ActivityLevel>(
        "活跃程度",
        settings.activityLevel,
        ["quiet", "standard", "lively"],
        activityLabels,
        (activityLevel) => this.save({ activityLevel }),
      ),
      this.toggleControl("默认置顶", settings.alwaysOnTop, (alwaysOnTop) =>
        this.save({ alwaysOnTop }),
      ),
    );
    controls.append(fields);

    const areaPanel = element("section", "settings-panel area-panel");
    const areaHeader = element("div", "panel-header");
    areaHeader.append(element("h2", "", "活动区域"));
    const resetButton = element("button", "ghost-button", "重置默认");
    resetButton.addEventListener("click", () => {
      this.customArea = null;
      this.draftArea = null;
      this.drawAreaCanvas();
      void this.save({ customActivityArea: null });
    });
    areaHeader.append(resetButton);

    const canvasWrap = element("div", "canvas-wrap");
    this.canvas.className = "area-canvas";
    canvasWrap.append(this.canvas);
    this.status.className = `settings-status ${this.statusTone}`;
    this.status.textContent = this.statusMessage ?? this.savedAreaMessage();
    areaPanel.append(areaHeader, canvasWrap, this.status);

    const content = element("main", "settings-content");
    content.append(controls, areaPanel);

    const workspace = element("div", "settings-workspace");
    workspace.append(sidebar, content);

    shell.append(header, workspace);
    this.root.append(shell);
    requestAnimationFrame(() => this.drawAreaCanvas());
  }

  private summaryItem(label: string, value: string): HTMLElement {
    const item = element("div", "settings-summary-item");
    item.append(element("span", "", label), element("strong", "", value));
    return item;
  }

  private segmentedControl<T extends string>(
    label: string,
    current: T,
    values: T[],
    labels: Record<T, string>,
    onChange: (value: T) => void,
  ): HTMLElement {
    const field = element("div", "field-row");
    field.append(element("span", "field-label", label));
    const group = element("div", "segmented");
    for (const value of values) {
      const button = element("button", value === current ? "selected" : "", labels[value]);
      button.addEventListener("click", () => onChange(value));
      group.append(button);
    }
    field.append(group);
    return field;
  }

  private toggleControl(
    label: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
  ): HTMLElement {
    const field = element("label", "field-row toggle-row");
    const labelEl = element("span", "field-label", label);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    const switchEl = element("span", "switch");
    switchEl.append(input, element("span", "switch-track"));
    field.append(labelEl, switchEl);
    return field;
  }

  private save(patch: Partial<UserPreferences>): void {
    if (!this.bootstrap) {
      return;
    }
    const areaTouched = Object.prototype.hasOwnProperty.call(patch, "customActivityArea");
    const settings = this.bootstrap.settings;
    const current = this.draftPreferences ?? {
      petSize: settings.petSize,
      activityLevel: settings.activityLevel,
      alwaysOnTop: settings.alwaysOnTop,
      customActivityArea: this.customArea,
    };
    const preferences: UserPreferences = {
      petSize: patch.petSize ?? current.petSize,
      activityLevel: patch.activityLevel ?? current.activityLevel,
      alwaysOnTop: patch.alwaysOnTop ?? current.alwaysOnTop,
      customActivityArea:
        patch.customActivityArea === undefined ? current.customActivityArea : patch.customActivityArea,
    };
    this.draftPreferences = preferences;
    this.setStatus("保存中");
    this.saveQueue = this.saveQueue
      .then(() =>
        invoke<BootstrapPayload>("save_user_preferences", {
          preferences,
        }),
      )
      .then((bootstrap) => {
        if (this.draftPreferences === preferences) {
          this.draftPreferences = null;
          this.bootstrap = bootstrap;
          this.customArea = bootstrap.settings.customActivityArea;
          if (areaTouched && preferences.customActivityArea && !this.customArea) {
            this.setStatus("区域超出可用工作区，已恢复默认区域", "warning");
          } else if (areaTouched) {
            this.setStatus(this.savedAreaMessage(), "success");
          } else {
            this.setStatus("已保存", "success");
          }
          this.render();
        }
        return bootstrap;
      })
      .catch((error) => {
        if (this.draftPreferences === preferences) {
          this.draftPreferences = null;
        }
        this.setStatus(String(error), "error");
        return null;
      });
    void this.saveQueue;
  }

  private installCanvasHandlers(): void {
    this.canvas.addEventListener("pointerdown", (event) => {
      if (!this.bootstrap || event.button !== 0) {
        return;
      }
      this.canvas.setPointerCapture(event.pointerId);
      this.dragStart = clampPointToRect(
        this.canvasToWorld(event),
        this.bootstrap.defaultActivityArea,
      );
      this.draftArea = normalizeRect(this.dragStart, this.dragStart);
      this.setStatus(this.draftAreaMessage(this.draftArea), "warning");
      this.drawAreaCanvas();
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.dragStart || !this.bootstrap) {
        return;
      }
      const current = clampPointToRect(
        this.canvasToWorld(event),
        this.bootstrap.defaultActivityArea,
      );
      this.draftArea = normalizeRect(this.dragStart, current);
      this.setStatus(
        this.draftAreaMessage(this.draftArea),
        this.areaLargeEnough(this.draftArea) ? "neutral" : "warning",
      );
      this.drawAreaCanvas();
    });
    this.canvas.addEventListener("pointerup", (event) => {
      if (!this.dragStart || !this.bootstrap) {
        return;
      }
      try {
        this.canvas.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released by the OS.
      }
      const current = clampPointToRect(
        this.canvasToWorld(event),
        this.bootstrap.defaultActivityArea,
      );
      const area = normalizeRect(this.dragStart, current);
      this.dragStart = null;
      this.draftArea = null;
      if (!this.areaLargeEnough(area)) {
        this.setStatus(`区域太小，${this.draftAreaMessage(area)}`, "warning");
        this.drawAreaCanvas();
        return;
      }
      this.customArea = area;
      this.setStatus("保存中");
      this.drawAreaCanvas();
      this.save({ customActivityArea: this.customArea });
    });
    this.canvas.addEventListener("pointercancel", (event) => {
      if (!this.dragStart) {
        return;
      }
      try {
        this.canvas.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released by the OS.
      }
      this.dragStart = null;
      this.draftArea = null;
      this.setStatus(this.savedAreaMessage());
      this.drawAreaCanvas();
    });
  }

  private canvasToWorld(event: PointerEvent): Point {
    const transform = this.getTransform();
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left - transform.offset.x) / transform.scale + transform.world.x,
      y: (event.clientY - bounds.top - transform.offset.y) / transform.scale + transform.world.y,
    };
  }

  private drawAreaCanvas(): void {
    if (!this.bootstrap) {
      return;
    }
    const bounds = this.canvas.parentElement?.getBoundingClientRect();
    const cssWidth = Math.max(320, Math.floor(bounds?.width ?? 620));
    const cssHeight = 330;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = "#f8faf7";
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    const transform = this.getTransform();
    const drawRect = (rect: Rect, fill: string, stroke: string): void => {
      const x = transform.offset.x + (rect.x - transform.world.x) * transform.scale;
      const y = transform.offset.y + (rect.y - transform.world.y) * transform.scale;
      const width = rect.width * transform.scale;
      const height = rect.height * transform.scale;
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.fillRect(x, y, width, height);
      ctx.strokeRect(x, y, width, height);
    };

    for (const monitor of this.bootstrap.monitors) {
      drawRect(monitor.workArea, "#e8f0ea", "#7a9182");
    }

    drawRect(this.bootstrap.defaultActivityArea, "rgba(74, 144, 226, 0.12)", "#4a90e2");
    if (this.customArea) {
      drawRect(this.customArea, "rgba(64, 171, 103, 0.2)", "#2f9d61");
    }
    if (this.draftArea) {
      const draftValid = this.areaLargeEnough(this.draftArea);
      drawRect(
        this.draftArea,
        draftValid ? "rgba(242, 180, 73, 0.24)" : "rgba(226, 88, 88, 0.18)",
        draftValid ? "#d28b1d" : "#c94646",
      );
    }

    const active = this.customArea ?? this.bootstrap.defaultActivityArea;
    const pet = this.bootstrap.petWindowDimensions;
    drawRect(
      {
        x: active.x + active.width - pet.width,
        y: active.y + active.height - pet.height,
        width: pet.width,
        height: pet.height,
      },
      "rgba(88, 197, 127, 0.28)",
      "#248052",
    );
  }

  private minimumAreaDimensions(): Dimensions {
    const pet = this.bootstrap?.petWindowDimensions ?? { width: 104, height: 104 };
    return {
      width: pet.width * 3,
      height: pet.height * 2,
    };
  }

  private areaLargeEnough(area: Rect): boolean {
    const min = this.minimumAreaDimensions();
    return area.width >= min.width && area.height >= min.height;
  }

  private savedAreaMessage(): string {
    const min = this.minimumAreaDimensions();
    const area = this.customArea;
    if (!area) {
      return `使用默认区域，最小 ${formatDimensions(min)}`;
    }
    return `已保存自定义区域 ${formatDimensions(area)}`;
  }

  private draftAreaMessage(area: Rect): string {
    return `当前 ${formatDimensions(area)}，至少 ${formatDimensions(this.minimumAreaDimensions())}`;
  }

  private setStatus(
    message: string,
    tone: "neutral" | "success" | "warning" | "error" = "neutral",
  ): void {
    this.statusMessage = message;
    this.statusTone = tone;
    this.status.className = `settings-status ${tone}`;
    this.status.textContent = message;
  }

  private getTransform(): {
    world: Rect;
    scale: number;
    offset: Point;
  } {
    const bootstrap = this.bootstrap;
    const fallback: Rect = { x: 0, y: 0, width: 1200, height: 800 };
    const areas = bootstrap?.monitors.map((monitor) => monitor.workArea) ?? [fallback];
    const world = unionRects(areas);
    const bounds = this.canvas.getBoundingClientRect();
    const width = Math.max(320, bounds.width || 620);
    const height = Math.max(260, bounds.height || 330);
    const scale = Math.min((width - 36) / world.width, (height - 36) / world.height);
    return {
      world,
      scale,
      offset: {
        x: (width - world.width * scale) / 2,
        y: (height - world.height * scale) / 2,
      },
    };
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text) {
    node.textContent = text;
  }
  return node;
}

function normalizeRect(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

function formatDimensions(size: Dimensions): string {
  return `${Math.round(size.width)} x ${Math.round(size.height)}`;
}

function unionRects(rects: Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function clampPointToRect(point: Point, rect: Rect): Point {
  return {
    x: clamp(point.x, rect.x, rect.x + rect.width),
    y: clamp(point.y, rect.y, rect.y + rect.height),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
