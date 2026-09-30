import { COMPRESSION_MAX_CANDIDATES_DEFAULT, COMPRESSION_MAX_CANDIDATES_MAX, COMPRESSION_MAX_CANDIDATES_MIN, COMPRESSION_WEBP_METHOD_DEFAULT, COMPRESSION_WEBP_METHOD_MAX, COMPRESSION_WEBP_METHOD_MIN, supportsCompressionTargetSize } from "./imageCompressionLogic";
import type { CompressionFormat, MetadataPolicy } from "./types";

export const COMPRESSION_CUSTOM_PRESETS_STORAGE_KEY = "embedpix.image-compression-custom-presets.v1";
export const COMPRESSION_CUSTOM_PRESETS_SCHEMA = "embedpix.compression-presets";
export const COMPRESSION_CUSTOM_PRESETS_VERSION = 1;
const MAX_PRESET_NAME_LENGTH = 80;

export interface CompressionPresetValues {
  format: CompressionFormat;
  quality: number;
  webpMethod: number;
  webpAlphaQuality: number;
  webpPass: number;
  webpNearLossless: number | null;
  jpegBackground: string;
  pngOptimizationLevel: number;
  targetSizeEnabled: boolean;
  targetSizeKiB: string;
  maxCandidates: number;
  maxInputMiB: number;
  skipIfLarger: boolean;
  lossless: boolean;
  metadataPolicy: MetadataPolicy;
}

export interface CompressionCustomPreset {
  id: string;
  name: string;
  values: CompressionPresetValues;
  createdAt: string;
}

type PresetStorage = Pick<Storage, "getItem" | "setItem">;

function recordFrom(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function presetName(value: unknown, index: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_PRESET_NAME_LENGTH) {
    throw new Error(`第 ${index + 1} 个压缩预设名称无效。`);
  }
  return value.trim();
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string, index: number): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`第 ${index + 1} 个压缩预设的${label}无效。`);
  return value as T;
}

function integerValue(value: unknown, min: number, max: number, label: string, index: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`第 ${index + 1} 个压缩预设的${label}无效。`);
  return value;
}

function booleanValue(value: unknown, label: string, index: number): boolean {
  if (typeof value !== "boolean") throw new Error(`第 ${index + 1} 个压缩预设的${label}无效。`);
  return value;
}

function targetSizeValue(value: unknown, index: number): string {
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d+)?)?$/u.test(value.trim())) throw new Error(`第 ${index + 1} 个压缩预设的目标体积无效。`);
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 128 * 1024) throw new Error(`第 ${index + 1} 个压缩预设的目标体积无效。`);
  return trimmed;
}

function webpNearLosslessValue(value: unknown, index: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 99) throw new Error(`第 ${index + 1} 个压缩预设的 WebP 近无损等级无效。`);
  return value;
}

function jpegBackgroundValue(value: unknown, index: number): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value.trim())) throw new Error(`第 ${index + 1} 个压缩预设的 JPEG 透明背景无效。`);
  return value.trim().toLowerCase();
}

function parseValues(value: unknown, index: number): CompressionPresetValues {
  const record = recordFrom(value);
  if (!record) throw new Error(`第 ${index + 1} 个压缩预设参数格式无效。`);
  const format = enumValue(record.format, ["jpg", "webp", "png"], "输出格式", index);
  const lossless = booleanValue(record.lossless, "无损选项", index);
  if ((format === "png" && !lossless) || (format === "jpg" && lossless)) throw new Error(`第 ${index + 1} 个压缩预设的无损选项与格式不匹配。`);
  const targetSizeEnabled = booleanValue(record.targetSizeEnabled, "目标体积开关", index);
  if (targetSizeEnabled && !supportsCompressionTargetSize(format, lossless)) throw new Error(`第 ${index + 1} 个压缩预设的目标体积不适用于当前格式。`);
  const webpNearLossless = webpNearLosslessValue(record.webpNearLossless, index);
  if (webpNearLossless !== null && (format !== "webp" || !lossless)) throw new Error(`第 ${index + 1} 个压缩预设的 WebP 近无损等级仅适用于无损 WebP。`);
  const jpegBackground = record.jpegBackground === undefined ? "#ffffff" : jpegBackgroundValue(record.jpegBackground, index);
  return {
    format,
    quality: integerValue(record.quality, 1, 100, "质量", index),
    webpMethod: record.webpMethod === undefined ? COMPRESSION_WEBP_METHOD_DEFAULT : integerValue(record.webpMethod, COMPRESSION_WEBP_METHOD_MIN, COMPRESSION_WEBP_METHOD_MAX, "WebP 编码方法", index),
    webpAlphaQuality: record.webpAlphaQuality === undefined ? 100 : integerValue(record.webpAlphaQuality, 0, 100, "WebP Alpha 质量", index),
    webpPass: record.webpPass === undefined ? 1 : integerValue(record.webpPass, 1, 10, "WebP 分析遍数", index),
    webpNearLossless,
    jpegBackground,
    pngOptimizationLevel: integerValue(record.pngOptimizationLevel, 0, 6, "PNG 优化级别", index),
    targetSizeEnabled,
    targetSizeKiB: targetSizeValue(record.targetSizeKiB, index),
    maxCandidates: record.maxCandidates === undefined ? COMPRESSION_MAX_CANDIDATES_DEFAULT : integerValue(record.maxCandidates, COMPRESSION_MAX_CANDIDATES_MIN, COMPRESSION_MAX_CANDIDATES_MAX, "候选搜索次数", index),
    maxInputMiB: record.maxInputMiB === undefined ? 32 : integerValue(record.maxInputMiB, 1, 32, "单文件输入上限", index),
    skipIfLarger: record.skipIfLarger === undefined ? true : booleanValue(record.skipIfLarger, "压缩后更大时跳过", index),
    lossless,
    metadataPolicy: enumValue(record.metadataPolicy, ["strip", "strip-all"], "元数据策略", index),
  };
}

