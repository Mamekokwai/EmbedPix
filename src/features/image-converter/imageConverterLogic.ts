import type { BmpBitDepth, ImageDimensions, OutputFormat, OutputLocation, RowAlignment } from "./types";
import { FORMAT_METADATA, IMAGE_OUTPUT_FORMAT_IDS } from "../../shared/formatMetadata";

export const MAX_DIMENSION = 8192;
export const MAX_IMAGE_PIXELS = 16_777_216;
export const MAX_INPUT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_JPEG_QUALITY = 85;
export const DEFAULT_C_ARRAY_NAME = "image_data";
export const ROW_ALIGNMENTS: ReadonlyArray<RowAlignment> = [1, 2, 4];

export const OUTPUT_FORMATS: ReadonlyArray<{
  value: OutputFormat;
  label: string;
  hint: string;
  description: string;
}> = [
  ...IMAGE_OUTPUT_FORMAT_IDS.map((id) => {
    const format = FORMAT_METADATA.find((item) => item.id === id);
    return {
      value: id as OutputFormat,
      label: format?.label ?? id,
      hint: format?.hint ?? "",
      description: format?.description ?? "",
    };
  }),
];

export const BMP_BIT_DEPTHS: ReadonlyArray<BmpBitDepth> = [1, 4, 8, 16, 24, 32];
export const PNG_BIT_DEPTHS: ReadonlyArray<BmpBitDepth> = [24, 32];
export const SUPPORTED_IMAGE_ACCEPT = ".png,.jpg,.jpeg,.bmp,.gif,.webp,image/png,image/jpeg,image/bmp,image/gif,image/webp";
export const SUPPORTED_IMAGE_FORMAT_LABEL = "PNG、JPEG/JPG、BMP、GIF、WEBP";

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/bmp",
  "image/gif",
  "image/webp",
]);
const SUPPORTED_IMAGE_EXTENSION_PATTERN = /\.(bmp|gif|jpe?g|png|webp)$/i;

export function formatFileSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMebibytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function normalizeDimension(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(MAX_DIMENSION, Math.max(1, parsed));
}

export function parseDimension(value: string) {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_DIMENSION ? parsed : null;
}

export function getDimensionError(value: string, label: string) {
  if (value.length === 0) {
    return `${label}不能为空。`;
  }

  return parseDimension(value) === null ? `${label}需为 1–${MAX_DIMENSION.toLocaleString("zh-CN")} 之间的整数。` : null;
}

export function getPixelError(widthValue: string, heightValue: string) {
  const nextWidth = parseDimension(widthValue);
  const nextHeight = parseDimension(heightValue);
  if (nextWidth === null || nextHeight === null || nextWidth * nextHeight <= MAX_IMAGE_PIXELS) {
    return null;
  }

  return `输出尺寸不能超过 ${MAX_IMAGE_PIXELS.toLocaleString("zh-CN")} 像素。`;
}

export function constrainDimensions(nextDimensions: ImageDimensions): ImageDimensions {
  const scale = Math.min(
    1,
    MAX_DIMENSION / nextDimensions.width,
    MAX_DIMENSION / nextDimensions.height,
    Math.sqrt(MAX_IMAGE_PIXELS / (nextDimensions.width * nextDimensions.height)),
  );
  return {
    width: Math.max(1, Math.floor(nextDimensions.width * scale)),
    height: Math.max(1, Math.floor(nextDimensions.height * scale)),
  };
}

export function constrainAspectDimensions(axis: "width" | "height", value: number, source: ImageDimensions) {
  const ratio = source.width / source.height;
  const maxWidth = Math.min(MAX_DIMENSION, Math.floor(Math.sqrt(MAX_IMAGE_PIXELS * ratio)));
  const maxHeight = Math.min(MAX_DIMENSION, Math.floor(Math.sqrt(MAX_IMAGE_PIXELS / ratio)));
  const nextWidth = axis === "width"
    ? Math.min(value, maxWidth)
    : Math.max(1, Math.round(Math.min(value, maxHeight) * ratio));
  const nextHeight = axis === "height"
    ? Math.min(value, maxHeight)
    : Math.max(1, Math.round(nextWidth / ratio));
  return constrainDimensions({ width: nextWidth, height: nextHeight });
}

