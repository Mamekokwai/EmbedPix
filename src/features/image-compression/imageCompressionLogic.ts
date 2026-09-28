import type { CompressionEstimate, CompressionFormat, CompressionItem, CompressionItemResultStatus, CompressionOptions, CompressionOutputLocation, CompressionPreset } from "./types";
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
