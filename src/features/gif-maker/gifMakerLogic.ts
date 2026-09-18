export interface GifCanvasSize { width: number; height: number }
export type GifCanvasPreset = "source" | "75" | "50" | "custom";
export type GifContentFit = "contain" | "cover" | "stretch";
export type GifContentAlignment = "center" | "top" | "bottom";
export interface GifContentMargins { top: number; right: number; bottom: number; left: number }
export interface GifContentRect { x: number; y: number; width: number; height: number }
export interface GifSizeComparison { baselineBytes: number; finalBytes: number; targetBytes?: number; maxBytes?: number }
export interface GifSizeComparisonSummary { ratioPercent: number; changePercent: number; reduced: boolean; meetsTarget: boolean | null; withinMax: boolean | null }
export type GifWorkloadLevel = "light" | "moderate" | "heavy";
export interface GifWorkloadEstimate {
  totalPixels: number;
  decodedBytes: number;
  paletteBytes: number;
  level: GifWorkloadLevel;
}
export interface GifByteFrame {
  data: Uint8Array;
  durationMs: number;
}
export const MAX_FRAMES = 200;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const MAX_TOTAL_PIXELS = 64 * 1024 * 1024;
export const MAX_FRAME_DURATION_MS = 60_000;
export const GIF_PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2] as const;
export type GifPlaybackSpeed = typeof GIF_PLAYBACK_SPEEDS[number];
export const GIF_COLOR_COUNTS = [2, 16, 32, 64, 128, 256] as const;
export type GifColorCount = typeof GIF_COLOR_COUNTS[number];

export function getNextGifTabIndex(currentIndex: number, tabCount: number, key: string) {
  if (tabCount <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return tabCount - 1;
  if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "ArrowUp" && key !== "ArrowDown") return currentIndex;
  const direction = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
  return (currentIndex + direction + tabCount) % tabCount;
}

export function getGifCompressionColorCandidates(maxColorCount: number): GifColorCount[] {
  const safeMax = Number.isFinite(maxColorCount) ? Math.round(maxColorCount) : 256;
  return [...GIF_COLOR_COUNTS].reverse().filter((value) => value <= safeMax);
}

export function clampFrameDuration(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_FRAME_DURATION_MS, Math.max(10, Math.floor(value / 10) * 10)) : 100;
}

export function clampGifFps(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(1, Math.round(value * 100) / 100)) : 10;
}

export function durationFromGifFps(value: number): number {
  return clampFrameDuration(1000 / clampGifFps(value));
}

export function fpsFromFrameDuration(value: number): number {
  return Math.round((1000 / clampFrameDuration(value)) * 100) / 100;
}

export function clampGifPlaybackSpeed(value: number): GifPlaybackSpeed {
  if (!Number.isFinite(value)) return 1;
  return GIF_PLAYBACK_SPEEDS.reduce((closest, speed) => Math.abs(speed - value) < Math.abs(closest - value) ? speed : closest, 1 as GifPlaybackSpeed);
}

// 预览速度只换算显示时序，避免把播放倍率写入导出帧时长。
export function previewFrameDurationAtSpeed(frameDuration: number, speed: number): number {
  return clampFrameDuration(clampFrameDuration(frameDuration) / clampGifPlaybackSpeed(speed));
}

export function calculateBoundaryFrameDuration(frameDuration: number, holdDuration: number): number {
  const safeHold = Number.isFinite(holdDuration) ? Math.max(0, holdDuration) : 0;
  return clampFrameDuration(clampFrameDuration(frameDuration) + safeHold);
}

export function clampGifHoldDuration(value: number): number {
  return Number.isFinite(value) ? Math.min(60_000, Math.max(0, Math.floor(value))) : 0;
}

export function resolveGifCanvasSize(source: GifCanvasSize, width: number, height: number, keepRatio: boolean): GifCanvasSize {
  const safe = (value: number) => Number.isFinite(value) ? Math.min(4096, Math.max(1, Math.round(value))) : 1;
  let w = safe(width);
  let h = safe(height);
  if (keepRatio && source.width > 0 && source.height > 0) {
    h = w * source.height / source.width;
    if (h > 4096) { w *= 4096 / h; h = 4096; }
  }
  return { width: safe(w), height: safe(h) };
}

