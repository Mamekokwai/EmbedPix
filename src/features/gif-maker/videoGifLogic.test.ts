import { describe, expect, it } from "vitest";
import { clampVideoFps, clampVideoRange, formatVideoTime, isVideoCropRectWithinBounds, MAX_VIDEO_FRAME_DURATION_MS, normalizeVideoCropRect, planVideoFrames, planVideoFramesWithSampling } from "./videoGifLogic";

describe("video GIF planning", () => {
  it("normalizes custom crops in pre-rotation source coordinates", () => {
    const crop = normalizeVideoCropRect({ x: 120, y: 80, width: 640, height: 360 }, 1920, 1080);
    expect(crop).toEqual({ x: 120, y: 80, width: 640, height: 360 });
    expect(isVideoCropRectWithinBounds(crop, 1920, 1080)).toBe(true);
  });

  it("clamps custom crops to the source bounds and keeps output dimensions positive", () => {
    expect(normalizeVideoCropRect({ x: -20, y: 2000, width: 5000, height: 0 }, 640, 480)).toEqual({
      x: 0,
      y: 479,
      width: 640,
      height: 1,
    });
    expect(normalizeVideoCropRect({ x: Number.NaN, y: Number.POSITIVE_INFINITY, width: Number.NaN, height: Number.NaN }, 0, -1)).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it("rejects non-finite, zero-sized, and out-of-bounds crop rectangles", () => {
    expect(isVideoCropRectWithinBounds({ x: 0, y: 0, width: 0, height: 10 }, 640, 480)).toBe(false);
    expect(isVideoCropRectWithinBounds({ x: 630, y: 0, width: 20, height: 10 }, 640, 480)).toBe(false);
    expect(isVideoCropRectWithinBounds({ x: Number.NaN, y: 0, width: 10, height: 10 }, 640, 480)).toBe(false);
    expect(isVideoCropRectWithinBounds({ x: 0, y: 0, width: 10, height: 10 }, 0, 480)).toBe(false);
  });

  it("clamps FPS and ranges to safe values", () => {
    expect(clampVideoFps(0)).toBe(1);
    expect(clampVideoFps(60)).toBe(30);
    expect(clampVideoRange(-2, 10)).toBe(0);
    expect(clampVideoRange(20, 10)).toBe(10);
  });

  it("creates a bounded frame plan with GIF-compatible timing", () => {
    const plan = planVideoFrames(1, 2, 4, 20);
    expect(plan.times).toHaveLength(20);
    expect(plan.times[0]).toBe(1);
    expect(plan.times[plan.times.length - 1]).toBeCloseTo(1.95);
    expect(plan.durationMs).toBe(50);
    expect(planVideoFrames(0, 100, 100, 30).times).toHaveLength(200);
  });

  it("preserves sampled playback timing when taking every Nth frame", () => {
    const plan = planVideoFramesWithSampling(0, 2, 4, 10, { everyNthFrame: 2 });
    expect(plan.times).toHaveLength(10);
    expect(plan.times.slice(0, 3)).toEqual([0, 0.2, 0.4]);
    expect(plan.durationMs).toBe(200);
  });

  it("caps sampled frames and clamps unsafe sampling options", () => {
    const capped = planVideoFramesWithSampling(0, 10, 10, 30, { maxFrames: 7 });
    expect(capped.times).toHaveLength(7);
    expect(capped.times[0]).toBe(0);
    expect(capped.times[capped.times.length - 1]).toBeCloseTo(10 - 10 / 7);
    expect(capped.durationMs).toBe(1420);
    expect(planVideoFramesWithSampling(0, 10, 10, 30, { maxFrames: 999 }).times).toHaveLength(200);
    expect(planVideoFramesWithSampling(0, 1, 10, 10, { everyNthFrame: 0, maxFrames: 0 }).times).toHaveLength(1);
  });

  it("falls back safely for non-finite video inputs and uses GIF timing precision", () => {
    const plan = planVideoFramesWithSampling(Number.NaN, Number.NaN, Number.NaN, Number.NaN, {
      everyNthFrame: Number.NaN,
      maxFrames: Number.NaN,
    });
    expect(plan.times).toEqual([0]);
    expect(plan.durationMs).toBe(100);
    expect(planVideoFramesWithSampling(0, 1, 1, 26).durationMs).toBe(30);
    expect(planVideoFramesWithSampling(0, 100_000, 100_000, 1, { maxFrames: 1 }).durationMs).toBe(MAX_VIDEO_FRAME_DURATION_MS);
  });

  it("keeps the original planner behavior when sampling is omitted", () => {
    expect(planVideoFrames(1, 2, 4, 20)).toEqual(planVideoFramesWithSampling(1, 2, 4, 20));
  });

  it("formats timeline labels for the video controls", () => {
    expect(formatVideoTime(0)).toBe("0:00");
    expect(formatVideoTime(65.4)).toBe("1:05");
  });
});
