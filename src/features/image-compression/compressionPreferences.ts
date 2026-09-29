import { COMPRESSION_MAX_CANDIDATES_DEFAULT, COMPRESSION_MAX_CANDIDATES_MAX, COMPRESSION_MAX_CANDIDATES_MIN, COMPRESSION_WEBP_METHOD_DEFAULT, COMPRESSION_WEBP_METHOD_MAX, COMPRESSION_WEBP_METHOD_MIN, getCompressionOutputFileNameError, getCompressionSubdirectoryError, normalizeCompressionOutputFileName, supportsCompressionTargetSize } from "./imageCompressionLogic";
import type { CompressionFormat, CompressionOutputLocation, CompressionPreset, MetadataPolicy } from "./types";

export interface CompressionPreferences {
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
  skipIfLarger: boolean;
  lossless: boolean;
  preset: CompressionPreset;
  metadataPolicy: MetadataPolicy;
  outputLocation: CompressionOutputLocation;
  outputFileName: string;
  outputSubdirectory: string;
  overwrite: boolean;
  autoNumbering: boolean;
  replaceOriginal: boolean;
  deleteSource: boolean;
}

export const COMPRESSION_PREFERENCES_STORAGE_KEY = "embedpix.image-compression-preferences.v1";
export const COMPRESSION_PREFERENCES_VERSION = 3;
const LEGACY_COMPRESSION_PREFERENCES_VERSIONS = new Set([1, 2, 3]);
export const COMPRESSION_MAX_TARGET_SIZE_KIB = 128 * 1024;

export const DEFAULT_COMPRESSION_PREFERENCES: CompressionPreferences = {
  format: "webp",
  quality: 82,
  webpMethod: COMPRESSION_WEBP_METHOD_DEFAULT,
  webpAlphaQuality: 100,
  webpPass: 1,
  webpNearLossless: null,
  jpegBackground: "#ffffff",
  pngOptimizationLevel: 3,
  targetSizeEnabled: false,
  targetSizeKiB: "",
  maxCandidates: COMPRESSION_MAX_CANDIDATES_DEFAULT,
  skipIfLarger: true,
  lossless: true,
  preset: "balanced",
  metadataPolicy: "strip",
  outputLocation: "source",
  outputFileName: "",
  outputSubdirectory: "",
  overwrite: false,
  autoNumbering: false,
  replaceOriginal: false,
  deleteSource: false,
};

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const FORMATS = new Set<CompressionFormat>(["jpg", "webp", "png"]);
const PRESETS = new Set<CompressionPreset>(["high-quality", "balanced", "small-size", "custom"]);
const METADATA_POLICIES = new Set<MetadataPolicy>(["strip"]);
const OUTPUT_LOCATIONS = new Set<CompressionOutputLocation>(["source", "subfolder", "directory"]);

function fallbackPreferences(): CompressionPreferences {
  return { ...DEFAULT_COMPRESSION_PREFERENCES };
}

function resolveStorage(): PreferenceStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function enumValue<T extends string>(record: Record<string, unknown>, key: string, values: ReadonlySet<T>, fallback: T): T {
  const value = record[key];
  return values.has(value as T) ? value as T : fallback;
}

function integerValue(record: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function webpMethodValue(record: Record<string, unknown>): number {
  const value = record.webpMethod;
  return typeof value === "number" && Number.isInteger(value) && value >= COMPRESSION_WEBP_METHOD_MIN && value <= COMPRESSION_WEBP_METHOD_MAX
    ? value
    : DEFAULT_COMPRESSION_PREFERENCES.webpMethod;
}

function webpAlphaQualityValue(record: Record<string, unknown>): number {
  return integerValue(record, "webpAlphaQuality", 0, 100, DEFAULT_COMPRESSION_PREFERENCES.webpAlphaQuality);
}

function webpPassValue(record: Record<string, unknown>): number {
  return integerValue(record, "webpPass", 1, 10, DEFAULT_COMPRESSION_PREFERENCES.webpPass);
}

function webpNearLosslessValue(record: Record<string, unknown>): number | null {
  const value = record.webpNearLossless;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 99 ? value : null;
}

function jpegBackgroundValue(record: Record<string, unknown>): string {
  const value = record.jpegBackground;
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value.trim()) ? value.trim().toLowerCase() : DEFAULT_COMPRESSION_PREFERENCES.jpegBackground;
}

function sizeInputValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || !/^\d+(?:\.\d+)?$/u.test(trimmed)) return "";
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= COMPRESSION_MAX_TARGET_SIZE_KIB ? trimmed.slice(0, 32) : "";
}

function subdirectoryValue(record: Record<string, unknown>): string {
  const value = record.outputSubdirectory;
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return !trimmed || getCompressionSubdirectoryError(trimmed) ? "" : trimmed.slice(0, 255);
}

function outputFileNameValue(record: Record<string, unknown>, format: CompressionFormat): string {
  const value = record.outputFileName;
  if (typeof value !== "string" || !value || getCompressionOutputFileNameError(value, format)) return "";
  return normalizeCompressionOutputFileName(value, format) ?? "";
}

