import type { BmpBitDepth, ImageDimensions, OutputFormat, RowAlignment } from "./types";

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
  { value: "bmp", label: "BMP", hint: "1–32 位", description: "支持 1、4、8、16、24、32 位；仅 32 位保留透明度。" },
  { value: "png", label: "PNG", hint: "24 / 32 位", description: "24 位不含透明度；32 位保留透明度，适合无损资源。" },
  { value: "jpg", label: "JPG", hint: "24 位 · 有损", description: "固定 24 位，不支持透明度；透明区域使用背景色。" },
  { value: "rgb565", label: "RGB565 BIN", hint: "16 位 · 原始", description: "输出适合 MCU 屏幕的 RGB565 原始二进制数据。" },
  { value: "c-array", label: "C 数组", hint: "RGB565 · 源码", description: "输出可直接加入固件工程的 RGB565 C 数组源码。" },
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
