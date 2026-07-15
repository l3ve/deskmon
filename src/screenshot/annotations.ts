import type { ScreenshotPoint, ScreenshotRect } from "./geometry";

export type ScreenshotTool = "rectangle" | "arrow" | "text";

export type ScreenshotAnnotation =
  | {
      kind: "rectangle";
      start: ScreenshotPoint;
      end: ScreenshotPoint;
    }
  | {
      kind: "arrow";
      start: ScreenshotPoint;
      end: ScreenshotPoint;
    }
  | {
      kind: "text";
      position: ScreenshotPoint;
      text: string;
    };

export type ScreenshotDraft = Extract<
  ScreenshotAnnotation,
  { kind: "rectangle" | "arrow" }
>;

const RED = "#e43e45";
const WHITE = "rgba(255, 255, 255, 0.96)";
const FONT_SIZE = 18;
const LINE_HEIGHT = 24;

const pathWithOutline = (
  context: CanvasRenderingContext2D,
  drawPath: () => void,
  whiteWidth: number,
  redWidth: number,
) => {
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = WHITE;
  context.lineWidth = whiteWidth;
  drawPath();
  context.stroke();
  context.strokeStyle = RED;
  context.lineWidth = redWidth;
  drawPath();
  context.stroke();
  context.restore();
};

const drawRectangle = (
  context: CanvasRenderingContext2D,
  start: ScreenshotPoint,
  end: ScreenshotPoint,
) => {
  const rect: ScreenshotRect = {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
  pathWithOutline(
    context,
    () => {
      context.beginPath();
      context.rect(rect.x, rect.y, rect.width, rect.height);
    },
    7,
    4,
  );
};

const drawArrow = (
  context: CanvasRenderingContext2D,
  start: ScreenshotPoint,
  end: ScreenshotPoint,
) => {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const headLength = 14;
  const drawPath = () => {
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.moveTo(end.x, end.y);
    context.lineTo(
      end.x - headLength * Math.cos(angle - Math.PI / 6),
      end.y - headLength * Math.sin(angle - Math.PI / 6),
    );
    context.moveTo(end.x, end.y);
    context.lineTo(
      end.x - headLength * Math.cos(angle + Math.PI / 6),
      end.y - headLength * Math.sin(angle + Math.PI / 6),
    );
  };
  pathWithOutline(context, drawPath, 8, 4);
};

const drawText = (
  context: CanvasRenderingContext2D,
  position: ScreenshotPoint,
  text: string,
) => {
  context.save();
  context.font = `700 ${FONT_SIZE}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  context.textBaseline = "top";
  context.lineJoin = "round";
  context.strokeStyle = WHITE;
  context.lineWidth = 5;
  context.fillStyle = RED;
  text.split("\n").forEach((line, index) => {
    const y = position.y + index * LINE_HEIGHT;
    context.strokeText(line, position.x, y);
    context.fillText(line, position.x, y);
  });
  context.restore();
};

const drawAnnotation = (
  context: CanvasRenderingContext2D,
  annotation: ScreenshotAnnotation,
) => {
  if (annotation.kind === "rectangle") {
    drawRectangle(context, annotation.start, annotation.end);
  } else if (annotation.kind === "arrow") {
    drawArrow(context, annotation.start, annotation.end);
  } else {
    drawText(context, annotation.position, annotation.text);
  }
};

export const renderAnnotations = (
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  annotations: ScreenshotAnnotation[],
  draft: ScreenshotDraft | null,
) => {
  const context = canvas.getContext("2d");
  if (!context || cssWidth <= 0 || cssHeight <= 0) {
    return;
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.scale(canvas.width / cssWidth, canvas.height / cssHeight);
  annotations.forEach((annotation) => drawAnnotation(context, annotation));
  if (draft) {
    drawAnnotation(context, draft);
  }
  context.restore();
};
