import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(url: URL): string {
  return readFileSync(url, "utf8").replace(/\r\n?/g, "\n");
}

const gifCss = readSource(new URL("./features/gif-maker.css", import.meta.url));
const converterCss = readSource(new URL("./features/image-converter.css", import.meta.url));
const compressionCss = readSource(new URL("./features/image-compression.css", import.meta.url));
const gifView = readSource(new URL("../features/gif-maker/GifMakerView.tsx", import.meta.url));
const converterView = readSource(new URL("../features/image-converter/ImageConverter.tsx", import.meta.url));
const compressionView = readSource(new URL("../features/image-compression/ImageCompressionView.tsx", import.meta.url));
const appShell = readSource(new URL("../app/AppShell.tsx", import.meta.url));
const appTitleBar = readSource(new URL("../app/AppTitleBar.tsx", import.meta.url));
const compressionGateway = readSource(new URL("../platform/compression/compressionGateway.ts", import.meta.url));
const compressionPreferences = readSource(new URL("../features/image-compression/compressionPreferences.ts", import.meta.url));
const windowControlGateway = readSource(new URL("../platform/window/windowControlGateway.ts", import.meta.url));
const defaultCapabilities = readSource(new URL("../../src-tauri/capabilities/default.json", import.meta.url));
const themeSelectCss = readSource(new URL("./components/theme-select.css", import.meta.url));
const updateCss = readSource(new URL("./features/update.css", import.meta.url));
const updateView = readSource(new URL("../features/update/UpdateView.tsx", import.meta.url));

const VIEWPORT_MATRIX = [
  { name: "compact portrait", width: 320, height: 480 },
  { name: "small portrait", width: 360, height: 500 },
  { name: "tablet portrait", width: 480, height: 640 },
  { name: "narrow tall", width: 700, height: 1100 },
  { name: "wide short", width: 900, height: 700 },
  { name: "desktop short", width: 1280, height: 720 },
  { name: "landscape narrow", width: 560, height: 420 },
  { name: "regular desktop", width: 1280, height: 800 },
] as const;

