import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowUpRight,
  createElement as createLucideElement,
  Save,
  Square,
  Type,
  Undo2,
  X,
} from "lucide";
import {
  renderAnnotations,
  type ScreenshotAnnotation,
  type ScreenshotDraft,
  type ScreenshotTool,
} from "./screenshot/annotations";
import {
  clamp,
  clampPoint,
  isValidSelection,
  placeToolbar,
  rectFromPoints,
  type ScreenshotPoint,
  type ScreenshotRect,
} from "./screenshot/geometry";
import {
  screenshotShadeState,
  type ScreenshotVisualMode,
} from "./screenshot/visualState";

interface ScreenshotCapturePayload {
  dataUrl: string;
  pixelWidth: number;
  pixelHeight: number;
}

interface ScreenshotEditingPayload {
  ownerLabel: string;
}

interface ScreenshotSaveError {
  message: string;
  directoryUnavailable: boolean;
}

interface FeedbackState extends ScreenshotSaveError {
  repaired: boolean;
}

interface TextDraft {
  position: ScreenshotPoint;
}

type LucideIcon = Parameters<typeof createLucideElement>[0];

const createDiv = (className: string) => {
  const element = document.createElement("div");
  element.className = className;
  return element;
};

const createIconButton = (
  label: string,
  icon: LucideIcon,
  className = "screenshot-icon-button",
) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = label;
  button.setAttribute("aria-label", label);
  const iconElement = createLucideElement(icon);
  iconElement.setAttribute("aria-hidden", "true");
  button.append(iconElement);
  return button;
};

const nextPaint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

const normalizeSaveError = (error: unknown): ScreenshotSaveError => {
  if (typeof error === "object" && error !== null) {
    const candidate = error as Partial<ScreenshotSaveError>;
    if (typeof candidate.message === "string") {
      return {
        message: candidate.message,
        directoryUnavailable: Boolean(candidate.directoryUnavailable),
      };
    }
  }
  if (typeof error === "string") {
    try {
      return normalizeSaveError(JSON.parse(error));
    } catch {
      return { message: error, directoryUnavailable: false };
    }
  }
  return { message: "截图保存失败，请重试", directoryUnavailable: false };
};

const canvasPngBase64 = (canvas: HTMLCanvasElement) =>
  new Promise<string>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("无法生成 PNG"));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("无法读取 PNG"));
      reader.onload = () => {
        const result = String(reader.result ?? "");
        const separator = result.indexOf(",");
        if (separator < 0) {
          reject(new Error("PNG 数据格式错误"));
          return;
        }
        resolve(result.slice(separator + 1));
      };
      reader.readAsDataURL(blob);
    }, "image/png");
  });