export function getBitDepths(format: OutputFormat): ReadonlyArray<BmpBitDepth> {
  if (format === "png") {
    return PNG_BIT_DEPTHS;
  }

  if (format === "jpg") {
    return [24];
  }

  if (format === "rgb565" || format === "c-array") {
    return [16];
  }

  return BMP_BIT_DEPTHS;
}

export function getEffectiveBitDepth(format: OutputFormat, bitDepth: BmpBitDepth) {
  if (format === "jpg") {
    return 24;
  }
  if (format === "rgb565" || format === "c-array") {
    return 16;
  }
  return bitDepth;
}

export function getFormatInfo(format: OutputFormat) {
  return OUTPUT_FORMATS.find((item) => item.value === format) ?? OUTPUT_FORMATS[0];
}

export function getBackgroundNote(format: OutputFormat, bitDepth: BmpBitDepth) {
  const keepsTransparency = (format === "png" && bitDepth === 32) || (format === "bmp" && bitDepth === 32);
  return keepsTransparency ? "留白区域使用此颜色；源图透明度保留" : "透明区域使用此颜色";
}

export function getBitDepthNote(format: OutputFormat, bitDepth: BmpBitDepth) {
  if (format === "jpg") {
    return "JPG 始终输出 24 位。";
  }

  if (bitDepth === 32) {
    return "32 位输出保留透明度。";
  }

  return `${bitDepth} 位输出不含透明度，透明区域使用背景色。`;
}

export function isRawPixelFormat(format: OutputFormat) {
  return format === "rgb565" || format === "c-array";
}

export function isCArrayFormat(format: OutputFormat) {
  return format === "c-array";
}

export function normalizeCArrayName(value: string) {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[a-zA-Z_]/.test(normalized)) {
    return normalized;
  }
  return normalized ? `image_${normalized}` : DEFAULT_C_ARRAY_NAME;
}

export function getOutputParameterNote(format: OutputFormat) {
  if (format === "rgb565") {
    return "固定 RGB565 / 16 位像素数据。";
  }
  if (format === "c-array") {
    return "固定 RGB565 / 16 位，生成可复制的 C 源码。";
  }
  return null;
}

export function isImageFile(file: { type: string; name: string }) {
  const hasSupportedMime = file.type.length === 0 || SUPPORTED_IMAGE_MIME_TYPES.has(file.type.toLowerCase());
  return hasSupportedMime && SUPPORTED_IMAGE_EXTENSION_PATTERN.test(file.name);
}

export function getOutputLabel(format: OutputFormat) {
  if (format === "rgb565") {
    return "RGB565 BIN";
  }
  if (format === "c-array") {
    return "C 数组";
  }
  return format.toUpperCase();
}

export function getMissingSourcePathFileName(
  outputLocation: OutputLocation,
  images: ReadonlyArray<{ file: { name: string }; sourcePath: string | null }>,
  enforceSourcePath: boolean,
) {
  if (!enforceSourcePath || !["source", "subfolder", "original"].includes(outputLocation)) {
    return null;
  }
  return images.find((image) => !image.sourcePath)?.file.name ?? null;
}

export interface ExportSafetyPlan {
  targetPaths: string[];
  sourcePathsToBackup: string[];
  sourcePathsToDelete: string[];
  overwriteMode: "original" | "same-name" | null;
}

interface ExportSafetyPlanOptions {
  outputFormat: OutputFormat;
  outputLocation: OutputLocation;
  outputSubdirectory: string;
  outputDirectory: string;
  overwriteSameName: boolean;
  deleteSource: boolean;
}

function outputExtension(format: OutputFormat): string {
  if (format === "rgb565") return "bin";
  if (format === "c-array") return "h";
  return format;
}

