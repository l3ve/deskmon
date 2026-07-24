export type PetMood =
  | "idle"
  | "walk"
  | "run"
  | "sleep"
  | "timer-waiting"
  | "celebrate"
  | "dragged";
export type PetFacing = "left" | "right";

export interface PetSkin {
  id: string;
  draw(ctx: CanvasRenderingContext2D, mood: PetMood, time: number, facing: PetFacing): void;
}

interface SpriteSheetDefinition {
  src: string;
  columns: number;
  rows: number;
  fps: number;
  directionalRows?: Partial<Record<PetFacing, number>>;
}

interface SpriteFrame {
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  anchorX: number;
  anchorY: number;
  anchorWidth: number;
  anchorHeight: number;
}

interface LoadedSpriteSheet {
  canvas: HTMLCanvasElement;
  frames: SpriteFrame[];
  columns: number;
  directionalRows?: Partial<Record<PetFacing, number>>;
  fps: number;
}

interface FrameBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface SpriteFrameScaleInput {
  sourceWidth: number;
  sourceHeight: number;
  anchorWidth: number;
  anchorHeight: number;
}

interface SpriteFrameRenderScales {
  effect: number;
  body: number;
}

const spriteTargetWidth = 28;
const spriteTargetHeight = 25;
const spriteTargetCenterX = 16;
const spriteTargetBaselineY = 30;
const spriteCanvasSize = 32;
const spriteFramePadding = 2;
const spriteMaxDrawWidth = spriteCanvasSize - spriteFramePadding * 2;
const spriteMaxDrawHeight = spriteCanvasSize - spriteFramePadding * 2;

const defaultSlimeSkin: PetSkin = {
  id: "pixel-slime-default",
  draw: drawSlime,
};

const slimeSpriteFps: Record<PetMood, number> = {
  idle: 3,
  walk: 4.5,
  run: 6.5,
  sleep: 2,
  "timer-waiting": 3,
  celebrate: 7,
  dragged: 3.5,
};

const slimeSpriteSheets: Record<PetMood, SpriteSheetDefinition> = {
  idle: {
    src: new URL("../assets/slime/idle.png", import.meta.url).href,
    columns: 6,
    rows: 1,
    fps: slimeSpriteFps.idle,
  },
  walk: {
    src: new URL("../assets/slime/walk.png", import.meta.url).href,
    columns: 6,
    rows: 2,
    fps: slimeSpriteFps.walk,
    directionalRows: { left: 0, right: 1 },
  },
  run: {
    src: new URL("../assets/slime/run.png", import.meta.url).href,
    columns: 6,
    rows: 2,
    fps: slimeSpriteFps.run,
    directionalRows: { right: 0, left: 1 },
  },
  sleep: {
    src: new URL("../assets/slime/sleep.png", import.meta.url).href,
    columns: 6,
    rows: 1,
    fps: slimeSpriteFps.sleep,
  },
  "timer-waiting": {
    src: new URL("../assets/slime/timer-waiting.png", import.meta.url).href,
    columns: 6,
    rows: 1,
    fps: slimeSpriteFps["timer-waiting"],
  },
  celebrate: {
    src: new URL("../assets/slime/celebrate.png", import.meta.url).href,
    columns: 6,
    rows: 1,
    fps: slimeSpriteFps.celebrate,
  },
  dragged: {
    src: new URL("../assets/slime/dragged.png", import.meta.url).href,
    columns: 6,
    rows: 1,
    fps: slimeSpriteFps.dragged,
  },
};

class SpriteSheetSlimeSkin implements PetSkin {
  id = "sprite-sheet-slime";
  private readonly sheets = new Map<PetMood, LoadedSpriteSheet>();

  constructor(
    definitions: Record<PetMood, SpriteSheetDefinition>,
    private readonly fallback: PetSkin,
  ) {
    for (const [mood, definition] of Object.entries(definitions) as [
      PetMood,
      SpriteSheetDefinition,
    ][]) {
      void loadSpriteSheet(definition)
        .then((sheet) => {
          this.sheets.set(mood, sheet);
        })
        .catch(() => {
          this.sheets.delete(mood);
        });
    }
  }