export const mountScreenshot = (root: HTMLElement) => {
  document.body.classList.add("screenshot-body");
  const windowLabel = getCurrentWindow().label;
  const overlay = createDiv("screenshot-overlay");
  overlay.setAttribute("aria-label", "区域截图");

  const fullMask = createDiv("screenshot-full-mask");
  const selectionFrame = createDiv("screenshot-selection-frame");
  selectionFrame.hidden = true;
  const sizeLabel = document.createElement("span");
  sizeLabel.className = "screenshot-size-label";
  selectionFrame.append(sizeLabel);

  const editingMask = createDiv("screenshot-editing-mask");
  editingMask.hidden = true;

  const editor = createDiv("screenshot-editor");
  editor.hidden = true;
  const image = document.createElement("img");
  image.className = "screenshot-frozen-image";
  image.alt = "";
  image.draggable = false;
  const annotationCanvas = document.createElement("canvas");
  annotationCanvas.className = "screenshot-annotation-canvas";
  const textArea = document.createElement("textarea");
  textArea.className = "screenshot-text-input";
  textArea.maxLength = 200;
  textArea.setAttribute("aria-label", "截图文字标注");
  textArea.hidden = true;
  editor.append(image, annotationCanvas, textArea);

  const toolbarStack = createDiv("screenshot-toolbar-stack");
  toolbarStack.hidden = true;
  const toolbar = createDiv("screenshot-toolbar");
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "截图标注工具");

  const rectangleButton = createIconButton("矩形", Square);
  const arrowButton = createIconButton("箭头", ArrowUpRight);
  const textButton = createIconButton("文字", Type);
  const toolDivider = createDiv("screenshot-toolbar-divider");
  const undoButton = createIconButton("撤销", Undo2);
  const commandDivider = createDiv("screenshot-toolbar-divider");
  const discardButton = createIconButton(
    "丢弃截图",
    X,
    "screenshot-icon-button screenshot-discard-button",
  );
  const saveButton = createIconButton(
    "保存截图",
    Save,
    "screenshot-save-button",
  );
  const saveLabel = document.createElement("span");
  saveLabel.textContent = "保存";
  saveButton.append(saveLabel);
  toolbar.append(
    rectangleButton,
    arrowButton,
    textButton,
    toolDivider,
    undoButton,
    commandDivider,
    discardButton,
    saveButton,
  );

  const feedback = createDiv("screenshot-save-feedback");
  feedback.hidden = true;
  const feedbackMessage = document.createElement("p");
  const feedbackActions = createDiv("screenshot-save-feedback-actions");
  const chooseDirectoryButton = document.createElement("button");
  chooseDirectoryButton.type = "button";
  chooseDirectoryButton.textContent = "重新选择目录";
  const restoreDesktopButton = document.createElement("button");
  restoreDesktopButton.type = "button";
  restoreDesktopButton.textContent = "恢复桌面";
  feedbackActions.append(chooseDirectoryButton, restoreDesktopButton);
  feedback.append(feedbackMessage, feedbackActions);
  toolbarStack.append(toolbar, feedback);
  overlay.append(fullMask, selectionFrame, editingMask, editor, toolbarStack);
  root.replaceChildren(overlay);

  const toolButtons = new Map<ScreenshotTool, HTMLButtonElement>([
    ["rectangle", rectangleButton],
    ["arrow", arrowButton],
    ["text", textButton],
  ]);

  let mode: ScreenshotVisualMode = "selecting";
  let dragStart: ScreenshotPoint | null = null;
  let dragCurrent: ScreenshotPoint | null = null;
  let activePointerId: number | null = null;
  let claimPromise: Promise<boolean> | null = null;
  let selection: ScreenshotRect | null = null;
  let capture: ScreenshotCapturePayload | null = null;
  let activeTool: ScreenshotTool | null = null;
  let annotations: ScreenshotAnnotation[] = [];
  let draft: ScreenshotDraft | null = null;
  let drawingPointerId: number | null = null;
  let textDraft: TextDraft | null = null;
  let saving = false;
  let repairingDirectory = false;
  let feedbackState: FeedbackState | null = null;

  const viewportSize = () => ({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  const currentDragRect = () =>
    dragStart && dragCurrent ? rectFromPoints(dragStart, dragCurrent) : null;

  const positionRect = (element: HTMLElement, rect: ScreenshotRect) => {
    element.style.left = `${rect.x}px`;
    element.style.top = `${rect.y}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
  };

  const updateToolbarPosition = () => {
    if (!selection || toolbarStack.hidden) {
      return;
    }
    const bounds = toolbarStack.getBoundingClientRect();
    const placement = placeToolbar(
      selection,
      { width: bounds.width, height: bounds.height },
      viewportSize(),
    );
    toolbarStack.style.left = `${placement.x}px`;
    toolbarStack.style.top = `${placement.y}px`;
    toolbarStack.dataset.insideSelection = String(placement.insideSelection);
  };

  const redrawAnnotations = () => {
    if (!selection || !capture) {
      return;
    }
    renderAnnotations(
      annotationCanvas,
      selection.width,
      selection.height,
      annotations,
      draft,
    );
  };

  const render = () => {
    overlay.dataset.mode = mode;
    overlay.classList.toggle("is-saving", saving);
    const shadeState = screenshotShadeState(mode, Boolean(selection));
    fullMask.hidden = !shadeState.showFullMask;
    editingMask.hidden = !shadeState.showSelectionMask;
    if (selection && shadeState.showSelectionMask) {
      positionRect(editingMask, selection);
    }

    const dragRect = currentDragRect();
    selectionFrame.hidden = mode !== "dragging" || !dragRect;
    if (dragRect) {
      positionRect(selectionFrame, dragRect);
      sizeLabel.textContent = `${Math.round(dragRect.width)} × ${Math.round(dragRect.height)}`;
    }

    const editing = (mode === "editing" || mode === "capturing") && Boolean(capture);
    editor.hidden = !editing;
    toolbarStack.hidden = mode !== "editing";
    if (selection && editing) {
      positionRect(editor, selection);
      redrawAnnotations();
    }

    toolButtons.forEach((button, tool) => {
      const active = activeTool === tool;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
      button.disabled = saving;
    });
    undoButton.disabled = saving || (!draft && !textDraft && annotations.length === 0);
    discardButton.disabled = saving;
    saveButton.disabled = saving;
    saveButton.setAttribute("aria-busy", String(saving));
    saveLabel.textContent = saving ? "保存中" : "保存";

    feedback.hidden = !feedbackState;
    if (feedbackState) {
      feedback.classList.toggle("is-repaired", feedbackState.repaired);
      feedbackMessage.textContent = feedbackState.message;
      feedbackActions.hidden =
        !feedbackState.directoryUnavailable || feedbackState.repaired;
    }
    chooseDirectoryButton.disabled = repairingDirectory || saving;
    restoreDesktopButton.disabled = repairingDirectory || saving;

    if (!toolbarStack.hidden) {
      requestAnimationFrame(updateToolbarPosition);
    }
  };

  const resetSelection = () => {
    mode = "selecting";
    dragStart = null;
    dragCurrent = null;
    activePointerId = null;
    claimPromise = null;
    selection = null;
    render();
  };

  const cancelText = () => {
    textDraft = null;
    textArea.value = "";
    textArea.hidden = true;
  };

  const commitText = () => {
    if (!textDraft) {
      return;
    }
    const text = textArea.value.slice(0, 200);
    const position = textDraft.position;
    cancelText();
    if (text.trim()) {
      annotations.push({ kind: "text", position, text });
    }
    redrawAnnotations();
  };

  const startText = (point: ScreenshotPoint) => {
    if (!selection) {
      return;
    }
    const minimumWidth = Math.min(80, selection.width);
    const x = clamp(point.x, 0, Math.max(0, selection.width - minimumWidth));
    const y = clamp(point.y, 0, Math.max(0, selection.height - 34));
    const width = Math.max(40, Math.min(220, selection.width - x));
    const height = Math.max(32, Math.min(96, selection.height - y));
    textDraft = { position: { x, y } };
    textArea.value = "";
    textArea.style.left = `${x}px`;
    textArea.style.top = `${y}px`;
    textArea.style.width = `${width}px`;
    textArea.style.height = `${height}px`;
    textArea.hidden = false;
    textArea.focus();
  };

  const editorPoint = (event: PointerEvent): ScreenshotPoint => {
    const bounds = annotationCanvas.getBoundingClientRect();
    return clampPoint(
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      { width: bounds.width, height: bounds.height },
    );
  };

  const beginSelection = (event: PointerEvent) => {
    if (mode !== "selecting" || event.button !== 0) {
      return;
    }
    const point = clampPoint(
      { x: event.clientX, y: event.clientY },
      viewportSize(),
    );
    dragStart = point;
    dragCurrent = point;
    activePointerId = event.pointerId;
    mode = "dragging";
    overlay.setPointerCapture(event.pointerId);
    claimPromise = invoke<boolean>("screenshot_claim_selection", {
      windowLabel,
    }).catch(() => false);
    render();
  };

  const updateSelection = (event: PointerEvent) => {
    if (mode !== "dragging" || activePointerId !== event.pointerId) {
      return;
    }
    dragCurrent = clampPoint(
      { x: event.clientX, y: event.clientY },
      viewportSize(),
    );
    render();
  };

  const finishSelection = async (event: PointerEvent) => {
    if (mode !== "dragging" || activePointerId !== event.pointerId) {
      return;
    }
    dragCurrent = clampPoint(
      { x: event.clientX, y: event.clientY },
      viewportSize(),
    );
    if (overlay.hasPointerCapture(event.pointerId)) {
      overlay.releasePointerCapture(event.pointerId);
    }
    const claimed = await (claimPromise ?? Promise.resolve(false));
    const rect = currentDragRect();
    if (!claimed || !rect) {
      resetSelection();
      return;
    }
    if (!isValidSelection(rect)) {
      await invoke("screenshot_release_selection", { windowLabel }).catch(() => undefined);
      resetSelection();
      return;
    }

    selection = rect;
    mode = "capturing";
    dragStart = null;
    dragCurrent = null;
    activePointerId = null;
    claimPromise = null;
    render();
    await nextPaint();

    try {
      capture = await invoke<ScreenshotCapturePayload>(
        "capture_screenshot_selection",
        { windowLabel, rect },
      );
      image.src = capture.dataUrl;
      await image.decode();
      annotationCanvas.width = capture.pixelWidth;
      annotationCanvas.height = capture.pixelHeight;
      mode = "editing";
      render();
    } catch {
      // The backend closes all screenshot layers and presents the actionable failure.
    }
  };

  const beginAnnotation = (event: PointerEvent) => {
    if (mode !== "editing" || saving || !activeTool || event.button !== 0) {
      return;
    }
    event.preventDefault();
    const point = editorPoint(event);
    if (activeTool === "text") {
      commitText();
      startText(point);
      render();
      return;
    }
    cancelText();
    drawingPointerId = event.pointerId;
    draft = { kind: activeTool, start: point, end: point };
    annotationCanvas.setPointerCapture(event.pointerId);
    redrawAnnotations();
    render();
  };

  const updateAnnotation = (event: PointerEvent) => {
    if (!draft || drawingPointerId !== event.pointerId) {
      return;
    }
    draft = { ...draft, end: editorPoint(event) };
    redrawAnnotations();
  };

  const finishAnnotation = (event: PointerEvent) => {
    if (!draft || drawingPointerId !== event.pointerId) {
      return;
    }
    const completed = { ...draft, end: editorPoint(event) };
    if (annotationCanvas.hasPointerCapture(event.pointerId)) {
      annotationCanvas.releasePointerCapture(event.pointerId);
    }
    drawingPointerId = null;
    draft = null;
    const width = Math.abs(completed.end.x - completed.start.x);
    const height = Math.abs(completed.end.y - completed.start.y);
    const valid =
      completed.kind === "rectangle"
        ? width >= 2 && height >= 2
        : Math.hypot(width, height) >= 4;
    if (valid) {
      annotations.push(completed);
    }
    redrawAnnotations();
    render();
  };

  const selectTool = (tool: ScreenshotTool) => {
    if (saving) {
      return;
    }
    commitText();
    draft = null;
    activeTool = tool;
    redrawAnnotations();
    render();
  };

  const undo = () => {
    if (saving) {
      return;
    }
    if (textDraft) {
      cancelText();
    } else if (draft) {
      draft = null;
      drawingPointerId = null;
    } else {
      annotations.pop();
    }
    redrawAnnotations();
    render();
  };

  const save = async () => {
    if (saving || mode !== "editing" || !capture || !selection) {
      return;
    }
    commitText();
    feedbackState = null;
    saving = true;
    render();
    await nextPaint();

    try {
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = capture.pixelWidth;
      exportCanvas.height = capture.pixelHeight;
      const context = exportCanvas.getContext("2d");
      if (!context) {
        throw new Error("无法创建截图画布");
      }
      context.drawImage(image, 0, 0, exportCanvas.width, exportCanvas.height);
      context.drawImage(annotationCanvas, 0, 0);
      const pngBase64 = await canvasPngBase64(exportCanvas);
      await invoke("save_screenshot_png", { pngBase64 });
    } catch (error) {
      const normalized = normalizeSaveError(error);
      feedbackState = { ...normalized, repaired: false };
      saving = false;
      render();
    }
  };

  const repairDirectory = async (action: "choose" | "desktop") => {
    if (repairingDirectory || saving) {
      return;
    }
    repairingDirectory = true;
    render();
    try {
      const path = await invoke<string | null>("repair_screenshot_directory", {
        action,
      });
      if (path) {
        feedbackState = {
          message: "保存目录已更新，请再次点击保存",
          directoryUnavailable: false,
          repaired: true,
        };
      }
    } catch (error) {
      feedbackState = {
        ...normalizeSaveError(error),
        directoryUnavailable: true,
        repaired: false,
      };
    } finally {
      repairingDirectory = false;
      render();
    }
  };

  overlay.addEventListener("pointerdown", beginSelection);
  overlay.addEventListener("pointermove", updateSelection);
  overlay.addEventListener("pointerup", (event) => void finishSelection(event));
  overlay.addEventListener("pointercancel", () => {
    if (mode === "dragging") {
      void invoke("screenshot_release_selection", { windowLabel });
      resetSelection();
    }
  });
  overlay.addEventListener("pointerdown", (event) => {
    if (
      mode === "editing" &&
      textDraft &&
      !editor.contains(event.target as Node) &&
      !toolbarStack.contains(event.target as Node)
    ) {
      commitText();
      render();
    }
  });

  annotationCanvas.addEventListener("pointerdown", beginAnnotation);
  annotationCanvas.addEventListener("pointermove", updateAnnotation);
  annotationCanvas.addEventListener("pointerup", finishAnnotation);
  annotationCanvas.addEventListener("pointercancel", () => {
    draft = null;
    drawingPointerId = null;
    redrawAnnotations();
    render();
  });
  textArea.addEventListener("pointerdown", (event) => event.stopPropagation());
  textArea.addEventListener("blur", () => {
    commitText();
    render();
  });

  toolbar.querySelectorAll("button").forEach((button) => {
    button.addEventListener("pointerdown", (event) => event.preventDefault());
  });
  rectangleButton.addEventListener("click", () => selectTool("rectangle"));
  arrowButton.addEventListener("click", () => selectTool("arrow"));
  textButton.addEventListener("click", () => selectTool("text"));
  undoButton.addEventListener("click", undo);
  discardButton.addEventListener("click", () => {
    if (!saving) {
      void invoke("cancel_screenshot_task");
    }
  });
  saveButton.addEventListener("click", () => void save());
  chooseDirectoryButton.addEventListener("click", () =>
    void repairDirectory("choose"),
  );
  restoreDesktopButton.addEventListener("click", () =>
    void repairDirectory("desktop"),
  );

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (mode === "selecting" || mode === "dragging")) {
      event.preventDefault();
      void invoke("cancel_screenshot_task");
    }
  });
  window.addEventListener("resize", updateToolbarPosition);

  void listen<ScreenshotEditingPayload>(
    "deskmon-screenshot-capturing",
    ({ payload }) => {
      mode = payload.ownerLabel === windowLabel ? "capturing" : "blocked";
      render();
    },
  );
  void listen<ScreenshotEditingPayload>(
    "deskmon-screenshot-editing",
    ({ payload }) => {
      if (payload.ownerLabel !== windowLabel) {
        mode = "blocked";
        render();
      }
    },
  );

  render();
};