function getPathSeparator(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

function getPathDirectory(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(0, separatorIndex) : "";
}

function getPathFileName(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(separatorIndex + 1);
}

function replacePathExtension(path: string, extension: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dotIndex = path.lastIndexOf(".");
  const hasExtension = dotIndex > separatorIndex + 1;
  const stemEnd = hasExtension ? dotIndex : path.length;
  return `${path.slice(0, stemEnd)}.${extension}`;
}

function joinPath(directory: string, child: string): string {
  const trimmedDirectory = directory.trim().replace(/[\\/]+$/u, "");
  if (!trimmedDirectory) return child;
  return `${trimmedDirectory}${getPathSeparator(directory)}${child}`;
}

function pathsMatch(left: string, right: string): boolean {
  const normalize = (path: string) => path.replace(/[\\/]+/gu, "/").replace(/\/$/u, "");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return /^[A-Za-z]:\//u.test(normalizedLeft) || /^[A-Za-z]:\//u.test(normalizedRight)
    ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
    : normalizedLeft === normalizedRight;
}

function addConvertedSuffix(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dotIndex = path.lastIndexOf(".");
  const hasExtension = dotIndex > separatorIndex + 1;
  const stemEnd = hasExtension ? dotIndex : path.length;
  return `${path.slice(0, stemEnd)}_converted${path.slice(stemEnd)}`;
}

function getPlannedTargetPath(
  image: { file: { name: string }; sourcePath: string | null },
  options: ExportSafetyPlanOptions,
): string {
  const sourcePath = image.sourcePath?.trim() ?? "";
  const sourceName = sourcePath ? getPathFileName(sourcePath) : image.file.name;
  const outputName = replacePathExtension(sourceName, outputExtension(options.outputFormat));

  if (options.outputLocation === "original") {
    return sourcePath ? replacePathExtension(sourcePath, outputExtension(options.outputFormat)) : outputName;
  }

  if (options.outputLocation === "directory") {
    return joinPath(options.outputDirectory, outputName);
  }

  const sourceDirectory = getPathDirectory(sourcePath);
  const directory = options.outputLocation === "subfolder"
    ? joinPath(sourceDirectory, options.outputSubdirectory)
    : sourceDirectory;
  const targetPath = joinPath(directory, outputName);
  return options.outputLocation === "source"
    && !options.overwriteSameName
    && sourcePath
    && pathsMatch(targetPath, sourcePath)
    ? addConvertedSuffix(targetPath)
    : targetPath;
}

export function getExportSafetyPlan(
  images: ReadonlyArray<{ file: { name: string }; sourcePath: string | null }>,
  options: ExportSafetyPlanOptions,
): ExportSafetyPlan {
  const sourcePaths = images
    .map((image) => image.sourcePath?.trim() ?? "")
    .filter((path): path is string => Boolean(path));
  const isOriginalReplacement = options.outputLocation === "original";

  return {
    targetPaths: images.map((image) => getPlannedTargetPath(image, options)),
    sourcePathsToBackup: isOriginalReplacement ? sourcePaths : [],
    sourcePathsToDelete: options.deleteSource ? sourcePaths : [],
    overwriteMode: isOriginalReplacement ? "original" : options.overwriteSameName ? "same-name" : null,
  };
}

export function formatExportSafetyConfirmation(plan: ExportSafetyPlan): string | null {
  const requiresConfirmation = plan.overwriteMode !== null || plan.sourcePathsToDelete.length > 0;
  if (!requiresConfirmation) return null;

  const lines = ["导出前请确认以下文件操作："];
  if (plan.overwriteMode === "original") {
    lines.push("覆盖原图（原图会先移入同目录的 bak 文件夹）：");
  } else if (plan.overwriteMode === "same-name") {
    lines.push("覆盖同名文件（如果目标已存在，将直接替换）：");
  }
  if (plan.overwriteMode !== null || plan.sourcePathsToDelete.length > 0) {
    if (plan.overwriteMode === null) lines.push("目标文件（写入成功后保留）：");
    plan.targetPaths.forEach((path) => lines.push(`目标文件：${path}`));
  }
  if (plan.sourcePathsToBackup.length > 0) {
    lines.push("将备份以下源文件：");
    plan.sourcePathsToBackup.forEach((path) => lines.push(`源文件：${path}`));
  }
  if (plan.sourcePathsToDelete.length > 0) {
    lines.push("仅在对应导出成功后删除以下源文件：");
    plan.sourcePathsToDelete.forEach((path) => lines.push(`源文件：${path}`));
  }
  lines.push("取消不会开始导出，也不会修改或删除任何文件。是否继续？");
  return lines.join("\n");
}

export function getBatchExportStatus(completed: number, total: number, lastOutputPath: string | null) {
  if (completed < total) {
    return `已导出 ${completed}/${total} 张`;
  }
  if (completed > 1) {
    return `已导出 ${completed} 张图片${lastOutputPath ? `，最后一张：${lastOutputPath}` : ""}`;
  }
  return lastOutputPath ? `已导出到 ${lastOutputPath}` : "导出完成";
}