export function resolveGifContentRect(
  canvas: GifCanvasSize,
  source: GifCanvasSize,
  fit: GifContentFit,
  alignment: GifContentAlignment,
  margins: GifContentMargins,
): GifContentRect {
  const canvasWidth = Math.max(1, Math.round(canvas.width));
  const canvasHeight = Math.max(1, Math.round(canvas.height));
  const left = Math.min(canvasWidth - 1, Math.max(0, Math.round(margins.left)));
  const right = Math.min(canvasWidth - left - 1, Math.max(0, Math.round(margins.right)));
  const top = Math.min(canvasHeight - 1, Math.max(0, Math.round(margins.top)));
  const bottom = Math.min(canvasHeight - top - 1, Math.max(0, Math.round(margins.bottom)));
  const area = { x: left, y: top, width: canvasWidth - left - right, height: canvasHeight - top - bottom };
  if (fit === "stretch" || source.width <= 0 || source.height <= 0) return area;

  const scale = fit === "cover"
    ? Math.max(area.width / source.width, area.height / source.height)
    : Math.min(area.width / source.width, area.height / source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const x = area.x + Math.round((area.width - width) / 2);
  const y = alignment === "top"
    ? area.y
    : alignment === "bottom"
      ? area.y + area.height - height
      : area.y + Math.round((area.height - height) / 2);
  return { x, y, width, height };
}

export function resolveGifCanvasPreset(source: GifCanvasSize, preset: Exclude<GifCanvasPreset, "custom">): GifCanvasSize {
  const scale = preset === "source" ? 1 : preset === "75" ? 0.75 : 0.5;
  return resolveGifCanvasSize(source, source.width * scale, source.height * scale, false);
}

export function estimateGifWorkload(size: GifCanvasSize, frameCount: number, colorCount: number): GifWorkloadEstimate {
  const totalPixels = Math.max(0, Math.round(size.width) * Math.round(size.height) * Math.max(0, Math.round(frameCount)));
  const safeColorCount = Math.min(256, Math.max(2, Math.round(colorCount)));
  const decodedBytes = totalPixels * 4;
  const paletteBytes = Math.max(0, Math.round(frameCount)) * safeColorCount * 3;
  const level = totalPixels > 24_000_000 || decodedBytes > 96 * 1024 * 1024 ? "heavy" : totalPixels > 8_000_000 ? "moderate" : "light";
  return { totalPixels, decodedBytes, paletteBytes, level };
}

export function formatGifBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function compareGifSizes(comparison: GifSizeComparison): GifSizeComparisonSummary {
  const baselineBytes = Number.isFinite(comparison.baselineBytes) ? Math.max(0, comparison.baselineBytes) : 0;
  const finalBytes = Number.isFinite(comparison.finalBytes) ? Math.max(0, comparison.finalBytes) : 0;
  const ratioPercent = baselineBytes > 0 ? finalBytes / baselineBytes * 100 : 0;
  return {
    ratioPercent,
    changePercent: Math.abs(100 - ratioPercent),
    reduced: finalBytes <= baselineBytes,
    meetsTarget: comparison.targetBytes === undefined ? null : finalBytes <= comparison.targetBytes,
    withinMax: comparison.maxBytes === undefined ? null : finalBytes <= comparison.maxBytes,
  };
}

function hasSameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function mergeConsecutiveIdenticalFrames(frames: ReadonlyArray<GifByteFrame>): GifByteFrame[] {
  if (!Array.isArray(frames) || !frames.length) return [];
  const merged: GifByteFrame[] = [];
  let group: GifByteFrame | null = null;
  let groupDuration = 0;
  let groupFrameCount = 0;
  const flush = () => {
    if (!group) return;
    if (groupFrameCount === 1 && groupDuration === group.durationMs) {
      merged.push(group);
      group = null;
      groupDuration = 0;
      groupFrameCount = 0;
      return;
    }
    let remaining = groupDuration;
    while (remaining > 0) {
      const durationMs = Math.min(MAX_FRAME_DURATION_MS, remaining);
      merged.push({ ...group, durationMs });
      remaining -= durationMs;
    }
    group = null;
    groupDuration = 0;
    groupFrameCount = 0;
  };
  for (const frame of frames) {
    if (!frame || !(frame.data instanceof Uint8Array) || !frame.data.byteLength) continue;
    const durationMs = clampFrameDuration(frame.durationMs);
    if (!group || !hasSameBytes(group.data, frame.data)) {
      flush();
      group = frame;
    }
    groupDuration += durationMs;
    groupFrameCount += 1;
  }
  flush();
  return merged;
}

export function getGifSamplingCandidates(frameCount: number, maxFrames = MAX_FRAMES): number[] {
  const count = Number.isFinite(frameCount) ? Math.max(0, Math.floor(frameCount)) : 0;
  if (count <= 1) return [1];
  const safeMaxFrames = Math.max(2, Math.floor(maxFrames));
  const minimumStep = Math.max(1, Math.ceil((count - 1) / (safeMaxFrames - 1)));
  return [1, 2, 4, minimumStep]
    .map((step) => Math.max(minimumStep, step))
    .filter((step, index, candidates) => candidates.indexOf(step) === index && step < count);
}

export function sampleGifFrames<T extends GifByteFrame>(frames: ReadonlyArray<T>, everyNthFrame: number, maxFrames = MAX_FRAMES): T[] {
  if (!frames.length) return [];
  const indices = getGifSampleIndices(frames.length, everyNthFrame, maxFrames);
  return indices.flatMap((index, position) => {
    const end = position + 1 < indices.length ? indices[position + 1] : frames.length;
    const durationMs = frames.slice(index, end).reduce((total, frame) => total + frame.durationMs, 0);
    if (durationMs <= MAX_FRAME_DURATION_MS) return [{ ...frames[index], durationMs }];
    const chunks: T[] = [];
    let remaining = durationMs;
    while (remaining > MAX_FRAME_DURATION_MS) {
      chunks.push({ ...frames[index], durationMs: MAX_FRAME_DURATION_MS });
      remaining -= MAX_FRAME_DURATION_MS;
    }
    chunks.push({ ...frames[index], durationMs: remaining });
    return chunks;
  });
}

function getGifSampleIndices(frameCount: number, everyNthFrame: number, maxFrames: number): number[] {
  const count = Math.max(0, Math.floor(frameCount));
  if (!count) return [];
  if (count === 1) return [0];
  const safeMaxFrames = Math.max(2, Math.floor(maxFrames));
  const requestedStep = Number.isFinite(everyNthFrame) ? Math.max(1, Math.floor(everyNthFrame)) : 1;
  const step = Math.max(requestedStep, Math.ceil((count - 1) / (safeMaxFrames - 1)));
  const indices = [0];
  for (let index = step; index < count - 1; index += step) indices.push(index);
  indices.push(count - 1);
  return indices;
}

export function getGifFrameOrder(length: number, index: number, direction: -1 | 1): number {
  return length ? Math.min(length - 1, Math.max(0, index + direction)) : -1;
}

export function validateGifFiles(files: ReadonlyArray<{ size: number }>): void {
  if (files.length > MAX_FRAMES) throw new Error("最多导入 200 帧，请减少素材数量。");
  if (files.some((file) => file.size <= 0 || file.size > MAX_FRAME_BYTES)) throw new Error("单帧图片不能为空且不能超过 32 MiB。");
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) throw new Error("所有素材总大小不能超过 128 MiB。");
}

