import { describe, expect, it } from "vitest";
import { clampVideoFps, clampVideoRange, formatVideoTime, planVideoFrames } from "./videoGifLogic";

describe("video GIF planning", () => {
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

  it("formats timeline labels for the video controls", () => {
    expect(formatVideoTime(0)).toBe("0:00");
    expect(formatVideoTime(65.4)).toBe("1:05");
  });
});