  draw(ctx: CanvasRenderingContext2D, mood: PetMood, time: number, facing: PetFacing): void {
    const sheet = this.sheets.get(mood);
    if (!sheet) {
      this.fallback.draw(ctx, mood, time, facing);
      return;
    }

    const frameIndex = getSpriteFrameIndex(sheet, time, facing);
    const frame = sheet.frames[frameIndex];
    const scales = spriteFrameRenderScales(frame);
    const width = Math.round(frame.sourceWidth * scales.effect);
    const height = Math.round(frame.sourceHeight * scales.effect);
    const anchorX = frame.anchorX * scales.effect;
    const anchorY = frame.anchorY * scales.effect;
    const anchorWidth = frame.anchorWidth * scales.effect;
    const anchorHeight = frame.anchorHeight * scales.effect;
    const x = clampSpritePosition(
      Math.round(spriteTargetCenterX - anchorX - anchorWidth * 0.5),
      width,
    );
    const y = clampSpritePosition(
      Math.round(spriteTargetBaselineY - anchorY - anchorHeight),
      height,
    );

    ctx.drawImage(
      sheet.canvas,
      frame.sourceX,
      frame.sourceY,
      frame.sourceWidth,
      frame.sourceHeight,
      x,
      y,
      width,
      height,
    );

    if (mood === "celebrate" && scales.body > scales.effect) {
      const bodyWidth = Math.round(frame.anchorWidth * scales.body);
      const bodyHeight = Math.round(frame.anchorHeight * scales.body);
      const bodyX = clampSpritePosition(
        Math.round(spriteTargetCenterX - bodyWidth * 0.5),
        bodyWidth,
      );
      const bodyY = clampSpritePosition(
        Math.round(spriteTargetBaselineY - bodyHeight),
        bodyHeight,
      );
      ctx.drawImage(
        sheet.canvas,
        frame.sourceX + frame.anchorX,
        frame.sourceY + frame.anchorY,
        frame.anchorWidth,
        frame.anchorHeight,
        bodyX,
        bodyY,
        bodyWidth,
        bodyHeight,
      );
    }
  }
}

export const spriteSlimeSkin: PetSkin = new SpriteSheetSlimeSkin(
  slimeSpriteSheets,
  defaultSlimeSkin,
);

export function spriteFrameRenderScales(
  frame: SpriteFrameScaleInput,
): SpriteFrameRenderScales {
  const body = Math.min(
    spriteTargetWidth / frame.anchorWidth,
    spriteTargetHeight / frame.anchorHeight,
  );
  return {
    body,
    effect: Math.min(
      body,
      spriteMaxDrawWidth / frame.sourceWidth,
      spriteMaxDrawHeight / frame.sourceHeight,
    ),
  };
}

async function loadSpriteSheet(definition: SpriteSheetDefinition): Promise<LoadedSpriteSheet> {
  const image = await loadImage(definition.src);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Sprite sheet canvas context is unavailable");
  }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const frameWidth = Math.floor(canvas.width / definition.columns);
  const frameHeight = Math.floor(canvas.height / definition.rows);
  const frames: SpriteFrame[] = [];

  for (let row = 0; row < definition.rows; row += 1) {
    for (let column = 0; column < definition.columns; column += 1) {
      frames.push(
        getFrameBounds(
          imageData,
          canvas.width,
          column * frameWidth,
          row * frameHeight,
          frameWidth,
          frameHeight,
        ),
      );
    }
  }

  return {
    canvas,
    frames,
    columns: definition.columns,
    directionalRows: definition.directionalRows,
    fps: definition.fps,
  };
}

function getSpriteFrameIndex(
  sheet: LoadedSpriteSheet,
  time: number,
  facing: PetFacing,
): number {
  const animationFrame = Math.floor((time / 1000) * sheet.fps);
  const directionalRow = sheet.directionalRows?.[facing];
  if (directionalRow !== undefined) {
    return directionalRow * sheet.columns + (animationFrame % sheet.columns);
  }
  return animationFrame % sheet.frames.length;
}