function createId(): string {
  return `compression-custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createCompressionCustomPreset(name: string, values: CompressionPresetValues): CompressionCustomPreset {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length > MAX_PRESET_NAME_LENGTH) throw new Error("压缩预设名称不能为空且不能超过 80 个字符。");
  if (!Number.isInteger(values.webpMethod) || values.webpMethod < COMPRESSION_WEBP_METHOD_MIN || values.webpMethod > COMPRESSION_WEBP_METHOD_MAX) throw new Error("WebP 编码方法必须在 0 到 6 之间。");
  if (!Number.isInteger(values.webpAlphaQuality) || values.webpAlphaQuality < 0 || values.webpAlphaQuality > 100) throw new Error("WebP Alpha 质量必须在 0 到 100 之间。");
  if (!Number.isInteger(values.webpPass) || values.webpPass < 1 || values.webpPass > 10) throw new Error("WebP 分析遍数必须在 1 到 10 之间。");
  if (values.webpNearLossless !== null && (!Number.isInteger(values.webpNearLossless) || values.webpNearLossless < 1 || values.webpNearLossless > 99)) throw new Error("WebP 近无损等级必须在 1 到 99 之间。");
  if (values.webpNearLossless !== null && (values.format !== "webp" || !values.lossless)) throw new Error("WebP 近无损等级仅适用于无损 WebP。");
  if (!/^#[0-9a-f]{6}$/iu.test(values.jpegBackground.trim())) throw new Error("JPEG 透明背景必须是 #RRGGBB 颜色。");
  if (!Number.isInteger(values.maxCandidates) || values.maxCandidates < COMPRESSION_MAX_CANDIDATES_MIN || values.maxCandidates > COMPRESSION_MAX_CANDIDATES_MAX) throw new Error(`候选搜索次数必须在 ${COMPRESSION_MAX_CANDIDATES_MIN} 到 ${COMPRESSION_MAX_CANDIDATES_MAX} 之间。`);
  if (!Number.isInteger(values.maxInputMiB) || values.maxInputMiB < 1 || values.maxInputMiB > 32) throw new Error("单文件输入上限必须在 1 到 32 MiB 之间。");
  return { id: createId(), name: trimmedName, values: { ...values }, createdAt: new Date().toISOString() };
}

function serializedPresets(presets: readonly CompressionCustomPreset[]) {
  return presets.map(({ name, values }) => ({ name, values: { ...values } }));
}

export function exportCompressionPresetsJson(presets: readonly CompressionCustomPreset[]): string {
  return JSON.stringify({ schema: COMPRESSION_CUSTOM_PRESETS_SCHEMA, version: COMPRESSION_CUSTOM_PRESETS_VERSION, presets: serializedPresets(presets) }, null, 2);
}

export function importCompressionPresetsJson(serialized: string): CompressionCustomPreset[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("压缩预设 JSON 格式无效。");
  }
  const document = recordFrom(parsed);
  if (document?.schema !== COMPRESSION_CUSTOM_PRESETS_SCHEMA || document.version !== COMPRESSION_CUSTOM_PRESETS_VERSION || !Array.isArray(document.presets)) throw new Error("压缩预设文件版本不兼容或格式无效。");
  return document.presets.map((entry, index) => {
    const record = recordFrom(entry);
    if (!record) throw new Error(`第 ${index + 1} 个压缩预设格式无效。`);
    return createCompressionCustomPreset(presetName(record.name, index), parseValues(record.values, index));
  });
}

function presetNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function uniqueName(name: string, used: Set<string>): string {
  const base = name.trim();
  let candidate = base;
  let suffix = 2;
  while (used.has(presetNameKey(candidate))) candidate = `${base} (${suffix++})`;
  used.add(presetNameKey(candidate));
  return candidate;
}

export function mergeCompressionCustomPresets(existing: readonly CompressionCustomPreset[], incoming: readonly CompressionCustomPreset[]): CompressionCustomPreset[] {
  const used = new Set(existing.map((preset) => presetNameKey(preset.name)));
  return [...existing, ...incoming.map((preset) => createCompressionCustomPreset(uniqueName(preset.name, used), preset.values))];
}

export function loadCompressionCustomPresets(storage: PresetStorage | undefined = typeof localStorage === "undefined" ? undefined : localStorage): CompressionCustomPreset[] {
  if (!storage) return [];
  try {
    return importCompressionPresetsJson(storage.getItem(COMPRESSION_CUSTOM_PRESETS_STORAGE_KEY) ?? "");
  } catch {
    return [];
  }
}

export function saveCompressionCustomPresets(presets: readonly CompressionCustomPreset[], storage: PresetStorage | undefined = typeof localStorage === "undefined" ? undefined : localStorage): void {
  if (!storage) return;
  try {
    storage.setItem(COMPRESSION_CUSTOM_PRESETS_STORAGE_KEY, exportCompressionPresetsJson(presets));
  } catch {
    // Optional local storage must not prevent the compression workspace from working.
  }
}
