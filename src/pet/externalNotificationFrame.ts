import type { ExternalNotificationPlacement } from "./externalNotificationPresentation";

const svgNamespace = "http://www.w3.org/2000/svg";
const frameWidth = 360;
const frameHeight = 152;
const cardWidth = 312;
const cardHeight = 116;

interface CardOrigin {
  x: number;
  y: number;
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  className: string,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(svgNamespace, tag);
  element.setAttribute("class", className);
  return element;
}

function pointsPath(points: Array<[number, number]>): string {
  return `${points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`)
    .join(" ")} Z`;
}

function pixelRectPath(x: number, y: number, width: number, height: number): string {
  return pointsPath([
    [x + 16, y],
    [x + width - 16, y],
    [x + width - 16, y + 4],
    [x + width - 8, y + 4],
    [x + width - 8, y + 8],
    [x + width, y + 8],
    [x + width, y + height - 8],
    [x + width - 8, y + height - 8],
    [x + width - 8, y + height - 4],
    [x + width - 16, y + height - 4],
    [x + width - 16, y + height],
    [x + 16, y + height],
    [x + 16, y + height - 4],
    [x + 8, y + height - 4],
    [x + 8, y + height - 8],
    [x, y + height - 8],
    [x, y + 8],
    [x + 8, y + 8],
    [x + 8, y + 4],
    [x + 16, y + 4],
  ]);
}

function rightBubblePath(x: number, y: number, width: number, height: number): string {
  const centerY = y + height / 2;
  return pointsPath([
    [x + 16, y],
    [x + width - 16, y],
    [x + width - 16, y + 4],
    [x + width - 8, y + 4],
    [x + width - 8, y + 8],
    [x + width, y + 8],
    [x + width, y + height - 8],
    [x + width - 8, y + height - 8],
    [x + width - 8, y + height - 4],
    [x + width - 16, y + height - 4],
    [x + width - 16, y + height],
    [x + 16, y + height],
    [x + 16, y + height - 4],
    [x + 8, y + height - 4],
    [x + 8, y + height - 8],
    [x, y + height - 8],
    [x, centerY + 8],
    [x - 4, centerY + 8],
    [x - 4, centerY + 4],
    [x - 12, centerY + 4],
    [x - 12, centerY - 4],
    [x - 4, centerY - 4],
    [x - 4, centerY - 8],
    [x, centerY - 8],
    [x, y + 8],
    [x + 8, y + 8],
    [x + 8, y + 4],
    [x + 16, y + 4],
  ]);
}

function leftBubblePath(x: number, y: number, width: number, height: number): string {
  const centerY = y + height / 2;
  return pointsPath([
    [x + 16, y],
    [x + width - 16, y],
    [x + width - 16, y + 4],
    [x + width - 8, y + 4],
    [x + width - 8, y + 8],
    [x + width, y + 8],
    [x + width, centerY - 8],
    [x + width + 4, centerY - 8],
    [x + width + 4, centerY - 4],
    [x + width + 12, centerY - 4],
    [x + width + 12, centerY + 4],
    [x + width + 4, centerY + 4],
    [x + width + 4, centerY + 8],
    [x + width, centerY + 8],
    [x + width, y + height - 8],
    [x + width - 8, y + height - 8],
    [x + width - 8, y + height - 4],
    [x + width - 16, y + height - 4],
    [x + width - 16, y + height],
    [x + 16, y + height],
    [x + 16, y + height - 4],
    [x + 8, y + height - 4],
    [x + 8, y + height - 8],
    [x, y + height - 8],
    [x, y + 8],
    [x + 8, y + 8],
    [x + 8, y + 4],
    [x + 16, y + 4],
  ]);
}

function belowBubblePath(x: number, y: number, width: number, height: number): string {
  const center = x + width / 2;
  return pointsPath([
    [x + 16, y],
    [center - 8, y],
    [center - 8, y - 4],
    [center - 4, y - 4],
    [center - 4, y - 12],
    [center + 4, y - 12],
    [center + 4, y - 4],
    [center + 8, y - 4],
    [center + 8, y],
    [x + width - 16, y],
    [x + width - 16, y + 4],
    [x + width - 8, y + 4],
    [x + width - 8, y + 8],
    [x + width, y + 8],
    [x + width, y + height - 8],
    [x + width - 8, y + height - 8],
    [x + width - 8, y + height - 4],
    [x + width - 16, y + height - 4],
    [x + width - 16, y + height],
    [x + 16, y + height],
    [x + 16, y + height - 4],
    [x + 8, y + height - 4],
    [x + 8, y + height - 8],
    [x, y + height - 8],
    [x, y + 8],
    [x + 8, y + 8],
    [x + 8, y + 4],
    [x + 16, y + 4],
  ]);
}

function bubblePath(
  placement: ExternalNotificationPlacement,
  x: number,
  y: number,
  width: number,
  height: number,
): string {
  if (placement === "left") {
    return leftBubblePath(x, y, width, height);
  }
  if (placement === "below") {
    return belowBubblePath(x, y, width, height);
  }
  return rightBubblePath(x, y, width, height);
}

function cardOrigin(placement: ExternalNotificationPlacement): CardOrigin {
  return placement === "left"
    ? { x: 0, y: 0 }
    : placement === "below"
      ? { x: 16, y: 12 }
      : { x: 16, y: 0 };
}

function appendPath(parent: SVGElement, className: string, pathData: string): SVGPathElement {
  const path = svgElement("path", className);
  path.setAttribute("d", pathData);
  parent.append(path);
  return path;
}

function appendPlacementFrame(
  frame: SVGSVGElement,
  placement: ExternalNotificationPlacement,
): void {
  const origin = cardOrigin(placement);
  const group = svgElement("g", "external-notification-frame-group");
  group.dataset.placement = placement;

  for (let count = 1; count <= 4; count += 1) {
    const offset = placement === "below" && count === 4 ? 24 : count * 8;
    const shadow = appendPath(
      group,
      "external-notification-frame-shadow",
      pixelRectPath(origin.x + offset, origin.y + offset, cardWidth, cardHeight),
    );
    shadow.dataset.layers = String(count);
  }

  for (const depth of [3, 2, 1]) {
    const offset = depth * 8;
    const layer = svgElement("g", "external-notification-frame-layer");
    layer.dataset.depth = String(depth);
    appendPath(
      layer,
      "external-notification-frame-layer-outline",
      pixelRectPath(origin.x + offset, origin.y + offset, cardWidth, cardHeight),
    );
    appendPath(
      layer,
      "external-notification-frame-layer-surface",
      pixelRectPath(
        origin.x + offset + 4,
        origin.y + offset + 4,
        cardWidth - 8,
        cardHeight - 8,
      ),
    );
    group.append(layer);
  }

  appendPath(
    group,
    "external-notification-frame-main-outline",
    bubblePath(placement, origin.x, origin.y, cardWidth, cardHeight),
  );
  appendPath(
    group,
    "external-notification-frame-main-surface",
    bubblePath(placement, origin.x + 4, origin.y + 4, cardWidth - 8, cardHeight - 8),
  );

  const highlight = svgElement("path", "external-notification-frame-highlight");
  highlight.setAttribute(
    "d",
    `M${origin.x + 32} ${origin.y + 16} H${origin.x + cardWidth - 32} ` +
      `M${origin.x + 16} ${origin.y + 32} V${origin.y + cardHeight - 32}`,
  );
  group.append(highlight);

  const inset = svgElement("path", "external-notification-frame-inset");
  inset.setAttribute(
    "d",
    `M${origin.x + 32} ${origin.y + cardHeight - 16} H${origin.x + cardWidth - 32} ` +
      `M${origin.x + cardWidth - 16} ${origin.y + 32} V${origin.y + cardHeight - 32}`,
  );
  group.append(inset);
  frame.append(group);
}

export function createExternalNotificationFrame(): SVGSVGElement {
  const frame = svgElement("svg", "external-notification-frame");
  frame.setAttribute("viewBox", `0 0 ${frameWidth} ${frameHeight}`);
  frame.setAttribute("width", String(frameWidth));
  frame.setAttribute("height", String(frameHeight));
  frame.setAttribute("preserveAspectRatio", "none");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("focusable", "false");
  for (const placement of ["right", "left", "below"] as const) {
    appendPlacementFrame(frame, placement);
  }
  return frame;
}