function clampSpritePosition(value: number, size: number): number {
  if (size >= spriteCanvasSize - spriteFramePadding * 2) {
    return spriteFramePadding;
  }
  return clamp(value, spriteFramePadding, spriteCanvasSize - spriteFramePadding - size);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load sprite sheet: ${src}`));
    image.src = src;
  });
}

function getFrameBounds(
  imageData: ImageData,
  imageWidth: number,
  frameX: number,
  frameY: number,
  frameWidth: number,
  frameHeight: number,
): SpriteFrame {
  const content = getContentBounds(imageData, imageWidth, frameX, frameY, frameWidth, frameHeight);
  if (!content) {
    return {
      sourceX: frameX,
      sourceY: frameY,
      sourceWidth: frameWidth,
      sourceHeight: frameHeight,
      anchorX: 0,
      anchorY: 0,
      anchorWidth: frameWidth,
      anchorHeight: frameHeight,
    };
  }

  const anchor =
    getLargestComponentBounds(imageData, imageWidth, frameX, frameY, frameWidth, frameHeight) ??
    content;

  return {
    sourceX: frameX + content.minX,
    sourceY: frameY + content.minY,
    sourceWidth: content.maxX - content.minX + 1,
    sourceHeight: content.maxY - content.minY + 1,
    anchorX: anchor.minX - content.minX,
    anchorY: anchor.minY - content.minY,
    anchorWidth: anchor.maxX - anchor.minX + 1,
    anchorHeight: anchor.maxY - anchor.minY + 1,
  };
}

function getContentBounds(
  imageData: ImageData,
  imageWidth: number,
  frameX: number,
  frameY: number,
  frameWidth: number,
  frameHeight: number,
): FrameBounds | null {
  let minX = frameWidth;
  let minY = frameHeight;
  let maxX = 0;
  let maxY = 0;

  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const index = ((frameY + y) * imageWidth + frameX + x) * 4;
      if (imageData.data[index + 3] === 0) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  return minX > maxX || minY > maxY ? null : { minX, minY, maxX, maxY };
}

function getLargestComponentBounds(
  imageData: ImageData,
  imageWidth: number,
  frameX: number,
  frameY: number,
  frameWidth: number,
  frameHeight: number,
): FrameBounds | null {
  const visited = new Uint8Array(frameWidth * frameHeight);
  let bestBounds: FrameBounds | null = null;
  let bestArea = 0;

  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const localIndex = y * frameWidth + x;
      if (visited[localIndex]) {
        continue;
      }
      const index = ((frameY + y) * imageWidth + frameX + x) * 4;
      if (imageData.data[index + 3] === 0) {
        visited[localIndex] = 1;
        continue;
      }

      const component = collectComponentBounds(
        imageData,
        imageWidth,
        frameX,
        frameY,
        frameWidth,
        frameHeight,
        x,
        y,
        visited,
      );
      if (component.area > bestArea) {
        bestArea = component.area;
        bestBounds = component.bounds;
      }
    }
  }

  return bestBounds;
}

function collectComponentBounds(
  imageData: ImageData,
  imageWidth: number,
  frameX: number,
  frameY: number,
  frameWidth: number,
  frameHeight: number,
  startX: number,
  startY: number,
  visited: Uint8Array,
): { bounds: FrameBounds; area: number } {
  const stack: number[] = [];
  const bounds: FrameBounds = { minX: startX, minY: startY, maxX: startX, maxY: startY };
  let area = 0;
  pushComponentPixel(
    stack,
    visited,
    imageData,
    imageWidth,
    frameX,
    frameY,
    frameWidth,
    frameHeight,
    startX,
    startY,
  );

  while (stack.length > 0) {
    const localIndex = stack.pop();
    if (localIndex === undefined) {
      continue;
    }
    const x = localIndex % frameWidth;
    const y = Math.floor(localIndex / frameWidth);

    area += 1;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);

    pushComponentPixel(
      stack,
      visited,
      imageData,
      imageWidth,
      frameX,
      frameY,
      frameWidth,
      frameHeight,
      x + 1,
      y,
    );
    pushComponentPixel(
      stack,
      visited,
      imageData,
      imageWidth,
      frameX,
      frameY,
      frameWidth,
      frameHeight,
      x - 1,
      y,
    );
    pushComponentPixel(
      stack,
      visited,
      imageData,
      imageWidth,
      frameX,
      frameY,
      frameWidth,
      frameHeight,
      x,
      y + 1,
    );
    pushComponentPixel(
      stack,
      visited,
      imageData,
      imageWidth,
      frameX,
      frameY,
      frameWidth,
      frameHeight,
      x,
      y - 1,
    );
  }

  return { bounds, area };
}

function pushComponentPixel(
  stack: number[],
  visited: Uint8Array,
  imageData: ImageData,
  imageWidth: number,
  frameX: number,
  frameY: number,
  frameWidth: number,
  frameHeight: number,
  x: number,
  y: number,
): void {
  if (x < 0 || y < 0 || x >= frameWidth || y >= frameHeight) {
    return;
  }
  const localIndex = y * frameWidth + x;
  if (visited[localIndex]) {
    return;
  }
  visited[localIndex] = 1;
  const index = ((frameY + y) * imageWidth + frameX + x) * 4;
  if (imageData.data[index + 3] === 0) {
    return;
  }
  stack.push(localIndex);
}

function drawSlime(ctx: CanvasRenderingContext2D, mood: PetMood, time: number): void {
  const wave = Math.sin(time / 180);
  const hop = mood === "walk" || mood === "run" ? Math.max(0, wave) : 0;
  const squash = mood === "dragged" ? 1 : mood === "run" ? 0.88 + hop * 0.1 : 1;
  const yShift = mood === "sleep" ? 2 : -hop * (mood === "run" ? 2 : 1);

  pixel(ctx, 7, 25, 18, 2, "#274533");
  pixel(ctx, 8, 24, 16, 1, "#3f6f4e");

  ctx.save();
  ctx.translate(0, yShift);
  ctx.scale(1, squash);

  const body = mood === "timer-waiting" ? "#5eb97f" : "#58c57f";
  const bodyDark = "#248052";
  const bodyMid = "#36a967";
  const shine = "#b9ffd0";

  pixel(ctx, 11, 7, 10, 1, bodyMid);
  pixel(ctx, 8, 8, 16, 2, bodyMid);
  pixel(ctx, 6, 10, 20, 4, body);
  pixel(ctx, 5, 14, 22, 7, body);
  pixel(ctx, 6, 21, 20, 3, bodyDark);
  pixel(ctx, 8, 24, 16, 1, bodyDark);
  pixel(ctx, 7, 11, 5, 2, shine);
  pixel(ctx, 9, 10, 3, 1, "#e9fff0");
  pixel(ctx, 23, 15, 2, 4, bodyMid);
  pixel(ctx, 6, 18, 2, 3, bodyMid);

  if (mood === "sleep") {
    pixel(ctx, 10, 16, 5, 1, "#183223");
    pixel(ctx, 18, 16, 5, 1, "#183223");
    pixel(ctx, 14, 20, 5, 1, "#1f5a39");
  } else {
    const eyeY = mood === "celebrate" ? 14 : 15;
    pixel(ctx, 10, eyeY, 3, 4, "#10251b");
    pixel(ctx, 20, eyeY, 3, 4, "#10251b");
    pixel(ctx, 11, eyeY, 1, 1, "#f7fff9");
    pixel(ctx, 21, eyeY, 1, 1, "#f7fff9");
    if (mood === "timer-waiting") {
      pixel(ctx, 15, 19, 3, 1, "#19432c");
      pixel(ctx, 16, 20, 1, 1, "#19432c");
    } else {
      pixel(ctx, 14, 20, 5, 1, "#19432c");
      pixel(ctx, 15, 21, 3, 1, "#19432c");
    }
  }

  if (mood === "timer-waiting") {
    pixel(ctx, 14, 5, 5, 1, "#2f6d55");
    pixel(ctx, 15, 6, 3, 2, "#f2d16b");
    pixel(ctx, 16, 8, 1, 1, "#2f6d55");
  }

  ctx.restore();

  if (mood === "celebrate") {
    const colors = ["#f26d6d", "#ffd166", "#4aa8ff", "#7bd88f"];
    for (let index = 0; index < 10; index += 1) {
      const angle = time / 260 + index * 0.9;
      const radius = 10 + (index % 3) * 3 + Math.sin(time / 170 + index) * 2;
      const x = 16 + Math.cos(angle) * radius;
      const y = 13 + Math.sin(angle) * radius;
      pixel(ctx, Math.round(x), Math.round(y), 1, 1, colors[index % colors.length]);
    }
  }
}

function pixel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
