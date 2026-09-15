export const MAX_VIDEO_FRAMES = 200;
export const MIN_VIDEO_FPS = 1;
export const MAX_VIDEO_FPS = 30;

export interface VideoFramePlan {
  times: number[];
  durationMs: number;
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
  const safeDuration = Math.max(0, duration);
  const safeStart = clampVideoRange(start, safeDuration);
  const safeEnd = Math.min(safeDuration, Math.max(safeStart, Number.isFinite(end) ? end : safeStart));
  const safeFps = clampVideoFps(fps);
  const frameDurationMs = Math.max(10, Math.round(1000 / safeFps / 10) * 10);
  const frameCount = Math.min(MAX_VIDEO_FRAMES, Math.max(1, Math.ceil((safeEnd - safeStart) * safeFps)));
  const times = Array.from({ length: frameCount }, (_, index) => Math.min(safeEnd, safeStart + index / safeFps));
  return { times, durationMs: frameDurationMs };
}

export function formatVideoTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}