function parsePreferences(value: string | null): CompressionPreferences {
  if (!value) return fallbackPreferences();
  try {
    const record = recordFrom(JSON.parse(value));
    if (!record || !LEGACY_COMPRESSION_PREFERENCES_VERSIONS.has(record.version as number)) return fallbackPreferences();
    const format = enumValue(record, "format", FORMATS, DEFAULT_COMPRESSION_PREFERENCES.format);
    const lossless = format === "png" ? true : format === "jpg" ? false : typeof record.lossless === "boolean" ? record.lossless : DEFAULT_COMPRESSION_PREFERENCES.lossless;
    return {
      format,
      quality: integerValue(record, "quality", 1, 100, DEFAULT_COMPRESSION_PREFERENCES.quality),
      webpMethod: webpMethodValue(record),
      webpAlphaQuality: webpAlphaQualityValue(record),
      webpPass: webpPassValue(record),
      webpNearLossless: format === "webp" && lossless ? webpNearLosslessValue(record) : null,
      jpegBackground: jpegBackgroundValue(record),
      pngOptimizationLevel: integerValue(record, "pngOptimizationLevel", 0, 6, DEFAULT_COMPRESSION_PREFERENCES.pngOptimizationLevel),
      targetSizeEnabled: record.targetSizeEnabled === true && supportsCompressionTargetSize(format, lossless),
      targetSizeKiB: sizeInputValue(record, "targetSizeKiB"),
      maxCandidates: integerValue(record, "maxCandidates", COMPRESSION_MAX_CANDIDATES_MIN, COMPRESSION_MAX_CANDIDATES_MAX, COMPRESSION_MAX_CANDIDATES_DEFAULT),
      skipIfLarger: typeof record.skipIfLarger === "boolean" ? record.skipIfLarger : DEFAULT_COMPRESSION_PREFERENCES.skipIfLarger,
      lossless,
      preset: enumValue(record, "preset", PRESETS, DEFAULT_COMPRESSION_PREFERENCES.preset),
      metadataPolicy: enumValue(record, "metadataPolicy", METADATA_POLICIES, DEFAULT_COMPRESSION_PREFERENCES.metadataPolicy),
      outputLocation: enumValue(record, "outputLocation", OUTPUT_LOCATIONS, DEFAULT_COMPRESSION_PREFERENCES.outputLocation),
      outputFileName: outputFileNameValue(record, format),
      outputSubdirectory: subdirectoryValue(record),
      overwrite: typeof record.overwrite === "boolean" ? record.overwrite : DEFAULT_COMPRESSION_PREFERENCES.overwrite,
      autoNumbering: typeof record.autoNumbering === "boolean" ? record.autoNumbering : DEFAULT_COMPRESSION_PREFERENCES.autoNumbering,
      replaceOriginal: typeof record.replaceOriginal === "boolean" ? record.replaceOriginal : DEFAULT_COMPRESSION_PREFERENCES.replaceOriginal,
      deleteSource: typeof record.deleteSource === "boolean" ? record.deleteSource : DEFAULT_COMPRESSION_PREFERENCES.deleteSource,
    };
  } catch {
    return fallbackPreferences();
  }
}

export function loadCompressionPreferences(storage: PreferenceStorage | undefined = resolveStorage()): CompressionPreferences {
  if (!storage) return fallbackPreferences();
  try {
    return parsePreferences(storage.getItem(COMPRESSION_PREFERENCES_STORAGE_KEY));
  } catch {
    return fallbackPreferences();
  }
}

export function saveCompressionPreferences(
  preferences: CompressionPreferences,
  storage: PreferenceStorage | undefined = resolveStorage(),
): void {
  if (!storage) return;
  try {
    const outputFileName = getCompressionOutputFileNameError(preferences.outputFileName, preferences.format) ? "" : normalizeCompressionOutputFileName(preferences.outputFileName, preferences.format) ?? "";
    storage.setItem(COMPRESSION_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: COMPRESSION_PREFERENCES_VERSION,
      format: preferences.format,
      quality: preferences.quality,
      webpMethod: preferences.webpMethod,
      webpAlphaQuality: preferences.webpAlphaQuality,
      webpPass: preferences.webpPass,
      webpNearLossless: preferences.webpNearLossless,
      jpegBackground: preferences.jpegBackground,
      pngOptimizationLevel: preferences.pngOptimizationLevel,
      targetSizeEnabled: preferences.targetSizeEnabled,
      targetSizeKiB: preferences.targetSizeKiB,
      maxCandidates: preferences.maxCandidates,
      skipIfLarger: preferences.skipIfLarger,
      lossless: preferences.lossless,
      preset: preferences.preset,
      metadataPolicy: preferences.metadataPolicy,
      outputLocation: preferences.outputLocation,
      outputFileName,
      outputSubdirectory: preferences.outputSubdirectory,
      overwrite: preferences.overwrite,
      autoNumbering: preferences.autoNumbering,
      replaceOriginal: preferences.replaceOriginal,
      deleteSource: preferences.deleteSource,
    }));
  } catch {
    // Preferences are optional; a locked-down WebView must not break compression.
  }
}
