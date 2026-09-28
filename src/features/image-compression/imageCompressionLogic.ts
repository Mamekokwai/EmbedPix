import type { CompressionEstimate, CompressionFormat, CompressionItem, CompressionItemResult, CompressionItemResultStatus, CompressionOptions, CompressionOutputLocation, CompressionPreset } from "./types";
export const COMPRESSION_FORMATS: ReadonlyArray<{ value: CompressionFormat; label: string }> = [{ value: "jpg", label: "JPEG" }, { value: "webp", label: "WebP" }, { value: "png", label: "PNG" }];
export const COMPRESSION_PRESETS: ReadonlyArray<{ value: Exclude<CompressionPreset, "custom">; label: string; description: string; quality: number; pngOptimizationLevel: number }> = [
  { value: "high-quality", label: "高质量", description: "JPEG/WebP 有损质量 92；PNG 优化 2；WebP 默认无损", quality: 92, pngOptimizationLevel: 2 },
  { value: "balanced", label: "平衡", description: "JPEG/WebP 有损质量 82；PNG 优化 3；WebP 默认无损", quality: 82, pngOptimizationLevel: 3 },
  { value: "small-size", label: "小体积", description: "JPEG/WebP 有损质量 70；PNG 优化 6；WebP 默认无损", quality: 70, pngOptimizationLevel: 6 },
];

export function getCompressionPreset(preset: Exclude<CompressionPreset, "custom">) {
  return COMPRESSION_PRESETS.find((option) => option.value === preset) ?? COMPRESSION_PRESETS[1];
}
export function supportsCompressionTargetSize(format: CompressionFormat, lossless: boolean): boolean { return format === "jpg" || (format === "webp" && !lossless); }
export function getSuccessfulCompressionOutputPath(status: "completed" | "skipped", outputPath: string): string | null { const normalizedPath = outputPath.trim(); return status === "completed" && normalizedPath ? normalizedPath : null; }
export function formatCompressionFailureDetails(details: ReadonlyArray<{ fileName: string; message: string }>): string { return details.map(({ fileName, message }) => `${fileName}：${message}`).join("\n"); }
export function formatCompressionItemResultStatus(status: CompressionItemResultStatus): string { return status === "completed" ? "已完成" : status === "skipped" ? "已跳过" : "失败"; }
export function normalizeCompressionOutputModes(modes: { autoNumbering?: boolean; overwrite: boolean; replaceOriginal?: boolean }): { autoNumbering: boolean; overwrite: boolean; replaceOriginal: boolean } {
  const replaceOriginal = modes.replaceOriginal === true;
  const autoNumbering = !replaceOriginal && modes.autoNumbering === true;
  return { autoNumbering, overwrite: !replaceOriginal && !autoNumbering && modes.overwrite, replaceOriginal };
}
export function formatCompressionEstimateSource(source: "native" | "fallback", detail?: string): string { return `${source === "native" ? "原生精确预估" : "本地估算"}${detail ? `（${detail}）` : ""}`; }
export function isCurrentCompressionEstimate(requestId: number, currentRequestId: number, aborted: boolean): boolean { return !aborted && requestId === currentRequestId; }
export function getCompressionSourcePathError(location: CompressionOutputLocation, hasSourcePath: boolean, replaceOriginal = false): string | null {
  if (hasSourcePath || location === "directory") return null;
  return replaceOriginal ? "覆盖原图需要可访问的桌面源文件路径。" : "缺少桌面源文件路径；当前输出位置需要源文件路径，浏览器 File 请改用“指定目录”。";
}
export function isCompressionSourcePathError(message: string): boolean { return /sourcePath|source path|源文件/u.test(message); }
export function canReplaceCompressionOriginal(items: ReadonlyArray<Pick<CompressionItem, "sourcePath">>, desktopEnvironment: boolean): boolean { return desktopEnvironment && items.length > 0 && items.every((item) => Boolean(item.sourcePath?.trim())); }
export function formatCompressionReplaceOriginalConfirmation(sourcePaths: ReadonlyArray<string>): string { return [`危险操作：将覆盖 ${sourcePaths.length} 个源文件。`, "每个原图会先移动到同目录的 bak 文件夹，再写入压缩结果。", "失败或跳过不会删除或破坏源文件。取消确认不会开始压缩。", "是否继续？"].join("\n"); }
export function estimateFallback(items: ReadonlyArray<CompressionItem>, options: CompressionOptions): CompressionEstimate { const inputBytes = items.reduce((sum, item) => sum + item.size, 0); const ratio = options.lossless || options.format === "png" ? 0.82 : Math.max(0.15, 0.65 - options.quality / 300); const estimatedBytes = Math.max(1, Math.round(inputBytes * ratio)); return { inputBytes, estimatedBytes, savingsPercent: Math.max(0, (1 - estimatedBytes / Math.max(1, inputBytes)) * 100) }; }
export function formatCompressionBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
export function filterCompressionFiles(files: File[]): File[] { return files.filter((file) => /^image\/(png|jpeg|webp|bmp|gif)$/iu.test(file.type) || /\.(png|jpe?g|webp|bmp|gif)$/iu.test(file.name)); }

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
  return failures.length > 0 ? items.filter((item) => failures.includes(item.file.name)) : [...items];
}

export function getCompressionCancelledItemResults(items: ReadonlyArray<CompressionItem>, currentIndex: number): CompressionItemResult[] {
  return items.slice(currentIndex + 1).map((item) => ({ fileName: item.file.name, status: "skipped", reason: "已取消，未处理" }));
}

export function getCompressionBatchFinalState(failedNames: ReadonlyArray<string>, cancelled: boolean): { status: "success" | "error"; stage: "completed" | "cancelled" | "failed" } {
  return failedNames.length > 0
    ? { status: "error", stage: cancelled ? "cancelled" : "failed" }
    : { status: "success", stage: "completed" };
}
