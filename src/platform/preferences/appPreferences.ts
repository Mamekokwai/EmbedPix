import type {
  BmpBitDepth,
  ByteOrder,
  ChannelOrder,
  OutputFormat,
  RowAlignment,
  RowOrder,
} from "../../features/image-converter/types";

export type ThemeMode = "system" | "light" | "dark";
export type SidebarMode = "icon" | "labeled";
export type ImagePresetId = "high-quality" | "balanced" | "small-size" | "custom";

export interface ImageConverterDefaults {
  defaultOutputFormat: OutputFormat;
  defaultJpegQuality: number;
  defaultBitDepth: BmpBitDepth;
  defaultByteOrder: ByteOrder;
  defaultChannelOrder: ChannelOrder;
  defaultRowOrder: RowOrder;
  defaultRowAlignment: RowAlignment;
  defaultCArrayName: string;
  defaultBackgroundColor: string;
  keepAspectRatio: boolean;
}

export interface AppPreferences extends ImageConverterDefaults {
  themeMode: ThemeMode;
  sidebarMode: SidebarMode;
  imagePreset: ImagePresetId;
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  themeMode: "system",
  sidebarMode: "icon",
  defaultOutputFormat: "bmp",
  defaultJpegQuality: 85,
  defaultBitDepth: 24,
  defaultByteOrder: "little",
  defaultChannelOrder: "rgb",
  defaultRowOrder: "top-down",
  defaultRowAlignment: 1,
  defaultCArrayName: "image_data",
  defaultBackgroundColor: "#FFFFFF",
  keepAspectRatio: true,
  imagePreset: "balanced",
};

export const IMAGE_PRESET_OPTIONS: ReadonlyArray<{
  value: ImagePresetId;
  label: string;
  description: string;
}> = [
  { value: "high-quality", label: "高质量", description: "PNG 32 位、较高 JPEG 质量，优先保留画质。" },
  { value: "balanced", label: "平衡", description: "BMP 24 位与中等 JPEG 质量，适合日常转换。" },
  { value: "small-size", label: "小体积", description: "JPG 75 质量，优先降低资源占用。" },
  { value: "custom", label: "自定义", description: "单独调整参数后使用，不自动覆盖当前默认值。" },
];

export const IMAGE_PRESETS: Record<Exclude<ImagePresetId, "custom">, ImageConverterDefaults> = {
  "high-quality": {
    defaultOutputFormat: "png",
    defaultJpegQuality: 95,
    defaultBitDepth: 32,
    defaultByteOrder: "little",
    defaultChannelOrder: "rgb",
    defaultRowOrder: "top-down",
    defaultRowAlignment: 4,
    defaultCArrayName: "image_data",
    defaultBackgroundColor: "#FFFFFF",
    keepAspectRatio: true,
  },
  balanced: {
    defaultOutputFormat: "bmp",
    defaultJpegQuality: 85,
    defaultBitDepth: 24,
    defaultByteOrder: "little",
    defaultChannelOrder: "rgb",
    defaultRowOrder: "top-down",
    defaultRowAlignment: 2,
    defaultCArrayName: "image_data",
    defaultBackgroundColor: "#FFFFFF",
    keepAspectRatio: true,
  },
  "small-size": {
    defaultOutputFormat: "jpg",
    defaultJpegQuality: 75,
    defaultBitDepth: 24,
    defaultByteOrder: "little",
    defaultChannelOrder: "rgb",
    defaultRowOrder: "top-down",
    defaultRowAlignment: 1,
    defaultCArrayName: "image_data",
    defaultBackgroundColor: "#FFFFFF",
    keepAspectRatio: true,
  },
};

