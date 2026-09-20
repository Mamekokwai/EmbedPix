import { describe, expect, it } from "vitest";
import { canRequestGifExportCancel, createGifExportJobId, DEFAULT_GIF_SETTINGS_GROUP, formatGifCancelledStatus, formatGifExportProgress, getGifCancelButtonLabel, getGifOutputLocationError, getGifSourcePath, getPngSequenceOutputLocationFields, GIF_ERROR_DETAILS_THRESHOLD, GIF_PRESETS, isCompletedGifExport, selectAnimationCompressionResult, shouldOfferGifErrorDetails } from "./GifMakerView";

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

  it("selects the closest animation candidate while respecting the maximum", () => {
    const candidates = [{ bytes: 1_000, id: "original" }, { bytes: 760, id: "75%" }, { bytes: 620, id: "merged" }, { bytes: 420, id: "50%" }];
    expect(selectAnimationCompressionResult(candidates, 700, 800)?.id).toBe("merged");
    expect(selectAnimationCompressionResult(candidates, 500, 800)?.id).toBe("50%");
    expect(selectAnimationCompressionResult(candidates, 700, 400)).toBeNull();
  });
});

describe("GIF error details", () => {
  it("only offers expansion when an error can be clipped", () => {
    expect(shouldOfferGifErrorDetails("操作失败，请重试。".repeat(2))).toBe(false);
    expect(shouldOfferGifErrorDetails("错误：" + "无法完成导出。".repeat(12))).toBe(true);
    expect(shouldOfferGifErrorDetails("x".repeat(GIF_ERROR_DETAILS_THRESHOLD))).toBe(false);
    expect(shouldOfferGifErrorDetails("x".repeat(GIF_ERROR_DETAILS_THRESHOLD + 1))).toBe(true);
  });
});

describe("GIF export jobs", () => {
  it("creates distinct job IDs and only accepts completed progress", () => {
    expect(createGifExportJobId()).not.toBe(createGifExportJobId());
    expect(isCompletedGifExport({ status: "completed", stage: "completed" })).toBe(true);
    expect(isCompletedGifExport({ status: "failed", stage: "failed" })).toBe(false);
    expect(isCompletedGifExport({ status: "cancelled", stage: "cancelled" })).toBe(false);
  });

  it("surfaces native GIF stages and frame progress", () => {
    expect(formatGifExportProgress({ format: "gif", stage: "validating", completedFrames: 0, totalFrames: 4 })).toContain("GIF 导出 · validating · 0/4 帧");
    expect(formatGifExportProgress({ format: "webp", stage: "encoding", completedFrames: 2, totalFrames: 4 })).toContain("WEBP 导出 · encoding · 2/4 帧");
    expect(formatGifExportProgress({ format: "png-sequence", stage: "publishing", completedFrames: 4, totalFrames: 4 })).toContain("PNG 帧序列导出 · publishing · 4/4 帧");
  });

  it("protects cancelling jobs from duplicate requests and uses explicit cancel copy", () => {
    expect(canRequestGifExportCancel("job-1", null, "running")).toBe(true);
    expect(canRequestGifExportCancel("job-1", "job-1", "running")).toBe(false);
    expect(canRequestGifExportCancel("job-1", null, "cancelling")).toBe(false);
    expect(getGifCancelButtonLabel(true, false)).toBe("取消导出");
    expect(getGifCancelButtonLabel(true, true)).toBe("正在取消导出…");
    expect(formatGifCancelledStatus("png-sequence")).toBe("PNG 帧序列导出已取消");
  });
});
