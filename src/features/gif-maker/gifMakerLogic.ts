export interface GifCanvasSize { width: number; height: number }
export const MAX_FRAMES = 200;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const MAX_TOTAL_PIXELS = 64 * 1024 * 1024;

export function clampFrameDuration(value: number): number {
  return Number.isFinite(value) ? Math.min(60_000, Math.max(10, Math.floor(value / 10) * 10)) : 100;
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
