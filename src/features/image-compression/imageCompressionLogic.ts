import type { CompressionEstimate, CompressionFormat, CompressionItem, CompressionItemResult, CompressionItemResultStatus, CompressionOptions, CompressionOutputLocation, CompressionPreset } from "./types";
export const COMPRESSION_WEBP_METHOD_MIN = 0;
export const COMPRESSION_WEBP_METHOD_MAX = 6;
export const COMPRESSION_WEBP_METHOD_DEFAULT = 4;
export const COMPRESSION_MAX_INPUT_BYTES = 32 * 1024 * 1024;
export const COMPRESSION_MAX_CANDIDATES_MIN = 1;
export const COMPRESSION_MAX_CANDIDATES_MAX = 12;
export const COMPRESSION_MAX_CANDIDATES_DEFAULT = 8;
export const COMPRESSION_FORMATS: ReadonlyArray<{ value: CompressionFormat; label: string }> = [{ value: "jpg", label: "JPEG" }, { value: "webp", label: "WebP" }, { value: "png", label: "PNG" }];
export interface CompressionDimensionBitmap { width: number; height: number; close: () => void; }
export interface CompressionDimensionImage { naturalWidth: number; naturalHeight: number; onload: ((event: Event) => void) | null; onerror: ((event: Event) => void) | null; src: string; }
export interface CompressionDimensionDependencies { createImageBitmap?: (file: Blob) => Promise<CompressionDimensionBitmap>; createImage: () => CompressionDimensionImage; createObjectURL: (file: Blob) => string; revokeObjectURL: (url: string) => void; }

export function readCompressionDimensions(file: Blob, dependencies: CompressionDimensionDependencies = {
  createImageBitmap: typeof globalThis.createImageBitmap === "function" ? globalThis.createImageBitmap.bind(globalThis) : undefined,
  createImage: () => new Image(),
  createObjectURL: (value) => URL.createObjectURL(value),
  revokeObjectURL: (value) => URL.revokeObjectURL(value),
}): Promise<{ width: number; height: number }> {
  if (dependencies.createImageBitmap) {
    return dependencies.createImageBitmap(file).then((bitmap) => {
      try { return { width: bitmap.width, height: bitmap.height }; }
      finally { bitmap.close(); }
    });
  }
  return new Promise((resolve, reject) => {
    const image = dependencies.createImage();
    const objectUrl = dependencies.createObjectURL(file);
    let released = false;
    const release = () => { if (!released) { released = true; dependencies.revokeObjectURL(objectUrl); } };
    image.onload = () => { try { resolve({ width: image.naturalWidth, height: image.naturalHeight }); } catch (error) { reject(error); } finally { release(); } };
    image.onerror = () => { release(); reject(new Error("无法读取图片尺寸。")); };
    try { image.src = objectUrl; } catch (error) { release(); reject(error); }
  });
}

export const COMPRESSION_PRESETS: ReadonlyArray<{ value: Exclude<CompressionPreset, "custom">; label: string; description: string; quality: number; pngOptimizationLevel: number }> = [
  { value: "high-quality", label: "高质量", description: "JPEG/WebP 有损质量 92；PNG 优化 2；WebP 默认无损", quality: 92, pngOptimizationLevel: 2 },
  { value: "balanced", label: "平衡", description: "JPEG/WebP 有损质量 82；PNG 优化 3；WebP 默认无损", quality: 82, pngOptimizationLevel: 3 },
  { value: "small-size", label: "小体积", description: "JPEG/WebP 有损质量 70；PNG 优化 6；WebP 默认无损", quality: 70, pngOptimizationLevel: 6 },
];

