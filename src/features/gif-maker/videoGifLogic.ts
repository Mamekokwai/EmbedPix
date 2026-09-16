export const MAX_VIDEO_FRAMES = 200;
export const MIN_VIDEO_FPS = 1;
export const MAX_VIDEO_FPS = 30;
export const MAX_VIDEO_FRAME_DURATION_MS = 60_000;

export interface VideoCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type VideoCropRectInput = Partial<VideoCropRect> | null | undefined;

export interface VideoFramePlan {
  times: number[];
  durationMs: number;
}

export interface VideoFrameSamplingOptions {
  everyNthFrame?: number;
  maxFrames?: number;
}

function safeVideoDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 1;
}

export function isVideoCropRectWithinBounds(
  rect: VideoCropRectInput,
  sourceWidth: number,
  sourceHeight: number,
): rect is VideoCropRect {
  if (!rect || !Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) return false;
  const { x, y, width, height } = rect;
  if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number") return false;
  return Number.isFinite(x)
    && Number.isFinite(y)
    && Number.isFinite(width)
    && Number.isFinite(height)
    && x >= 0
    && y >= 0
    && width > 0
    && height > 0
    && x + width <= sourceWidth
    && y + height <= sourceHeight;
}

export function normalizeVideoCropRect(
  rect: VideoCropRectInput,
  sourceWidth: number,
  sourceHeight: number,
): VideoCropRect {
  const safeWidth = safeVideoDimension(sourceWidth);
  const safeHeight = safeVideoDimension(sourceHeight);
  const input = rect ?? {};
  const x = Math.min(safeWidth - 1, Math.max(0, typeof input.x === "number" && Number.isFinite(input.x) ? Math.floor(input.x) : 0));
  const y = Math.min(safeHeight - 1, Math.max(0, typeof input.y === "number" && Number.isFinite(input.y) ? Math.floor(input.y) : 0));
  const width = Math.min(safeWidth - x, Math.max(1, typeof input.width === "number" && Number.isFinite(input.width) ? Math.floor(input.width) : safeWidth - x));
  const height = Math.min(safeHeight - y, Math.max(1, typeof input.height === "number" && Number.isFinite(input.height) ? Math.floor(input.height) : safeHeight - y));
  return { x, y, width, height };
}

export function clampVideoFps(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.min(MAX_VIDEO_FPS, Math.max(MIN_VIDEO_FPS, Math.round(value)));
}

export function clampVideoRange(value: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(value)) return 0;
  return Math.min(duration, Math.max(0, value));
}

export function planVideoFrames(
  start: number,
  end: number,
  duration: number,
  fps: number,
): VideoFramePlan {
  return planVideoFramesWithSampling(start, end, duration, fps);
}

export function planVideoFramesWithSampling(
  start: number,
  end: number,
  duration: number,
  fps: number,
  options: VideoFrameSamplingOptions = {},
): VideoFramePlan {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safeStart = clampVideoRange(start, safeDuration);
  const safeEnd = Math.min(safeDuration, Math.max(safeStart, Number.isFinite(end) ? end : safeStart));
  const safeFps = clampVideoFps(fps);
  const requestedEveryNthFrame = options.everyNthFrame ?? 1;
  const requestedMaxFrames = options.maxFrames ?? MAX_VIDEO_FRAMES;
  const everyNthFrame = Math.max(1, Number.isFinite(requestedEveryNthFrame) ? Math.floor(requestedEveryNthFrame) : 1);
  const maxFrames = Math.min(MAX_VIDEO_FRAMES, Math.max(1, Number.isFinite(requestedMaxFrames) ? Math.floor(requestedMaxFrames) : MAX_VIDEO_FRAMES));
  const sourceFrameCount = Math.max(1, Math.ceil((safeEnd - safeStart) * safeFps));
  const requestedFrameCount = Math.max(1, Math.ceil(sourceFrameCount / everyNthFrame));
  const frameCount = Math.min(maxFrames, requestedFrameCount);
  const capped = requestedFrameCount > maxFrames;
  const times = capped
    ? Array.from({ length: frameCount }, (_, index) => safeStart + ((safeEnd - safeStart) * index) / frameCount)
    : Array.from({ length: frameCount }, (_, index) => Math.min(safeEnd, safeStart + (index * everyNthFrame) / safeFps));
  const intervalMs = capped ? ((safeEnd - safeStart) * 1000) / frameCount : (everyNthFrame * 1000) / safeFps;
  const durationMs = Math.min(MAX_VIDEO_FRAME_DURATION_MS, Math.max(10, Math.floor(intervalMs / 10) * 10));
  return { times, durationMs };
}

export function formatVideoTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
