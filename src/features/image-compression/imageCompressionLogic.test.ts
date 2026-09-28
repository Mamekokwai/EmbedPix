import { describe, expect, it } from "vitest";
import { COMPRESSION_PRESETS, canReplaceCompressionOriginal, estimateFallback, filterCompressionFiles, formatCompressionFailureDetails, formatCompressionItemResultStatus, formatCompressionReplaceOriginalConfirmation, getCompressionOutputLocationError, getCompressionPreset, getCompressionSubdirectoryError, getSuccessfulCompressionOutputPath, supportsCompressionTargetSize } from "./imageCompressionLogic";

describe("image compression logic", () => {
  it("estimates savings deterministically", () => {
    const file = new File([new Uint8Array(1000)], "a.png", { type: "image/png" });
    expect(estimateFallback([{ id: "a", file, size: 1000 }], { format: "webp", quality: 80, lossless: false, pngOptimizationLevel: 2, metadataPolicy: "strip", outputLocation: "source", overwrite: false }).estimatedBytes).toBeLessThan(1000);
  });

  it("filters unsupported files", () => {
    expect(filterCompressionFiles([new File([], "a.png", { type: "image/png" }), new File([], "a.txt", { type: "text/plain" })])).toHaveLength(1);
  });

  it("keeps preset quality semantics format-specific", () => {
    expect(COMPRESSION_PRESETS).toHaveLength(3);
    expect(getCompressionPreset("high-quality")).toMatchObject({ quality: 92, pngOptimizationLevel: 2 });
    expect(getCompressionPreset("small-size")).toMatchObject({ quality: 70, pngOptimizationLevel: 6 });
    expect(getCompressionPreset("balanced").description).toContain("JPEG/WebP 有损质量 82");
    expect(getCompressionPreset("balanced").description).toContain("WebP 默认无损");
  });

  it("enables target-size control only for lossy JPEG and WebP", () => {
    expect(supportsCompressionTargetSize("jpg", true)).toBe(true);
    expect(supportsCompressionTargetSize("webp", false)).toBe(true);
    expect(supportsCompressionTargetSize("webp", true)).toBe(false);
    expect(supportsCompressionTargetSize("png", true)).toBe(false);
  });

  it("keeps only completed output paths as successful results", () => {
    expect(getSuccessfulCompressionOutputPath("completed", " C:/out/icon.webp ")).toBe("C:/out/icon.webp");
    expect(getSuccessfulCompressionOutputPath("skipped", "C:/out/icon.webp")).toBeNull();
    expect(getSuccessfulCompressionOutputPath("completed", "  ")).toBeNull();
  });

  it("formats failure details without losing file names or messages", () => {
    expect(formatCompressionFailureDetails([
      { fileName: "a.png", message: "读取失败" },
      { fileName: "b.webp", message: "目标不可达" },
    ])).toBe("a.png：读取失败\nb.webp：目标不可达");
  });

  it("only enables source replacement for complete desktop source queues", () => {
    expect(canReplaceCompressionOriginal([{ sourcePath: "C:/images/a.png" }], true)).toBe(true);
    expect(canReplaceCompressionOriginal([{ sourcePath: "C:/images/a.png" }, { sourcePath: undefined }], true)).toBe(false);
    expect(canReplaceCompressionOriginal([{ sourcePath: "C:/images/a.png" }], false)).toBe(false);
    expect(formatCompressionReplaceOriginalConfirmation(["C:/images/a.png"])).toContain("bak");
    expect(formatCompressionReplaceOriginalConfirmation(["C:/images/a.png"])).toContain("取消确认不会开始压缩");
  });

  it("labels each batch result state without implying an output for skips", () => {
    expect(formatCompressionItemResultStatus("completed")).toBe("已完成");
    expect(formatCompressionItemResultStatus("skipped")).toBe("已跳过");
    expect(formatCompressionItemResultStatus("failed")).toBe("失败");
  });

  it("validates safe source subdirectory names", () => {
    expect(getCompressionSubdirectoryError("compressed")).toBeNull();
    expect(getCompressionSubdirectoryError("../escape")).toContain("不安全");
    expect(getCompressionSubdirectoryError("CON")).toContain("保留名称");
  });

  it("requires the matching path fields for each output location", () => {
    expect(getCompressionOutputLocationError("source", "", "", false)).toContain("源文件路径");
    expect(getCompressionOutputLocationError("subfolder", "compressed", "", true)).toBeNull();
    expect(getCompressionOutputLocationError("directory", "", "", true)).toContain("输出目录");
  });
});
