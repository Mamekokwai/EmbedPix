import { describe, expect, it } from "vitest";
import { DEFAULT_GIF_SETTINGS_GROUP, GIF_PRESETS } from "./GifMakerView";

describe("GIF export presets", () => {
  it("defines quality, balanced, and small presets without touching other formats", () => {
    expect(GIF_PRESETS).toEqual({
      high: { label: "高质量", encodingQuality: "high", colorCount: 256, ditherMode: "none", canvasPreset: "source" },
      balanced: { label: "平衡", encodingQuality: "balanced", colorCount: 128, ditherMode: "floydSteinberg", canvasPreset: "75" },
      small: { label: "小体积", encodingQuality: "fast", colorCount: 64, ditherMode: "none", canvasPreset: "50" },
    });
  });
});

describe("GIF settings layout defaults", () => {
  it("starts with the parameter groups folded so the workspace keeps its preview height", () => {
    expect(DEFAULT_GIF_SETTINGS_GROUP).toBeNull();
  });
});
