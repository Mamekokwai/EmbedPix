import { describe, expect, it } from "vitest";
import { DEFAULT_GIF_SETTINGS_GROUP, getGifOutputLocationError, getGifSourcePath, getPngSequenceOutputLocationFields, GIF_PRESETS } from "./GifMakerView";

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

  it("only exposes a source folder when every frame has a native source path", () => {
    expect(getGifSourcePath([{ sourcePath: "E:\\素材\\a.png" }, { sourcePath: "E:\\素材\\b.png" }])).toBe("E:\\素材\\a.png");
    expect(getGifSourcePath([{ sourcePath: "E:\\素材\\a.png" }, { sourcePath: null }])).toBeNull();
  });

  it("validates source and custom output modes without constructing paths", () => {
    expect(getGifOutputLocationError("source", null, "", "", true)).toContain("源文件路径");
    expect(getGifOutputLocationError("subfolder", "E:\\素材\\a.png", "..", "", true)).toContain("不能是");
    expect(getGifOutputLocationError("directory", null, "", "", true)).toContain("输出目录");
    expect(getGifOutputLocationError("path", null, "", "", true)).toBeNull();
  });

  it.each([
    ["path", { outputDir: "E:\\导出", outputLocation: "path" }],
    ["source", { outputLocation: "source", sourcePath: "E:\\素材\\a.png" }],
    ["subfolder", { outputLocation: "subfolder", sourcePath: "E:\\素材\\a.png", outputSubdirectory: "导出" }],
    ["directory", { outputLocation: "directory", outputDirectory: "E:\\导出" }],
  ] as const)("maps PNG sequence %s output fields without deriving paths", (location, expected) => {
    expect(getPngSequenceOutputLocationFields(
      location,
      "E:\\导出",
      "E:\\素材\\a.png",
      " 导出 ",
      " E:\\导出 ",
    )).toEqual({
      outputDir: undefined,
      sourcePath: undefined,
      outputSubdirectory: undefined,
      outputDirectory: undefined,
      ...expected,
    });
  });
});
