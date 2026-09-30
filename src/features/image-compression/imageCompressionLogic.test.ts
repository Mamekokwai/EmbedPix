import { describe, expect, it, vi } from "vitest";
import { COMPRESSION_MAX_INPUT_BYTES, COMPRESSION_PRESETS, COMPRESSION_WEBP_METHOD_DEFAULT, COMPRESSION_WEBP_METHOD_MAX, COMPRESSION_WEBP_METHOD_MIN, canDeleteCompressionSource, canReplaceCompressionOriginal, estimateFallback, filterCompressionFiles, formatCompressionDeleteSourceConfirmation, formatCompressionEstimateSource, formatCompressionFailureDetails, formatCompressionItemResultStatus, formatCompressionReplaceOriginalConfirmation, getCompressionBatchFinalState, getCompressionCancelledItemResults, getCompressionItemResultMetrics, getCompressionOutputFileNameError, getCompressionOutputLocationError, getCompressionPreset, getCompressionRetryQueue, getCompressionSourcePathError, getCompressionSubdirectoryError, getCompressionTargetSizeError, getSuccessfulCompressionOutputPath, isCompressionSourcePathError, isCurrentCompressionEstimate, mergeCompressionItems, normalizeCompressionOutputFileName, normalizeCompressionOutputModes, removeCompressionItem, splitCompressionImportFiles, supportsCompressionTargetSize, waitForCompressionProgressTick } from "./imageCompressionLogic";
import type { CompressionItem } from "./types";