describe("compact layout viewport contract", () => {
  it("renders update failure details only for error states and wraps long text", () => {
    expect(updateView).toContain('status === "error" && errorMessage');
    expect(updateCss).toContain(".update-error-message");
    expect(updateCss).toContain("overflow-wrap: anywhere");
  });
  it("keeps estimate target and selected-quality fields visible with native results", () => {
    expect(compressionView).toContain("setEstimate(mergeCompressionEstimateResult(result))");
    expect(compressionView).toContain("typeof estimate.targetMet === \"boolean\"");
    expect(compressionView).toContain("typeof estimate.selectedQuality === \"number\"");
  });
  it("exposes a copyable compression batch summary without changing native wiring", () => {
    expect(compressionView).toContain("formatCompressionBatchSummary");
    expect(compressionView).toContain("复制批处理摘要");
    expect(compressionView).toContain("disabled={resultStats.total === 0}");
    expect(compressionView).toContain("下载 JSON 报告");
    expect(compressionView).toContain("createCompressionBatchReport");
  });
  it("exposes per-item retry only for retryable result states", () => {
    expect(compressionView).toContain('result.itemId && (result.status === "failed" || result.status === "skipped")');
    expect(compressionView).toContain("runCompression([result.itemId as string])");
    expect(compressionView).toContain("仅重试此项");
  });
  it("exposes a GIF export report only after an export path exists", () => {
    expect(gifView).toContain("createGifExportReport");
    expect(gifView).toContain("下载 JSON 报告");
    expect(gifView).toContain("打开文件夹");
    expect(gifView).toContain("复制路径");
    expect(gifView).toContain("openLastExportFolder");
    expect(gifView).toContain("copyLastExportPath");
    expect(gifView).toContain("{lastExportPath ? <div className=\"gif-output-actions\"");
    expect(gifCss).toContain(".gif-output-actions { display: flex; flex-wrap: wrap;");
  });
  it("clears stale GIF export actions when export inputs change", () => {
    expect(gifView).toContain("setExportFrameSummary(null);\n    setLastExportPath(null);");
  });
  it("clears stale compression preflight space when inputs or options change", () => {
    expect(compressionView).toContain("setPreflightSpaceBytes(null);");
    expect(compressionView).toMatch(/\[items, options, selectedItemId\]/);
  });
  it("keeps strip-safe metadata pending until validation completes", () => {
    expect(compressionView).toContain("useState<{ format: CompressionFormat; items: Array<Pick<CompressionItem, \"id\" | \"file\">>; valid: boolean | null } | null>(null)");
    expect(compressionView).toContain("setStripSafeInputValidation({ format, items: stripSafeValidationItems, valid: null });");
    expect(compressionView).toContain("getCurrentStripSafeValidation(stripSafeInputValidation, format, stripSafeValidationItems)");
    expect(compressionView).toContain("stripSafeInputVerified === true");
    expect(compressionView).toContain('(metadataPolicy === "stripSafe" || metadataPolicy === "preserve") && stripSafeInputVerified === false');
    expect(compressionView).toContain("setStripSafeInputValidation({ format, items: stripSafeValidationItems, valid: errors.every((error) => error === null) });");
    expect(compressionView).toContain("isCurrentStripSafeValidation(stripSafeInputValidation, format, stripSafeValidationItems)");
  });
  it("blocks native preview and estimate while strip-safe validation is pending", () => {
    expect(compressionView).toContain('options.metadataPolicy === "stripSafe" && stripSafeInputVerified !== true');
    expect(compressionView).toContain("正在校验安全清理输入");
    expect(compressionView).toContain("校验完成后生成预览");
    expect(compressionView).toMatch(/\[active, busy, items, options, selectedItem, stripSafeInputVerified\]/);
    expect(compressionView).toContain("const stripSafeValidationItems = useMemo");
  });
  it("normalizes both LF and CRLF source checkouts before matching contracts", () => {
    expect(".a\r\n.b\r.c\n".replace(/\r\n?/g, "\n")).toBe(".a\n.b\n.c\n");
  });

  it.each(VIEWPORT_MATRIX)("defines a deterministic contract for $name ($width×$height)", ({ width, height }) => {
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(gifCss).toContain("overflow-x: hidden");
    expect(gifCss).toMatch(/\.gif-frame-list \{[^}]*flex-direction: column;[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/s);
    expect(gifCss).toContain(".gif-canvas-stage { min-height: 132px;");
    expect(converterCss).toContain(".converter-app {\n  width: min(1180px, 100%);");
    expect(converterCss).toContain("overflow-x: hidden;");
    expect(converterCss).toContain(".preview-content { min-height: 210px; }");
    expect(compressionCss).toContain(".compression-app {\n  width: min(1180px, 100%);");
    expect(compressionCss).toContain("overflow-x: hidden;");
    expect(compressionCss).toContain("@media (max-width: 520px)");
    expect(themeSelectCss).toContain(".theme-select-option:focus-visible");
  });

  it("covers the requested portrait and narrow-tall viewport safeguards", () => {
    expect(VIEWPORT_MATRIX).toEqual(expect.arrayContaining([
      { name: "compact portrait", width: 320, height: 480 },
      { name: "small portrait", width: 360, height: 500 },
      { name: "narrow tall", width: 700, height: 1100 },
    ]));
    expect(gifCss).toContain("@media (max-width: 500px) and (max-height: 620px)");
    expect(gifCss).toContain(".gif-maker-view > .gif-export-footer { position: sticky;");
    expect(gifCss).toContain(".gif-busy-cancel { width: 100%; margin-top: 4px; }");
    expect(compressionCss).toContain(".compression-settings-card { display: grid; grid-template-columns: minmax(0, 1fr); }");
    expect(compressionCss).toContain("overflow-wrap: anywhere;");
  });

  it("keeps export and cancellation controls represented in both workspaces", () => {
    expect(gifView).toContain("gif-export-button");
    expect(gifView).toContain("cancelVideoExtraction");
    expect(gifView).toContain("getGifCancelButtonLabel");
    expect(converterView).toContain("export-button");
    expect(converterView).toContain("requestExportCancel");
    expect(converterView).toContain("if (status.kind === \"busy\") return;");
    expect(converterView).toContain("disabled={status.kind === \"busy\"}");
    expect(gifView).toContain("pendingRef.current > 0 || status.kind === \"exporting\"");
    expect(converterView).toContain("导入图片文件夹");
    expect(converterCss).toContain(".directory-import-button");
    expect(converterCss).toContain(".drop-zone-actions");
    expect(gifView).toContain("保存工作区");
    expect(converterView).toContain("打开工作区");
    expect(gifCss).toContain(".gif-header-note { display: flex; flex-wrap: wrap;");
    expect(converterCss).toContain(".workspace-transfer-actions > * { flex: 1 1 0;");
    expect(gifView).toContain("gif-status-${status.kind}");
    expect(gifView).toContain("formatGifExportProgress");
    expect(gifView).toContain('role={gifExportProgress && status.kind === "exporting" ? "progressbar" : "status"}');
    expect(gifView).toContain("aria-valuenow={gifExportProgress && status.kind === \"exporting\" ? exportProgressCurrent : undefined}");
    expect(gifView).toContain("const exportProgressCurrent = Math.min(Math.max");
    expect(gifView).toContain("setSourceMode(\"video\")");
    expect(gifView).toContain("选择视频");
    expect(converterView).toContain("export-progress-panel");
  });

  it("keeps the compression workbench wired into navigation and busy guards", () => {
    expect(appShell).toContain('id: "compression"');
    expect(compressionView).toContain("导入文件夹");
    expect(compressionView).toContain("重试失败项");
    expect(compressionView).toContain("aria-live=\"polite\"");
    expect(compressionView).toContain("disabled={busy}");
    expect(compressionView).toContain("当前浏览器预览仅支持编辑参数和估算大小");
    expect(compressionView).toContain("getCompressionSourcePathError");
    expect(compressionView).toContain('role="progressbar"');
    expect(compressionView).toContain("aria-valuetext={progress.total > 0");
    expect(compressionView).toContain("formatCompressionProgressSummary");
    expect(compressionView).toContain("totalInputBytes: resultStats.inputBytes");
    expect(compressionView).toContain("setCustomResizeActive(false); setTargetResizePercent(null); setPreset(\"custom\"); return;");
    expect(compressionView).toContain('className="compression-estimate-note" aria-live="polite"');
    expect(compressionView).toContain("isCompressionSourcePathError");
    expect(compressionView).toContain("桌面源文件不可访问，未导出");
    expect(compressionView).toContain("源文件夹子目录");
    expect(compressionView).toContain("成功、跳过和节省统计");
    expect(compressionView).toContain("result.status === \"skipped\"");
    expect(compressionView).toContain("skippedReason");
    expect(compressionView).toContain("真实压缩预览");
    expect(compressionView).toContain("复制输出路径");
    expect(compressionView).toContain("打开输出文件夹");
    expect(compressionView).toContain("当前文件：");
    expect(compressionView).toContain("复制失败详情");
    expect(compressionView).toContain("formatCompressionFailureDetails");
    expect(compressionView).toContain("estimateImageCompression");
    expect(compressionView).toContain("estimateRequestIdRef");
    expect(compressionView).toContain("isCurrentCompressionEstimate");
    expect(compressionView).toContain("原生精确预估");
    expect(compressionView).toContain("formatCompressionEstimateSource");
    expect(compressionView).toContain("逐项结果");
    expect(compressionView).toContain("getCompressionItemResultMetrics");
    expect(compressionView).toContain("原图 ${formatCompressionBytes(metrics.inputBytes)}");
    expect(compressionView).toContain('result.status === "skipped" ? "候选" : "输出"');
    expect(compressionView).toContain("节省");
    expect(compressionView).toContain("增加");
    expect(compressionView).toContain("formatCompressionItemResultStatus");
    expect(compressionView).toContain("getSuccessfulCompressionOutputPath");
    expect(compressionView).toContain("revealImageOutput");
    expect(compressionView).toContain("loadCompressionPreferences");
    expect(compressionView).toContain("saveCompressionPreferences");
    expect(compressionPreferences).toContain("COMPRESSION_PREFERENCES_VERSION = 3");
    expect(compressionPreferences).not.toContain("outputDirectory");
    expect(compressionPreferences).not.toContain("sourcePath");
    expect(compressionView).toContain("AbortController");
    expect(compressionView).toContain("最大输出体积（JPEG/WebP 有损）");
    expect(compressionView).toContain("getCompressionTargetSizeError");
    expect(compressionView).toContain("启用目标体积控制");
    expect(compressionView).toContain("压缩后更大时跳过");
    expect(compressionView).toContain("风险模式：压缩结果可能比原图更大");
    expect(compressionView).toContain("skipIfLarger");
    expect(compressionView).toContain("覆盖原图并备份到 bak");
    expect(compressionView).toContain("formatCompressionReplaceOriginalConfirmation");
    expect(compressionView).toContain("window.confirm");
    expect(compressionView).toContain("formatCompressionDeleteSourceConfirmation");
    expect(compressionView).toContain("deleteSourceAvailable");
    expect(compressionView).toContain("!replaceOriginalAvailable");
    expect(compressionView).toContain('disabled={encodingOptionDisabled || !qualityEnabled}');
    expect(compressionView).toContain('disabled={encodingOptionDisabled || !qualityEnabled || !targetSizeActive}');
    expect(compressionView).toContain('const encodingOptionDisabled = busy || metadataPreserveActive;');
    expect(compressionView).toContain("maxCandidates: !metadataPreserveActive && maxOutputBytes ? maxCandidates : undefined");
    expect(compressionView).toContain("selectedQuality");
    expect(compressionView).toContain("PNG 优化级别");
    expect(compressionView).toContain("PNG 透明像素优化");
    expect(compressionView).toContain("pngOptimizeAlpha");
    expect(compressionView).toContain("pngOptimizationLevel");
    expect(compressionView).toContain("内置预设");
    expect(compressionView).toContain("恢复平衡默认");
    expect(compressionView).toContain("disabled={busy}");
    expect(compressionView).toContain("DEFAULT_COMPRESSION_PREFERENCES.format");
    expect(compressionView).toContain("setWebpPass(DEFAULT_COMPRESSION_PREFERENCES.webpPass)");
    expect(compressionView).toContain("setPngOptimizeAlpha(DEFAULT_COMPRESSION_PREFERENCES.pngOptimizeAlpha)");
    expect(compressionView).toContain("setJpegBackground(DEFAULT_COMPRESSION_PREFERENCES.jpegBackground)");
    expect(compressionView).toContain("setMetadataPolicy(DEFAULT_COMPRESSION_PREFERENCES.metadataPolicy)");
    expect(compressionView).toContain("保存当前参数");
    expect(compressionView).toContain("导出 JSON");
    expect(compressionView).toContain("导入 JSON");
    expect(compressionView).toContain("loadCompressionCustomPresets");
    expect(compressionView).toContain("importCompressionPresetsJson");
    expect(compressionCss).toContain(".compression-balanced-reset { justify-self: start; }");
    expect(compressionView).toContain("JPEG 使用质量滑块进行有损编码");
    expect(compressionView).toContain("当前为有损 WebP；质量滑块控制编码质量");
    expect(compressionView).toContain("核心最多尝试 ${maxCandidates} 个 WebP 质量候选");
    expect(compressionView).toContain("WebP 无损编码");
    expect(compressionView).toContain("WebP 编码方法");
    expect(compressionView).toContain("webpMethod");
    expect(compressionView).toContain("Alpha 质量 ${webpAlphaQuality}");
    expect(compressionView).toContain("分析遍数 ${webpPass}");
    expect(compressionView).toContain("compression-webp-method-hint");
    expect(compressionView).toContain("disabled={encodingOptionDisabled || !webpLossyActive}");
    expect(compressionPreferences).toContain("webpMethod");
    expect(compressionPreferences).toContain("webpPass");
    expect(compressionPreferences).toContain("skipIfLarger");
    expect(compressionView).toContain("保留原始元数据（原字节透传）");
    expect(compressionView).toContain("全部清理会移除可识别的元数据");
    expect(compressionView).toContain("全部清理元数据");
    expect(compressionView).toContain('format === "webp" ? "WebP" : "PNG"');
    expect(compressionView).toContain("保留结构合法且有界的 ICC payload");
    expect(compressionView).toContain('<details className="compression-advanced-settings">');
    expect(compressionView).toContain("高级输出选项");
    expect(compressionView).toContain("元数据、路径与覆盖策略");
    expect(compressionView).toContain("compression-advanced-settings-body");
    expect(compressionView.indexOf("启用目标体积控制")).toBeLessThan(compressionView.indexOf('<details className="compression-advanced-settings">'));
    expect(compressionView.slice(compressionView.indexOf('<details className="compression-advanced-settings">')).indexOf("允许覆盖同名文件")).toBeGreaterThan(-1);
    expect(compressionView).toContain("PNG 始终无损");
    expect(compressionView).toContain("formatCompressionProgressError");
    expect(compressionView).toContain("const progressError = formatCompressionProgressError(next);");
    expect(compressionView).toContain("const sourceBusy = busy || importBusy;");
    expect(compressionView).toContain("清空");
    expect(compressionView).toContain("替换当前");
    expect(compressionView).toContain("replaceItemIdRef");
    expect(compressionView).toContain("仅使用所选文件中的第一张");
    expect(compressionView).toContain("getCompressionInputFormat(item.file)");
    expect(compressionView).toContain("item.dimensions.width");
    expect(compressionView).toContain("compression-import-errors");
    expect(compressionView).toContain("读取失败或被文件夹扫描跳过");
    expect(compressionView).toContain("pickCompressionDirectoryResult");
    expect(compressionView).toContain("compression-item-select");
    expect(compressionView).toContain('<strong title={item.file.name}>{item.file.name}</strong>');
    expect(compressionView).toContain("event.preventDefault(); void chooseFiles()");
    expect(compressionView).toContain("setResultStats({ total: 0, succeeded: 0, skipped: 0, failed: 0");
    expect(compressionView).toContain("setFailures([]);");
    expect(compressionCss).toContain(".compression-preview-grid");
    expect(compressionView).toContain("compression-preview-compare");
    expect(compressionView).toContain("原图与压缩结果分界位置");
    expect(compressionCss).toContain(".compression-preview-compare-divider");
    expect(compressionCss).toContain(".compression-preview-compare-range input:focus-visible");
    expect(compressionView).toContain("同名目标会拒绝写入");
    expect(compressionView).toContain("自动序号避免重名");
    expect(compressionView).toContain("autoNumbering");
    expect(compressionView).toContain("outputFileName");
    expect(compressionView).toContain("getCompressionOutputFileNameError");
    expect(compressionView).toContain("normalizeCompressionOutputFileName");
    expect(compressionView).toContain("compression-output-file-name-hint");
    expect(compressionGateway).toContain("autoSequence");
    expect(compressionView).toContain("输出位置仍按上方设置");
    expect(compressionCss).toContain(".compression-progress");
    expect(compressionCss).toContain("@media (max-height: 620px)");
    expect(compressionCss).toContain(".compression-status > span { min-width: 0;");
    expect(compressionCss).toContain(".compression-clear-button:focus-visible");
    expect(compressionCss).toContain(".compression-import-errors");
    expect(compressionCss).toContain(".compression-output-actions");
    expect(compressionCss).toContain(".compression-current-file");
    expect(compressionView).toContain('className="compression-current-file" aria-live="polite" title={currentFileName ?? undefined}');
    expect(compressionCss).toContain(".compression-failure-details");
    expect(compressionCss).toContain(".compression-item-results");
    expect(compressionCss).toContain(".compression-item-result-actions");
    expect(compressionCss).toContain(".compression-custom-presets");
    expect(compressionCss).toContain(".compression-preset-actions");
    expect(compressionCss).toContain(".compression-preset-message");
    expect(compressionCss).toContain(".compression-estimate-note");
    expect(compressionCss).toContain(".compression-check span { display: grid; min-width: 0;");
    expect(compressionCss).toContain(".compression-webp-method-hint");
    expect(compressionCss).toContain(".compression-output-file-name-hint");
    expect(compressionCss).toContain(".compression-advanced-settings { min-width: 0; grid-column: 1 / -1;");
    expect(compressionCss).toContain(".compression-advanced-settings summary:focus-visible");
    expect(compressionCss).toContain(".compression-advanced-settings-body { display: grid; min-width: 0;");
    expect(compressionCss).toContain(".compression-skip-larger-warning");
  });

  it("keeps compression state mounted while navigation only toggles visibility", () => {
    expect(appShell).toContain('<div className="app-kept-view app-kept-compression" hidden={view !== "compression"}>');
    expect(appShell).toContain("const LazyImageCompressionView = lazy(() => import(\"../features/image-compression/ImageCompressionView\"))");
    expect(appShell).toContain("const LazyGifMakerView = lazy(() => import(\"../features/gif-maker/GifMakerView\"))");
    expect(appShell).not.toContain('import ImageCompressionView from "../features/image-compression/ImageCompressionView"');
    expect(appShell).not.toContain('import GifMakerView from "../features/gif-maker/GifMakerView"');
    expect(appShell).toContain("const [mountedViews, setMountedViews]");
    expect(appShell).toContain("{mountedViews.compression ? <LazyImageCompressionView active={view === \"compression\"} /> : null}");
    expect(appShell).toContain("{mountedViews.gif ? <LazyGifMakerView active={view === \"gif\"} /> : null}");
    expect(appShell).not.toContain('{view === "compression" ? <ImageCompressionView');
    expect(appShell).toContain("setMountedViews((current) => current[view] ? current : { ...current, [view]: true })");
    expect(appShell).toContain("<Suspense fallback=");
    expect(appShell).toContain("app-view-loading");
    expect(compressionView).toContain('if (!active || items.length === 0)');
    expect(compressionView).toContain('if (busy) {');
    expect(compressionView).toContain('}, [active, busy, options, selectedItem, stripSafeInputVerified]);');
    expect(compressionView).toContain('const sourceBusy = busy || importBusy;');
  });

  it("keeps compression export parameters visible in a wrapping summary", () => {
    expect(compressionView).toContain('aria-label="导出参数摘要"');
    expect(compressionView).toContain("compressionParameterSummary");
    expect(compressionView).toContain("getCompressionAlphaHandling");
    expect(compressionView).toContain('className="compression-alpha-status"');
    expect(compressionView).toContain('aria-label="复制当前压缩参数摘要"');
    expect(compressionView).toContain("formatCompressionParameterSummary");
    expect(compressionCss).toContain(".compression-parameter-summary { display: flex;");
    expect(compressionCss).toContain(".compression-alpha-status { display: flex;");
    expect(compressionCss).toContain("overflow-wrap: anywhere");
  });

  it("keeps batch cancellation, retry, and source-list transitions explicit", () => {
    expect(compressionView).toContain('const queue = getCompressionRetryQueue(items, retryItemIds ?? failures);');
    expect(compressionView).toContain('getCompressionCancelledItemResults(queue, index)');
    expect(compressionView).toContain('const finalState = getCompressionBatchFinalState(failedNames, cancelRequestedRef.current);');
    expect(compressionView).toContain('const merged = mergeCompressionItems(items, next, replaceItemId);');
    expect(compressionView).toContain('const nextItems = removeCompressionItem(items, id);');
    expect(compressionView).toContain('void cancelActiveCompression();');
    expect(compressionView).toContain('重试失败项');
    expect(compressionView).toContain("其余文件未处理，可点击“重试失败项”继续");
    const nativeImportStart = compressionView.indexOf("const importNativeFiles");
    const nativeImportEnd = compressionView.indexOf("const chooseFiles", nativeImportStart);
    const nativeImportSource = compressionView.slice(nativeImportStart, nativeImportEnd);
    expect(nativeImportSource).toContain("setFailures([]);");
    expect(nativeImportSource).toContain("setFailureDetails([]);");
    expect(nativeImportSource).toContain("setItemResults([]);");
  });

  it("invalidates stale image export preflight when request parameters change", () => {
    expect(converterView).toContain("setExportPreflight(null);");
    expect(converterView).toContain("setNativePreflightStatus(null);");
    expect(converterView).toMatch(/\[autoSequence, bitDepth, deleteSource, file, fileNameTemplate, height, imageTransform, keepAspectRatio, loadedImages, outputDirectory, outputLocation, outputSubdirectory, outputFormat, overwriteSameName, width\]/);
    expect(converterView).toContain("setActualExportResult(null);");
  });

  it("keeps GIF interaction modules, multiselect, and batch duration controls represented", () => {
    expect(gifView).toContain("素材帧");
    expect(gifView).toContain("动画预览");
    expect(gifView).toContain("画布");
    expect(gifView).toContain("帧时长");
    expect(gifView).toContain("导出设置");
    expect(gifView).toContain("selectedFrameIndices");
    expect(gifView).toContain("批量设置选中帧时长");
    expect(gifView).toContain("恢复平衡默认");
    expect(gifView).toContain("disabled={!canEditFrames}");
    expect(gifView).toContain("DEFAULT_GIF_MAKER_PREFERENCES.targetSizeKiB");
  });

  it("does not reintroduce a horizontal scrolling frame list", () => {
    expect(gifCss).not.toMatch(/\.gif-frame-list \{[^}]*overflow-x: auto;/s);
    expect(gifCss).toMatch(/\.gif-frame-list \{[^}]*overflow-x: hidden; overflow-y: auto;/s);
    expect(gifCss).toContain(".gif-frame-meta small { min-width: 0; overflow: hidden;");
    expect(gifCss).toContain(".gif-busy-cancel { width: 100%; margin-top: 4px; }");
    expect(gifCss).toContain(".gif-balanced-reset { justify-self: start; }");
    expect(gifView).toContain('className="quiet-button gif-busy-cancel"');
  });

  it("keeps one target, limit, and compression control per output-format branch", () => {
    expect((gifView.match(/<span>目标文件大小<\/span>/g) ?? []).length).toBe(3);
    expect((gifView.match(/<span>最大文件大小<\/span>/g) ?? []).length).toBe(3);
    expect((gifView.match(/<strong>自动压缩到目标大小<\/strong>/g) ?? []).length).toBe(3);
    expect(gifCss).toContain(".gif-export-grid { grid-template-columns: minmax(0, 1fr); }");
    expect(gifView).toContain("WebP/APNG 动图使用当前画布和帧时长导出");
    expect(gifView).toContain("PNG 帧序列按当前画布逐帧输出 PNG");
    expect(gifView).toContain("仅调用原生规划，不会修改参数或自动压缩正式导出");
  });

  it("keeps focus styling and text wrapping explicit for narrow and short windows", () => {
    expect(gifCss).toContain(":focus-visible");
    expect(gifCss).toContain("overflow-wrap: anywhere");
    expect(gifCss).toContain("flex-wrap: wrap");
    expect(converterCss).toContain(":focus-visible");
    expect(converterCss).toContain("overflow-wrap: anywhere");
    expect(converterCss).toContain("overflow-x: hidden;");
  });

  it("keeps resource cleanup and failed-item retry paths explicit", () => {
    expect(converterView).toContain("URL.revokeObjectURL(realPreviewUrlRef.current)");
    expect(converterView).toContain("loadedImagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl))");
    expect(converterView).toContain("仅重试失败项");
    expect(converterView).toContain("暂停队列");
    expect(converterView).toContain("继续导出");
    expect(converterView).toContain("原子导出不会被中断");
    expect(gifView).toContain("framesRef.current.forEach((frame) => URL.revokeObjectURL(frame.previewUrl))");
    expect(gifView).toContain("videoImportRequestRef.current += 1");
    expect(gifView).toContain("setSelectedFrameIndices(new Set());");
    expect(gifView).toContain("正在取消导出");
    expect(converterView).toContain("if (!active || !file || !dimensions");
  });

  it("flips custom dropdowns above the trigger in short windows", () => {
    expect(themeSelectCss).toContain("@media (max-height: 620px)");
    expect(themeSelectCss).toContain("bottom: calc(100% + 5px);");
  });

  it("keeps the 700px narrow workspace in normal vertical flow when settings expand", () => {
    expect(gifCss).toContain("@media (max-width: 760px) and (min-height: 621px)");
    expect(gifCss).toContain(".gif-workspace-grid { flex: 0 0 auto; grid-template-rows: 128px minmax(220px, auto); overflow: visible; }");
    expect(gifCss).toContain(".gif-main-column, .gif-preview-card { min-height: 220px; }");
    expect(gifCss).toContain(".gif-settings-card { max-height: none; overflow: visible; }");
    expect(gifView).toContain('gif-settings-expanded');
    expect(gifCss).toContain('.gif-maker-view.gif-settings-expanded > .gif-export-footer { position: static; }');
  });
  it("keeps GIF header workspace actions visible on narrow windows", () => {
    expect(gifCss).toContain(".gif-header-note { width: 100%; margin-left: 0; flex-wrap: wrap; white-space: normal; }");
    expect(gifCss).toContain(".gif-header-note .workspace-file-button, .gif-header-note > .quiet-button { flex: 1 1 auto; }");
    expect(gifView).toContain("title={`${videoSource.name} · ${videoSource.width} × ${videoSource.height} px`}");
  });

  it("keeps GIF parameter summary copy action available and compact", () => {
    expect(gifView).toContain("copyExportParameterSummary");
    expect(gifView).toContain("复制 GIF 导出参数摘要");
    expect(gifView).toContain('setError(null);\n      setStatus({ kind: "success", text: "导出参数已复制" });');
    expect(gifCss).toContain(".gif-copy-parameter-summary");
  });

  it("does not compress narrow short GIF cards below readable content height", () => {
    expect(gifCss).toContain("@media (max-width: 760px) and (min-height: 621px) and (max-height: 760px)");
    expect(gifCss).toContain(".gif-workspace-grid { grid-template-rows: minmax(128px, auto) minmax(220px, auto); }");
    expect(gifCss).not.toContain("grid-template-rows: minmax(96px, .85fr) minmax(96px, 1.15fr)");
    expect(gifCss).toContain(".gif-assets-card,");
    expect(gifCss).toContain(".gif-preview-card,");
  });

  it("keeps GIF drag and drop isolated from the hidden image converter", () => {
    expect(appShell).toContain('<div className="app-kept-view" hidden={view !== "converter"}>');
    expect(appShell).toContain('<div className="app-kept-view app-kept-gif" hidden={view !== "gif"}>');
    expect(gifView).toContain("onDrop={handleDrop}");
    expect(gifView).toContain('if (sourceMode === "video")');
  });

  it("keeps the title-bar close flow on the native destroy path", () => {
    expect(appTitleBar).toContain("destroyCurrentWindow");
    expect(appTitleBar).toContain("WINDOW_DESTROY_TIMEOUT_MS");
    expect(appTitleBar).toContain("destroy current window timed out");
    expect(appTitleBar).toContain("requestWindowClose().then(async () =>");
    expect(appTitleBar).toContain("falling back to close");
    expect(appTitleBar).toContain("await closeCurrentWindow();");
    expect(windowControlGateway).toContain("await currentWindow().destroy();");
    expect(defaultCapabilities).toContain('"core:window:allow-destroy"');
  });

  it("uses one signed size-change vocabulary for preview and estimate", () => {
    expect(compressionView).toContain("formatCompressionSizeDelta(previewSavedBytes, previewSavingsPercent)");
    expect(compressionView).toContain("预计体积变化");
    expect(compressionView).toContain("formatCompressionSizeDelta(estimate.inputBytes - estimate.estimatedBytes, estimate.savingsPercent)");
  });
});