export function validateGifPixels(size: GifCanvasSize, count: number): void {
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1 || size.width > 4096 || size.height > 4096) throw new Error("图片和画布尺寸必须在 1–4096 px 之间。");
  if (size.width * size.height * count > MAX_TOTAL_PIXELS) throw new Error("累计画布像素超过 64 Mi，请减少帧数或缩小尺寸。");
}

export function advanceGifPlayback(index: number, count: number, repeats: number, mode: "infinite" | "finite", repeatCount: number) {
  if (index < count - 1) return { index: index + 1, repeats, stopped: false };
  if (mode === "finite" && repeats >= repeatCount) return { index, repeats, stopped: true };
  return { index: 0, repeats: repeats + 1, stopped: false };
}

// 串行处理保留连续追加的顺序，版本失效让清空和卸载取消未完成批次。
export class GifImportQueue {
  private version = 0;
  private tail: Promise<unknown> = Promise.resolve();
  cancel() { this.version += 1; }
  run<T>(work: (isCurrent: () => boolean) => Promise<T>): Promise<T | null> {
    const version = this.version;
    const isCurrent = () => version === this.version;
    const result = this.tail.then(() => isCurrent() ? work(isCurrent) : null);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export async function readGifBatch<T, F>(files: F[], read: (file: F) => Promise<T>, release: (frame: T) => void, isCurrent: () => boolean): Promise<T[]> {
  const loaded: T[] = [];
  try {
    for (const file of files) {
      if (!isCurrent()) break;
      loaded.push(await read(file));
    }
    if (isCurrent()) return loaded;
  } catch (error) {
    loaded.forEach(release);
    throw error;
  }
  loaded.forEach(release);
  return [];
}
