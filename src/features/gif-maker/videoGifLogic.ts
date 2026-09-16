export const MAX_VIDEO_FRAMES = 200;
export const MIN_VIDEO_FPS = 1;
export const MAX_VIDEO_FPS = 30;
export const MAX_VIDEO_FRAME_DURATION_MS = 60_000;

export interface VideoFramePlan {
  times: number[];
  durationMs: number;
}

export interface VideoFrameSamplingOptions {
  everyNthFrame?: number;
  maxFrames?: number;
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