export function getCompressionPreset(preset: Exclude<CompressionPreset, "custom">) {
  return COMPRESSION_PRESETS.find((option) => option.value === preset) ?? COMPRESSION_PRESETS[1];
}
export function supportsCompressionTargetSize(format: CompressionFormat, lossless: boolean): boolean { return format === "jpg" || (format === "webp" && !lossless); }
export interface StripSafeValidationSnapshot { format: CompressionFormat; items: ReadonlyArray<Pick<CompressionItem, "id" | "file">>; valid: boolean | null; }
export function isCurrentStripSafeValidation(snapshot: StripSafeValidationSnapshot | null, format: CompressionFormat, items: ReadonlyArray<Pick<CompressionItem, "id" | "file">>): boolean {
  return Boolean(snapshot && snapshot.format === format && snapshot.items.length === items.length && snapshot.items.every((item, index) => item.id === items[index]?.id && item.file === items[index]?.file));
}
export function getCurrentStripSafeValidation(snapshot: StripSafeValidationSnapshot | null, format: CompressionFormat, items: ReadonlyArray<Pick<CompressionItem, "id" | "file">>): boolean | null {
  return isCurrentStripSafeValidation(snapshot, format, items) ? snapshot?.valid ?? null : null;
}
export function isCurrentCompressionItem<T extends { id: string; file: unknown }>(items: ReadonlyArray<T>, item: Pick<T, "id" | "file">): boolean { return items.some((candidate) => candidate.id === item.id && candidate.file === item.file); }
export function canWriteCompressionItemUpdate<T extends { id: string; file: unknown }>(mounted: boolean, items: ReadonlyArray<T>, item: Pick<T, "id" | "file">): boolean { return mounted && isCurrentCompressionItem(items, item); }
export function removeCompressionDimensionError<T extends { id: string }>(errors: ReadonlyArray<T>, itemId: string): T[] { return errors.filter((error) => error.id !== `dimensions-${itemId}`); }
export function formatCompressionReason(reason: string | undefined): string {
  if (!reason) return "";
  const labels: Readonly<Record<string, string>> = { target_unmet: "未达到目标体积", target_unreachable: "无法达到目标体积", quality_threshold_unmet: "未达到质量阈值" };
  const separator = reason.indexOf(":");
  if (separator < 0) return reason;
  const label = labels[reason.slice(0, separator)];
  return label ? `${label}：${reason.slice(separator + 1).trim()}` : reason;
}
export function formatCompressionError(error: string): string {
  const labels: Readonly<Record<string, string>> = {
    "unsupported compression format": "不支持的压缩格式",
    "compression commands require a raw binary IPC request": "压缩命令需要原始二进制 IPC 请求",
    "compression estimate requires a raw binary IPC request": "压缩估算需要原始二进制 IPC 请求",
    "compression request is truncated": "压缩请求已截断",
    "compression estimate request is truncated": "压缩估算请求已截断",
    "compression request has invalid magic": "压缩请求标识无效",
    "compression estimate request has invalid magic": "压缩估算请求标识无效",
    "compression metadata is too large": "压缩元数据过大",
    "compression estimate metadata is too large": "压缩估算元数据过大",
    "compression metadata length overflowed": "压缩元数据长度溢出",
    "compression estimate metadata length overflowed": "压缩估算元数据长度溢出",
    "compression metadata length exceeds payload size": "压缩元数据长度超出载荷大小",
    "compression estimate metadata length exceeds payload size": "压缩估算元数据长度超出载荷大小",
    "invalid compression metadata JSON": "压缩元数据 JSON 无效",
    "invalid compression estimate metadata JSON": "压缩估算元数据 JSON 无效",
    "unsupported compression schemaVersion": "不支持的压缩 schemaVersion",
    "fileName is invalid": "文件名无效",
    "jpegQuality must be between": "JPEG 质量必须在",
    "jpegBackground must be a #RRGGBB color": "JPEG 背景必须是 #RRGGBB 颜色",
    "jpegBackground is only supported for JPEG output": "jpegBackground 仅支持 JPEG 输出",
    "maxOutputBytes must be between": "最大输出体积必须在",
    "maxInputBytes must be between": "最大输入体积必须在",
    "maxCandidates must be between": "最大候选次数必须在",
    "maxRgbMae must be a finite number between": "最大 RGB MAE 必须是介于",
    "maxRgbMae is only supported for lossy WebP compression with maxOutputBytes": "maxRgbMae 仅支持带 maxOutputBytes 的有损 WebP 压缩",
    "pngOptimizationLevel must be between": "PNG 优化级别必须在",
    "pngOptimizeAlpha is only supported for PNG output": "pngOptimizeAlpha 仅支持 PNG 输出",
    "webpMethod must be between": "WebP 编码方法必须在",
    "webpMethod is only supported for lossy WebP": "webpMethod 仅支持有损 WebP",
    "webpAlphaQuality must be between": "WebP Alpha 质量必须在",
    "webpAlphaQuality is only supported for lossy WebP": "webpAlphaQuality 仅支持有损 WebP",
    "webpPass must be between": "WebP 分析遍数必须在",
    "webpPass is only supported for lossy WebP": "webpPass 仅支持有损 WebP",
    "webpNearLossless must be between": "WebP 近无损等级必须在",
    "webpNearLossless is only supported for lossless WebP": "webpNearLossless 仅支持无损 WebP",
    "lossy compression is not supported for PNG": "PNG 不支持有损压缩",
    "lossless compression is not supported for JPEG": "JPEG 不支持无损压缩",
    "input image exceeds the 32 MiB limit": "输入图片超过 32 MiB 限制",
    "input image exceeds the configured maxInputBytes limit": "输入图片超过配置的 maxInputBytes 限制",
    "input image must be between": "输入图片大小必须在",
    "input image dimensions exceed the compression limit": "输入图片尺寸超过压缩限制",
    "compressed output exceeds the 128 MiB limit": "压缩输出超过 128 MiB 限制",
    "invalid WebP container": "WebP 容器无效",
    "invalid WebP chunk padding": "WebP 区块填充无效",
    "invalid WebP chunk": "WebP 区块无效",
    "metadataPolicy=preserve is not supported": "metadataPolicy=preserve 不受支持",
    "replaceOriginal requires sourcePath": "覆盖原图需要 sourcePath",
    "deleteSource requires sourcePath": "删除源文件需要 sourcePath",
    "outputFileName cannot be combined with outputPath": "outputFileName 不能与 outputPath 组合使用",
    "outputPath is required for path output": "路径输出需要 outputPath",
    "sourcePath is required for": "此输出方式需要 sourcePath",
    "invalid sourcePath": "sourcePath 无效",
    "invalid outputPath": "outputPath 无效",
    "invalid outputDirectory": "outputDirectory 无效",
    "compressed output dimensions do not match the source image": "压缩输出尺寸与源图片不匹配",
    "compressed preview dimensions do not match the source image": "压缩预览尺寸与源图片不匹配",
    "animated GIF input is not supported; provide a static GIF": "不支持动态 GIF 输入，请提供静态 GIF",
    "animated WebP input is not supported; provide a static WebP": "不支持动态 WebP 输入，请提供静态 WebP",
    "failed to decode input image": "输入图片解码失败",
    "failed to inspect input image": "输入图片检查失败",
  };
  for (const [prefix, label] of Object.entries(labels)) {
    const index = error.indexOf(prefix);
    if (index < 0) continue;
    const before = error.slice(0, index);
    const suffix = error.slice(index + prefix.length);
    if (!suffix) return `${before}${label}`;
    if (suffix.startsWith(":")) return `${before}${label}：${suffix.slice(1).trim()}`;
    return `${before}${label}${suffix}`;
  }
  return error;
}
export function getCompressionTargetSizeError(enabled: boolean, value: string, maxKiB: number): string | null {
  if (!enabled) return null;
  const trimmed = value.trim();
  if (!trimmed) return "请输入目标体积。";
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= maxKiB ? null : `目标体积需为 1–${maxKiB.toLocaleString()} KiB。`;
}
export function getSuccessfulCompressionOutputPath(status: "completed" | "skipped", outputPath: string): string | null { const normalizedPath = outputPath.trim(); return status === "completed" && normalizedPath ? normalizedPath : null; }
export function formatCompressionFailureDetails(details: ReadonlyArray<{ fileName: string; message: string }>): string { return details.map(({ fileName, message }) => `${fileName}：${message}`).join("\n"); }
export function formatCompressionBatchSummary(summary: { total: number; succeeded: number; skipped: number; failed: number; processedInputBytes: number; outputBytes: number; savedBytes: number; targetMet: boolean | null; selectedQualities: ReadonlyArray<number>; itemResults: ReadonlyArray<Pick<CompressionItemResult, "fileName" | "status" | "reason">> }): string {
  const lines = [
    `压缩批处理：${summary.total} 项`,
    `成功 ${summary.succeeded} · 跳过 ${summary.skipped} · 失败 ${summary.failed}`,
    `已处理输入 ${formatCompressionBytes(summary.processedInputBytes)} · 输出 ${formatCompressionBytes(summary.outputBytes)} · 节省 ${formatCompressionBytes(summary.savedBytes)}`,
    summary.targetMet === null ? null : `目标体积：${summary.targetMet ? "已达成" : "未达成"}`,
    summary.selectedQualities.length ? `实际质量：${summary.selectedQualities.join(" / ")}` : null,
    ...summary.itemResults.filter((item) => item.status !== "completed" || item.reason).map((item) => `${item.status === "failed" ? "失败" : "跳过"} ${item.fileName.split(/[\\/]/u).pop() ?? item.fileName}${item.reason ? `：${item.reason}` : ""}`),
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}
export function formatCompressionItemResultStatus(status: CompressionItemResultStatus): string { return status === "completed" ? "已完成" : status === "skipped" ? "已跳过" : "失败"; }
export interface CompressionItemResultMetrics { inputBytes: number; outputBytes?: number; savedBytes?: number; savingsPercent?: number; }
function finiteMetric(value: number | undefined, allowNegative = false): number | undefined { return typeof value === "number" && Number.isFinite(value) && (allowNegative || value >= 0) ? value : undefined; }
export function getCompressionItemResultMetrics(result: Pick<CompressionItemResult, "inputBytes" | "outputBytes" | "savedBytes" | "savingsPercent">, fallbackInputBytes: number): CompressionItemResultMetrics {
  const inputBytes = finiteMetric(result.inputBytes) ?? Math.max(0, fallbackInputBytes);
  const outputBytes = finiteMetric(result.outputBytes);
  const savedBytes = finiteMetric(result.savedBytes, true) ?? (outputBytes === undefined ? undefined : inputBytes - outputBytes);
  const savingsPercent = finiteMetric(result.savingsPercent, true) ?? (savedBytes === undefined || inputBytes <= 0 ? undefined : (savedBytes / inputBytes) * 100);
  return { inputBytes, outputBytes, savedBytes, savingsPercent };
}
export function normalizeCompressionOutputModes(modes: { autoNumbering?: boolean; overwrite: boolean; replaceOriginal?: boolean }): { autoNumbering: boolean; overwrite: boolean; replaceOriginal: boolean } {
  const replaceOriginal = modes.replaceOriginal === true;
  const autoNumbering = !replaceOriginal && modes.autoNumbering === true;
  return { autoNumbering, overwrite: !replaceOriginal && !autoNumbering && modes.overwrite, replaceOriginal };
}
export function formatCompressionEstimateSource(source: "native" | "fallback", detail?: string): string { return `${source === "native" ? "原生精确预估" : "本地估算"}${detail ? `（${detail}）` : ""}`; }
export function mergeCompressionEstimateResult(result: Omit<CompressionEstimate, "estimatedBytes"> & { outputBytes: number }): CompressionEstimate { return { ...result, estimatedBytes: result.outputBytes }; }
export function isCurrentCompressionEstimate(requestId: number, currentRequestId: number, aborted: boolean): boolean { return !aborted && requestId === currentRequestId; }
export function waitForCompressionProgressTick(signal: AbortSignal, delayMs = 160): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    };
    timeout = globalThis.setTimeout(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
export function getCompressionSourcePathError(location: CompressionOutputLocation, hasSourcePath: boolean, replaceOriginal = false): string | null {
  if (hasSourcePath || location === "directory") return null;
  return replaceOriginal ? "覆盖原图需要可访问的桌面源文件路径。" : "缺少桌面源文件路径；当前输出位置需要源文件路径，浏览器 File 请改用“指定目录”。";
}
export function isCompressionSourcePathError(message: string): boolean { return /sourcePath|source path|源文件/u.test(message); }
export function canReplaceCompressionOriginal(items: ReadonlyArray<Pick<CompressionItem, "sourcePath">>, desktopEnvironment: boolean): boolean { return desktopEnvironment && items.length > 0 && items.every((item) => Boolean(item.sourcePath?.trim())); }
export function formatCompressionReplaceOriginalConfirmation(sourcePaths: ReadonlyArray<string>): string { return [`危险操作：将覆盖 ${sourcePaths.length} 个源文件。`, "每个原图会先移动到同目录的 bak 文件夹，再写入压缩结果。", "失败或跳过不会删除或破坏源文件。取消确认不会开始压缩。", "是否继续？"].join("\n"); }
export function canDeleteCompressionSource(items: ReadonlyArray<Pick<CompressionItem, "sourcePath">>, desktopEnvironment: boolean): boolean { return desktopEnvironment && items.length > 0 && items.every((item) => Boolean(item.sourcePath?.trim())); }
export function formatCompressionDeleteSourceConfirmation(sourcePaths: ReadonlyArray<string>): string { return [`危险操作：压缩成功后将删除 ${sourcePaths.length} 个源文件。`, "只有对应输出成功且校验通过后才会删除；失败或跳过会保留源文件。", "删除操作不可撤销。取消确认不会开始压缩。", "是否继续？"].join("\n"); }
export function estimateFallback(items: ReadonlyArray<CompressionItem>, options: CompressionOptions): CompressionEstimate { const inputBytes = items.reduce((sum, item) => sum + item.size, 0); const ratio = options.lossless || options.format === "png" ? 0.82 : Math.max(0.15, 0.65 - options.quality / 300); const estimatedBytes = Math.max(1, Math.round(inputBytes * ratio)); return { inputBytes, estimatedBytes, savingsPercent: Math.max(0, (1 - estimatedBytes / Math.max(1, inputBytes)) * 100) }; }
export function formatCompressionBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
export function filterCompressionFiles(files: File[]): File[] { return files.filter((file) => /^image\/(png|jpeg|webp|bmp|gif)$/iu.test(file.type) || /\.(png|jpe?g|webp|bmp|gif)$/iu.test(file.name)); }
export function splitCompressionImportFiles(files: File[], maxInputBytes = COMPRESSION_MAX_INPUT_BYTES): { accepted: File[]; unsupported: File[]; oversized: File[] } {
  const supported = filterCompressionFiles(files);
  const supportedSet = new Set(supported);
  const oversized = supported.filter((file) => file.size > maxInputBytes);
  const oversizedSet = new Set(oversized);
  return {
    accepted: supported.filter((file) => !oversizedSet.has(file)),
    unsupported: files.filter((file) => !supportedSet.has(file)),
    oversized,
  };
}

export function getCompressionSubdirectoryError(value: string): string | null {
  const name = value.trim();
  if (!name) return "请输入子文件夹名称。";
  if (name === "." || name === "..") return "子文件夹名称不能是 . 或 ..。";
  if (name.length > 255) return "子文件夹名称不能超过 255 个字符。";
  if (/[\\/:*?"<>|\u0000-\u001f]/u.test(name) || name.endsWith(".") || name.endsWith(" ")) return "子文件夹名称包含不安全字符。";
  const baseName = name.split(".")[0]?.toUpperCase() ?? name.toUpperCase();
  if (["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)].includes(baseName)) return "子文件夹名称不能使用 Windows 保留名称。";
  return null;
}

export function getCompressionOutputLocationError(location: CompressionOutputLocation, subdirectory: string, directory: string, hasSourcePath: boolean): string | null {
  if ((location === "source" || location === "subfolder") && !hasSourcePath) return "当前导入方式没有可用的源文件路径，请改用“指定目录”或在桌面应用中重新选择图片。";
  if (location === "subfolder") return getCompressionSubdirectoryError(subdirectory);
  if (location === "directory" && !directory.trim()) return "请输入输出目录。";
  return null;
}

const WINDOWS_RESERVED_FILE_NAMES = new Set(["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)]);

function compressionOutputExtension(format: CompressionFormat): string {
  return `.${format}`;
}

export function getCompressionOutputFileNameError(value: string, format: CompressionFormat): string | null {
  if (value.length === 0) return null;
  if (value.trim() !== value) return "文件名不能以空白字符开头或结尾。";
  const name = value;
  if (new TextEncoder().encode(name).byteLength > 255) return "文件名不能超过 255 个 UTF-8 字节。";
  if (name.startsWith(".") || name.includes("..")) return "文件名不能以句点开头或包含路径片段 ..。";
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(name)) return "文件名包含路径分隔符或 Windows 禁止字符。";
  if (name.endsWith(".") || name.endsWith(" ")) return "文件名不能以空格或句点结尾。";

  const lastDot = name.lastIndexOf(".");
  const extension = lastDot > 0 ? name.slice(lastDot + 1).toLowerCase() : "";
  const stem = lastDot > 0 ? name.slice(0, lastDot) : name;
  if (WINDOWS_RESERVED_FILE_NAMES.has(stem.toUpperCase())) return "文件名不能使用 Windows 保留名称。";
  if (lastDot > 0 && extension !== format) return `文件扩展名必须为 .${format}；可省略扩展名。`;
  return null;
}

export function normalizeCompressionOutputFileName(value: string, format: CompressionFormat): string | undefined {
  const name = value;
  if (!name) return undefined;
  const targetExtension = compressionOutputExtension(format);
  const lastDot = name.lastIndexOf(".");
  if (lastDot > 0 && name.slice(lastDot + 1).toLowerCase() === format) return `${name.slice(0, lastDot)}${targetExtension}`;
  return `${name}${targetExtension}`;
}

export function mergeCompressionItems(current: ReadonlyArray<CompressionItem>, incoming: ReadonlyArray<CompressionItem>, replaceItemId: string | null = null): { items: CompressionItem[]; itemsToHydrate: CompressionItem[]; replacingExisting: boolean } {
  const replacement = replaceItemId ? incoming[0] : undefined;
  const replacingExisting = Boolean(replacement && current.some((item) => item.id === replaceItemId));
  if (replacingExisting && replacement && replaceItemId) {
    const hydratedReplacement = { ...replacement, id: replaceItemId };
    return { items: current.map((item) => item.id === replaceItemId ? hydratedReplacement : item), itemsToHydrate: [hydratedReplacement], replacingExisting: true };
  }
  const existing = new Set(current.map((item) => item.id));
  const added: CompressionItem[] = [];
  for (const item of incoming) {
    if (existing.has(item.id)) continue;
    existing.add(item.id);
    added.push(item);
  }
  return { items: [...current, ...added], itemsToHydrate: added, replacingExisting: false };
}

export function removeCompressionItem(items: ReadonlyArray<CompressionItem>, id: string): CompressionItem[] {
  return items.filter((item) => item.id !== id);
}

export function getCompressionRetryQueue(items: ReadonlyArray<CompressionItem>, failures: ReadonlyArray<string>): CompressionItem[] {
  if (failures.length === 0) return [...items];
  const failureSet = new Set(failures);
  const itemIds = new Set(items.map((item) => item.id));
  return items.filter((item) => failureSet.has(item.id) || (!itemIds.has(item.file.name) && failureSet.has(item.file.name)));
}

export function getCompressionCancelledItemResults(items: ReadonlyArray<CompressionItem>, currentIndex: number): CompressionItemResult[] {
  return items.slice(currentIndex + 1).map((item) => ({ itemId: item.id, fileName: item.file.name, status: "skipped", reason: "已取消，未处理" }));
}

export function getCompressionBatchFinalState(failedNames: ReadonlyArray<string>, cancelled: boolean): { status: "success" | "error" | "cancelled"; stage: "completed" | "cancelled" | "failed" } {
  if (cancelled) return { status: "cancelled", stage: "cancelled" };
  return failedNames.length > 0
    ? { status: "error", stage: "failed" }
    : { status: "success", stage: "completed" };
}
export function isCompressionProgressCompleted(progress: Pick<{ status: string; stage: string }, "status" | "stage">): boolean {
  return progress.status === "completed" || progress.stage === "completed";
}
