import { describe, expect, it } from "vitest";
import { advanceGifPlayback, clampFrameDuration, getGifFrameOrder, GifImportQueue, MAX_FRAME_BYTES, MAX_TOTAL_BYTES, readGifBatch, resolveGifCanvasPreset, resolveGifCanvasSize, validateGifFiles, validateGifPixels } from "./gifMakerLogic";

describe("GIF maker logic", () => {
  it("clamps frame durations to a safe animation range", () => {
    expect(clampFrameDuration(0)).toBe(10);
    expect(clampFrameDuration(123.6)).toBe(120);
    expect(clampFrameDuration(Number.NaN)).toBe(100);
    expect(clampFrameDuration(60_001)).toBe(60_000);
    expect(clampFrameDuration(19)).toBe(10);
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