const STORAGE_KEY = "embedpix.app-preferences.v1";
const OUTPUT_FORMATS = new Set<OutputFormat>(["bmp", "png", "jpg", "rgb565", "c-array"]);
const IMAGE_PRESETS_SET = new Set<ImagePresetId>(["high-quality", "balanced", "small-size", "custom"]);
const BIT_DEPTHS = new Set<BmpBitDepth>([1, 4, 8, 16, 24, 32]);
const BYTE_ORDERS = new Set<ByteOrder>(["little", "big"]);
const CHANNEL_ORDERS = new Set<ChannelOrder>(["rgb", "bgr"]);
const ROW_ORDERS = new Set<RowOrder>(["top-down", "bottom-up"]);
const ROW_ALIGNMENTS = new Set<RowAlignment>([1, 2, 4]);

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function isSidebarMode(value: unknown): value is SidebarMode {
  return value === "icon" || value === "labeled";
}

function isImagePresetId(value: unknown): value is ImagePresetId {
  return typeof value === "string" && IMAGE_PRESETS_SET.has(value as ImagePresetId);
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9A-F]{6}$/iu.test(value);
}

function parseStoredPreferences(value: string | null): Partial<AppPreferences> {
  if (!value) return {};

  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    return {
      ...(isThemeMode(record.themeMode) ? { themeMode: record.themeMode } : {}),
      ...(isSidebarMode(record.sidebarMode) ? { sidebarMode: record.sidebarMode } : {}),
      ...(typeof record.defaultOutputFormat === "string" && OUTPUT_FORMATS.has(record.defaultOutputFormat as OutputFormat)
        ? { defaultOutputFormat: record.defaultOutputFormat as OutputFormat }
        : {}),
      ...(typeof record.defaultJpegQuality === "number" && Number.isInteger(record.defaultJpegQuality) && record.defaultJpegQuality >= 1 && record.defaultJpegQuality <= 100
        ? { defaultJpegQuality: record.defaultJpegQuality }
        : {}),
      ...(typeof record.defaultBitDepth === "number" && BIT_DEPTHS.has(record.defaultBitDepth as BmpBitDepth)
        ? { defaultBitDepth: record.defaultBitDepth as BmpBitDepth }
        : {}),
      ...(typeof record.defaultByteOrder === "string" && BYTE_ORDERS.has(record.defaultByteOrder as ByteOrder)
        ? { defaultByteOrder: record.defaultByteOrder as ByteOrder }
        : {}),
      ...(typeof record.defaultChannelOrder === "string" && CHANNEL_ORDERS.has(record.defaultChannelOrder as ChannelOrder)
        ? { defaultChannelOrder: record.defaultChannelOrder as ChannelOrder }
        : {}),
      ...(typeof record.defaultRowOrder === "string" && ROW_ORDERS.has(record.defaultRowOrder as RowOrder)
        ? { defaultRowOrder: record.defaultRowOrder as RowOrder }
        : {}),
      ...(typeof record.defaultRowAlignment === "number" && ROW_ALIGNMENTS.has(record.defaultRowAlignment as RowAlignment)
        ? { defaultRowAlignment: record.defaultRowAlignment as RowAlignment }
        : {}),
      ...(typeof record.defaultCArrayName === "string" && record.defaultCArrayName.trim().length > 0 && record.defaultCArrayName.length <= 128
        ? { defaultCArrayName: record.defaultCArrayName }
        : {}),
      ...(isHexColor(record.defaultBackgroundColor)
        ? { defaultBackgroundColor: record.defaultBackgroundColor.toUpperCase() }
        : {}),
      ...(typeof record.keepAspectRatio === "boolean" ? { keepAspectRatio: record.keepAspectRatio } : {}),
      ...(isImagePresetId(record.imagePreset) ? { imagePreset: record.imagePreset } : {}),
    };
  } catch {
    return {};
  }
}

export function loadAppPreferences(storage: Pick<Storage, "getItem"> = localStorage): AppPreferences {
  return { ...DEFAULT_APP_PREFERENCES, ...parseStoredPreferences(storage.getItem(STORAGE_KEY)) };
}

export function saveAppPreferences(
  preferences: AppPreferences,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences are optional; a locked-down WebView must not break conversion.
  }
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): "light" | "dark" {
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}
