import { describe, expect, it } from "vitest";
import { advanceGifPlayback, calculateBoundaryFrameDuration, clampFrameDuration, clampGifFps, clampGifPlaybackSpeed, durationFromGifFps, estimateGifWorkload, formatGifBytes, fpsFromFrameDuration, getGifCompressionColorCandidates, getGifFrameOrder, getGifSamplingCandidates, GifImportQueue, MAX_FRAME_BYTES, MAX_TOTAL_BYTES, mergeConsecutiveIdenticalFrames, previewFrameDurationAtSpeed, readGifBatch, resolveGifCanvasPreset, resolveGifCanvasSize, resolveGifContentRect, sampleGifFrames, validateGifFiles, validateGifPixels } from "./gifMakerLogic";

describe("GIF maker logic", () => {
  it("estimates export workload without pretending to know compressed file size", () => {
    expect(estimateGifWorkload({ width: 320, height: 240 }, 10, 256)).toEqual({
      totalPixels: 768000,
      decodedBytes: 3072000,
      paletteBytes: 7680,
      level: "light",
    });
    expect(estimateGifWorkload({ width: 1920, height: 1080 }, 20, 64).level).toBe("heavy");
    expect(formatGifBytes(3072000)).toBe("2.9 MiB");
    expect(estimateGifWorkload({ width: 64, height: 64 }, 1, 2).paletteBytes).toBe(2 * 3);
    expect(estimateGifWorkload({ width: 64, height: 64 }, 1, 1).paletteBytes).toBe(2 * 3);
    expect(estimateGifWorkload({ width: 64, height: 64 }, 1, 257).paletteBytes).toBe(256 * 3);
  });

  it("keeps compression candidates at or below the selected color count", () => {
    expect(getGifCompressionColorCandidates(256)).toEqual([256, 128, 64, 32, 16, 2]);
    expect(getGifCompressionColorCandidates(32)).toEqual([32, 16, 2]);
    expect(getGifCompressionColorCandidates(2)).toEqual([2]);
  });

  it("clamps frame durations to a safe animation range", () => {
    expect(clampFrameDuration(0)).toBe(10);
    expect(clampFrameDuration(123.6)).toBe(120);
    expect(clampFrameDuration(Number.NaN)).toBe(100);
    expect(clampFrameDuration(60_001)).toBe(60_000);
    expect(clampFrameDuration(19)).toBe(10);
  });

  it("converts animation FPS and frame duration safely", () => {
    expect(clampGifFps(0)).toBe(1);
    expect(clampGifFps(120.456)).toBe(100);
    expect(durationFromGifFps(20)).toBe(50);
    expect(durationFromGifFps(29.97)).toBe(30);
    expect(fpsFromFrameDuration(50)).toBe(20);
  });

  it("converts preview timing for supported playback speeds without changing export timing", () => {
    expect(clampGifPlaybackSpeed(0.25)).toBe(0.25);
    expect(clampGifPlaybackSpeed(1.3)).toBe(1);
    expect(clampGifPlaybackSpeed(Number.NaN)).toBe(1);
    expect(previewFrameDurationAtSpeed(100, 0.25)).toBe(400);
    expect(previewFrameDurationAtSpeed(100, 0.5)).toBe(200);
    expect(previewFrameDurationAtSpeed(100, 1)).toBe(100);
    expect(previewFrameDurationAtSpeed(100, 2)).toBe(50);
    expect(clampFrameDuration(100)).toBe(100);
  });

  it("merges only consecutive identical PNG byte frames and preserves duration", () => {
    const first = { data: new Uint8Array([1, 2]), durationMs: 100 };
    const same = { data: new Uint8Array([1, 2]), durationMs: 250 };
    const different = { data: new Uint8Array([1, 3]), durationMs: 80 };
    const merged = mergeConsecutiveIdenticalFrames([first, same, different, first]);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toEqual({ data: first.data, durationMs: 350 });
    expect(merged[1]).toEqual(different);
    expect(merged[2]).toBe(first);
  });

  it("returns an empty list for empty frame input", () => {
    expect(mergeConsecutiveIdenticalFrames([])).toEqual([]);
  });

  it("samples frames while preserving the first and last frame timing", () => {
    const frames = [100, 200, 300, 400, 500].map((durationMs, index) => ({ data: new Uint8Array([index]), durationMs }));
    expect(getGifSamplingCandidates(5)).toEqual([1, 2, 4]);
    expect(sampleGifFrames(frames, 2)).toEqual([
      { data: new Uint8Array([0]), durationMs: 300 },
      { data: new Uint8Array([2]), durationMs: 700 },
      { data: new Uint8Array([4]), durationMs: 500 },
    ]);
    expect(sampleGifFrames(frames, 99)).toHaveLength(2);
    expect(sampleGifFrames(frames, 2).reduce((total, frame) => total + frame.durationMs, 0)).toBe(1500);
  });

  it("bounds sampled output to the requested maximum frame count", () => {
    const frames = Array.from({ length: 201 }, (_, index) => ({ data: new Uint8Array([index % 256]), durationMs: 100 }));
    const sampled = sampleGifFrames(frames, 1, 200);
    expect(sampled.length).toBeLessThanOrEqual(200);
    expect(sampled[0].data[0]).toBe(frames[0].data[0]);
    expect(sampled[sampled.length - 1]?.data[0]).toBe(frames[frames.length - 1]?.data[0]);
    expect(sampled.reduce((total, frame) => total + frame.durationMs, 0)).toBe(20100);
  });

  it("calculates safe first and last frame hold durations", () => {
    expect(calculateBoundaryFrameDuration(100, 250)).toBe(350);
    expect(calculateBoundaryFrameDuration(100, -20)).toBe(100);
    expect(calculateBoundaryFrameDuration(59_950, 500)).toBe(60_000);
    expect(calculateBoundaryFrameDuration(Number.NaN, Number.POSITIVE_INFINITY)).toBe(100);
  });

  it("keeps the source ratio when requested", () => {
    expect(resolveGifCanvasSize({ width: 1920, height: 1080 }, 320, 240, true)).toEqual({ width: 320, height: 180 });
    expect(resolveGifCanvasSize({ width: 1920, height: 1080 }, 320, 240, false)).toEqual({ width: 320, height: 240 });
  });

  it("resolves common output size presets from the source canvas", () => {
    const source = { width: 1920, height: 1080 };
    expect(resolveGifCanvasPreset(source, "source")).toEqual(source);
    expect(resolveGifCanvasPreset(source, "75")).toEqual({ width: 1440, height: 810 });
    expect(resolveGifCanvasPreset(source, "50")).toEqual({ width: 960, height: 540 });
  });

  it("computes contain, cover alignment, and custom margin rectangles consistently", () => {
    const canvas = { width: 400, height: 300 };
    const source = { width: 200, height: 100 };
    const margins = { top: 10, right: 20, bottom: 30, left: 40 };
    expect(resolveGifContentRect(canvas, source, "contain", "center", margins)).toEqual({
      x: 40, y: 55, width: 340, height: 170,
    });
    expect(resolveGifContentRect(canvas, source, "stretch", "bottom", margins)).toEqual({
      x: 40, y: 10, width: 340, height: 260,
    });
    expect(resolveGifContentRect({ width: 300, height: 300 }, { width: 100, height: 200 }, "cover", "top", { top: 0, right: 0, bottom: 0, left: 0 })).toEqual({
      x: 0, y: 0, width: 300, height: 600,
    });
    expect(resolveGifContentRect({ width: 300, height: 300 }, { width: 100, height: 200 }, "cover", "bottom", { top: 0, right: 0, bottom: 0, left: 0 })).toEqual({
      x: 0, y: -300, width: 300, height: 600,
    });
    expect(resolveGifContentRect(canvas, source, "contain", "center", { top: 9999, right: 9999, bottom: 9999, left: 9999 })).toEqual({
      x: 399, y: 299, width: 1, height: 1,
    });
  });

  it("prevents frame movement beyond the list edges", () => {
    expect(getGifFrameOrder(3, 0, -1)).toBe(0);
    expect(getGifFrameOrder(3, 1, 1)).toBe(2);
    expect(getGifFrameOrder(3, 2, 1)).toBe(2);
    expect(getGifFrameOrder(0, 0, 1)).toBe(-1);
  });

  it("counts finite loopCount as additional repeats", () => {
    expect(advanceGifPlayback(0, 2, 0, "finite", 2)).toEqual({ index: 1, repeats: 0, stopped: false });
    expect(advanceGifPlayback(1, 2, 0, "finite", 2)).toEqual({ index: 0, repeats: 1, stopped: false });
    expect(advanceGifPlayback(1, 2, 1, "finite", 2)).toEqual({ index: 0, repeats: 2, stopped: false });
    expect(advanceGifPlayback(1, 2, 2, "finite", 2)).toEqual({ index: 1, repeats: 2, stopped: true });
  });

  it("rejects oversized imports and cumulative pixels", () => {
    expect(() => validateGifFiles([{ size: MAX_FRAME_BYTES + 1 }])).toThrow("32 MiB");
    expect(() => validateGifFiles(Array.from({ length: 5 }, () => ({ size: Math.floor(MAX_TOTAL_BYTES / 5) + 1 })))).toThrow("128 MiB");
    expect(() => validateGifFiles(Array.from({ length: 201 }, () => ({ size: 1 })))).toThrow("200 帧");
    expect(() => validateGifPixels({ width: 4096, height: 4096 }, 5)).toThrow("64 Mi");
  });

  it("cancels an import batch and releases already loaded frames", async () => {
    const released: number[] = [];
    let current = true;
    const result = await readGifBatch([1, 2], async (value) => {
      if (value === 1) current = false;
      return value;
    }, (value) => released.push(value), () => current);
    expect(result).toEqual([]);
    expect(released).toEqual([1]);
  });

  it("serializes queued imports and invalidates cancelled work", async () => {
    const queue = new GifImportQueue();
    const order: string[] = [];
    const first = queue.run(async (isCurrent) => {
      order.push("first");
      expect(isCurrent()).toBe(true);
      return "done";
    });
    queue.cancel();
    const second = queue.run(async () => {
      order.push("second");
      return "done";
    });
    expect(await first).toBeNull();
    expect(await second).toBe("done");
    expect(order).toEqual(["second"]);
  });
});