describe("image compression logic", () => {
  it("cancels a progress polling tick immediately", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const tick = waitForCompressionProgressTick(controller.signal, 160);
    controller.abort();
    await expect(tick).resolves.toBeUndefined();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("estimates savings deterministically", () => {
    const file = new File([new Uint8Array(1000)], "a.png", { type: "image/png" });
    expect(estimateFallback([{ id: "a", file, size: 1000 }], { format: "webp", quality: 80, lossless: false, pngOptimizationLevel: 2, metadataPolicy: "strip", outputLocation: "source", overwrite: false }).estimatedBytes).toBeLessThan(1000);
  });

  it("filters unsupported files", () => {
    expect(filterCompressionFiles([new File([], "a.png", { type: "image/png" }), new File([], "a.txt", { type: "text/plain" })])).toHaveLength(1);
  });

  it("rejects supported images above the native input limit before queueing them", () => {
    const oversized = new File([new Uint8Array(COMPRESSION_MAX_INPUT_BYTES + 1)], "large.png", { type: "image/png" });
    const unsupported = new File([new Uint8Array([1])], "notes.txt", { type: "text/plain" });
    const accepted = new File([new Uint8Array([1])], "small.png", { type: "image/png" });
    expect(splitCompressionImportFiles([accepted, oversized, unsupported])).toEqual({ accepted: [accepted], unsupported: [unsupported], oversized: [oversized] });
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

  it("requires a target size when target-size control is enabled", () => {
    expect(getCompressionTargetSizeError(false, "", 128 * 1024)).toBeNull();
    expect(getCompressionTargetSizeError(true, "", 128 * 1024)).toContain("请输入");
    expect(getCompressionTargetSizeError(true, "0", 128 * 1024)).toContain("1–");
    expect(getCompressionTargetSizeError(true, "128", 128 * 1024)).toBeNull();
    expect(getCompressionTargetSizeError(true, "131073", 128 * 1024)).toContain("131,072");
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

  it("requires complete desktop source queues before enabling source deletion", () => {
    expect(canDeleteCompressionSource([{ sourcePath: "C:/images/a.png" }], true)).toBe(true);
    expect(canDeleteCompressionSource([{ sourcePath: "C:/images/a.png" }, { sourcePath: undefined }], true)).toBe(false);
    expect(canDeleteCompressionSource([{ sourcePath: "C:/images/a.png" }], false)).toBe(false);
    expect(formatCompressionDeleteSourceConfirmation(["C:/images/a.png"])).toContain("删除");
    expect(formatCompressionDeleteSourceConfirmation(["C:/images/a.png"])).toContain("不可撤销");
  });

  it("labels each batch result state without implying an output for skips", () => {
    expect(formatCompressionItemResultStatus("completed")).toBe("已完成");
    expect(formatCompressionItemResultStatus("skipped")).toBe("已跳过");
    expect(formatCompressionItemResultStatus("failed")).toBe("失败");
  });

  it("keeps native per-item size metrics and derives missing legacy fields safely", () => {
    expect(getCompressionItemResultMetrics({ inputBytes: 100, outputBytes: 125, savedBytes: -25, savingsPercent: -25 }, 90)).toEqual({ inputBytes: 100, outputBytes: 125, savedBytes: -25, savingsPercent: -25 });
    expect(getCompressionItemResultMetrics({ outputBytes: 80 }, 100)).toEqual({ inputBytes: 100, outputBytes: 80, savedBytes: 20, savingsPercent: 20 });
    expect(getCompressionItemResultMetrics({}, 100)).toEqual({ inputBytes: 100, outputBytes: undefined, savedBytes: undefined, savingsPercent: undefined });
  });

  it("keeps auto numbering mutually exclusive with overwrite and original replacement", () => {
    expect(normalizeCompressionOutputModes({ autoNumbering: true, overwrite: true, replaceOriginal: false })).toEqual({ autoNumbering: true, overwrite: false, replaceOriginal: false });
    expect(normalizeCompressionOutputModes({ autoNumbering: true, overwrite: true, replaceOriginal: true })).toEqual({ autoNumbering: false, overwrite: false, replaceOriginal: true });
    expect(normalizeCompressionOutputModes({ autoNumbering: false, overwrite: true, replaceOriginal: false })).toEqual({ autoNumbering: false, overwrite: true, replaceOriginal: false });
  });

  it("labels native estimates and fallback reasons distinctly", () => {
    expect(formatCompressionEstimateSource("native", "当前选中图片")).toBe("原生精确预估（当前选中图片）");
    expect(formatCompressionEstimateSource("fallback", "原生预估失败：不可用")).toBe("本地估算（原生预估失败：不可用）");
  });

  it("rejects stale or aborted native estimate responses", () => {
    expect(isCurrentCompressionEstimate(3, 3, false)).toBe(true);
    expect(isCurrentCompressionEstimate(2, 3, false)).toBe(false);
    expect(isCurrentCompressionEstimate(3, 3, true)).toBe(false);
  });

  it("keeps browser files usable for directory output and reports missing desktop paths per item", () => {
    expect(getCompressionSourcePathError("directory", false)).toBeNull();
    expect(getCompressionSourcePathError("source", false)).toContain("缺少桌面源文件路径");
    expect(getCompressionSourcePathError("subfolder", false)).toContain("指定目录");
    expect(getCompressionSourcePathError("source", false, true)).toContain("覆盖原图需要");
    expect(isCompressionSourcePathError("invalid sourcePath: Missing")).toBe(true);
    expect(isCompressionSourcePathError("[preflight_output_directory_missing] output directory is unavailable")).toBe(false);
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

  it("validates and normalizes optional custom output file names", () => {
    expect(getCompressionOutputFileNameError("", "webp")).toBeNull();
    expect(getCompressionOutputFileNameError("旅行照片", "webp")).toBeNull();
    expect(getCompressionOutputFileNameError("旅行照片.WEBP", "webp")).toBeNull();
    expect(getCompressionOutputFileNameError("旅行照片.png", "webp")).toContain("扩展名");
    expect(getCompressionOutputFileNameError("   ", "webp")).toContain("空白");
    expect(getCompressionOutputFileNameError(" 旅行照片", "webp")).toContain("空白");
    expect(getCompressionOutputFileNameError(".旅行照片", "webp")).toContain("句点");
    expect(getCompressionOutputFileNameError("旅行照片..webp", "webp")).toContain("路径");
    expect(getCompressionOutputFileNameError("../旅行照片", "webp")).toContain("路径");
    expect(getCompressionOutputFileNameError("旅行/照片", "webp")).toContain("路径");
    expect(getCompressionOutputFileNameError("旅行:照片", "webp")).toContain("禁止");
    expect(getCompressionOutputFileNameError("CON", "webp")).toContain("保留名称");
    expect(getCompressionOutputFileNameError("旅行照片.txt", "webp")).toContain("扩展名");
    expect(getCompressionOutputFileNameError("旅行照片.WEBP", "webp")).toBeNull();
    expect(getCompressionOutputFileNameError("界".repeat(86), "webp")).toContain("UTF-8");
    expect(getCompressionOutputFileNameError("界".repeat(85), "webp")).toBeNull();
    expect(normalizeCompressionOutputFileName("旅行照片", "webp")).toBe("旅行照片.webp");
    expect(normalizeCompressionOutputFileName("旅行照片.WEBP", "webp")).toBe("旅行照片.webp");
  });

  it("keeps batch parameter modes deterministic before native work starts", () => {
    expect(normalizeCompressionOutputModes({ overwrite: true, autoNumbering: true, replaceOriginal: false })).toEqual({ overwrite: false, autoNumbering: true, replaceOriginal: false });
    expect(normalizeCompressionOutputModes({ overwrite: true, autoNumbering: true, replaceOriginal: true })).toEqual({ overwrite: false, autoNumbering: false, replaceOriginal: true });
    expect(getCompressionBatchFinalState([], false)).toEqual({ status: "success", stage: "completed" });
    expect(getCompressionBatchFinalState(["bad.png"], false)).toEqual({ status: "error", stage: "failed" });
    expect(getCompressionBatchFinalState(["bad.png"], true)).toEqual({ status: "error", stage: "cancelled" });
    expect(COMPRESSION_WEBP_METHOD_DEFAULT).toBe(4);
    expect([COMPRESSION_WEBP_METHOD_MIN, COMPRESSION_WEBP_METHOD_MAX]).toEqual([0, 6]);
  });

  it("merges, replaces, removes, retries, and cancels batch items without mutating inputs", () => {
    const createItem = (id: string, name: string): CompressionItem => ({ id, file: new File([new Uint8Array([1])], name, { type: "image/png" }), size: 1 });
    const first = createItem("a", "a.png");
    const second = createItem("b", "b.png");
    const replacement = createItem("new", "new.png");
    const current = [first, second];
    const added = mergeCompressionItems(current, [second, replacement]);
    expect(added.items.map((item) => item.id)).toEqual(["a", "b", "new"]);
    expect(current.map((item) => item.id)).toEqual(["a", "b"]);
    const replaced = mergeCompressionItems(current, [replacement], "b");
    expect(replaced.replacingExisting).toBe(true);
    expect(replaced.items.map((item) => item.file.name)).toEqual(["a.png", "new.png"]);
    expect(replaced.itemsToHydrate[0]?.id).toBe("b");
    expect(removeCompressionItem(replaced.items, "a").map((item) => item.file.name)).toEqual(["new.png"]);
    expect(getCompressionRetryQueue([first, second], ["b.png"]).map((item) => item.file.name)).toEqual(["b.png"]);
    const duplicateName = createItem("duplicate", "b.png");
    expect(getCompressionRetryQueue([second, duplicateName], ["duplicate"]).map((item) => item.id)).toEqual(["duplicate"]);
    expect(getCompressionRetryQueue([first, second], []).map((item) => item.file.name)).toEqual(["a.png", "b.png"]);
    expect(getCompressionCancelledItemResults([first, second, replacement], 0)).toEqual([{ itemId: "b", fileName: "b.png", status: "skipped", reason: "已取消，未处理" }, { itemId: "new", fileName: "new.png", status: "skipped", reason: "已取消，未处理" }]);
  });
});
