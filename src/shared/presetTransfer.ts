import type { ImageCustomPreset } from "../features/image-converter/imagePresets";
import type { GifCustomPreset } from "../features/gif-maker/gifCustomPresets";
import type { ImageConverterDefaults } from "../platform/preferences/appPreferences";
import type { GifMakerPreferences } from "../features/gif-maker/gifMakerPreferences";

export const PRESET_TRANSFER_SCHEMA = "embedpix.preset-transfer" as const;
export const PRESET_TRANSFER_VERSION = 1 as const;
type TransferPreset = { type: "image"; preset: ImageCustomPreset } | { type: "gif"; preset: GifCustomPreset };
export interface PresetTransferBundle { schema: typeof PRESET_TRANSFER_SCHEMA; version: typeof PRESET_TRANSFER_VERSION; presets: TransferPreset[]; }
export type DuplicatePresetStrategy = "skip" | "replace" | "rename";

const IMAGE_KEYS = ["defaultOutputFormat", "defaultJpegQuality", "defaultBitDepth", "defaultByteOrder", "defaultChannelOrder", "defaultRowOrder", "defaultRowAlignment", "defaultCArrayName", "defaultBackgroundColor", "keepAspectRatio"] as const;
const GIF_KEYS = ["canvasPreset", "canvasWidth", "canvasHeight", "keepAspectRatio", "fitMode", "contentAlignment", "contentMargins", "globalDuration", "batchDuration", "firstFrameHoldDuration", "lastFrameHoldDuration", "playbackSpeed", "background", "customBackgroundColor", "loopMode", "loopCount", "encodingQuality", "colorCount", "ditherMode", "gifPreset", "targetSizeKiB", "maxSizeKiB", "autoCompress", "mergeIdenticalFrames", "overwriteExisting", "outputFormat", "videoFps", "videoEveryNthFrame", "videoMaxFrames", "videoCropPreset", "videoRotation", "videoReverse"] as const;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} contains unsupported fields`);
}
function range(value: unknown, min: number, max: number, label: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label} is out of range`);
}
function validateImage(values: Record<string, unknown>): ImageConverterDefaults {
  exactKeys(values, IMAGE_KEYS, "image preset values");
  if (!["bmp", "png", "jpg", "webp", "tiff", "ico", "rgb565", "c-array"].includes(values.defaultOutputFormat as string)) throw new Error("image output format is invalid");
  range(values.defaultJpegQuality, 1, 100, "JPEG quality"); range(values.defaultBitDepth, 1, 32, "bit depth");
  if (!["little", "big"].includes(values.defaultByteOrder as string) || !["rgb", "bgr"].includes(values.defaultChannelOrder as string) || !["top-down", "bottom-up"].includes(values.defaultRowOrder as string) || ![1, 2, 4].includes(values.defaultRowAlignment as number)) throw new Error("image ordering values are invalid");
  if (typeof values.defaultCArrayName !== "string" || !values.defaultCArrayName || typeof values.defaultBackgroundColor !== "string" || !/^#[0-9a-f]{6}$/iu.test(values.defaultBackgroundColor) || typeof values.keepAspectRatio !== "boolean") throw new Error("image preset values are invalid");
  return values as unknown as ImageConverterDefaults;
}
function imageTransferValues(values: ImageConverterDefaults): ImageConverterDefaults {
  const record = values as unknown as Record<string, unknown>;
  return Object.fromEntries(IMAGE_KEYS.map((key) => [key, record[key]])) as unknown as ImageConverterDefaults;
}
function validateGif(values: Record<string, unknown>): GifMakerPreferences {
  exactKeys(values, GIF_KEYS, "GIF preset values");
  for (const key of ["canvasWidth", "canvasHeight"] as const) range(values[key], 1, 4096, key);
  for (const key of ["globalDuration", "batchDuration"] as const) range(values[key], 10, 60000, key);
  for (const key of ["firstFrameHoldDuration", "lastFrameHoldDuration"] as const) range(values[key], 0, 60000, key);
  for (const key of ["loopCount", "videoEveryNthFrame", "videoMaxFrames"] as const) range(values[key], 1, 65535, key);
  range(values.videoFps, 1, 30, "videoFps"); range(values.colorCount, 2, 256, "colorCount");
  if (typeof values.contentMargins !== "object" || typeof values.keepAspectRatio !== "boolean" || typeof values.autoCompress !== "boolean" || typeof values.mergeIdenticalFrames !== "boolean" || typeof values.overwriteExisting !== "boolean") throw new Error("GIF preset values are invalid");
  return values as unknown as GifMakerPreferences;
}

export function exportPresetBundle(imagePresets: readonly ImageCustomPreset[] = [], gifPresets: readonly GifCustomPreset[] = []): string {
  const presets: TransferPreset[] = [
    ...imagePresets.map((preset) => ({ type: "image" as const, preset: { ...preset, values: validateImage(imageTransferValues(preset.values) as unknown as Record<string, unknown>) } })),
    ...gifPresets.map((preset) => ({ type: "gif" as const, preset: { ...preset, values: validateGif(object(preset.values as unknown, "GIF preset values")) } })),
  ];
  return JSON.stringify({ schema: PRESET_TRANSFER_SCHEMA, version: PRESET_TRANSFER_VERSION, presets } satisfies PresetTransferBundle);
}

export function importPresetBundle(serialized: string): { image: ImageCustomPreset[]; gif: GifCustomPreset[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { throw new Error("preset file is not valid JSON"); }
  const record = object(parsed, "preset bundle");
  if (record.schema !== PRESET_TRANSFER_SCHEMA || record.version !== PRESET_TRANSFER_VERSION || !Array.isArray(record.presets)) throw new Error("unsupported preset schema or version");
  const image: ImageCustomPreset[] = []; const gif: GifCustomPreset[] = [];
  for (const entry of record.presets) {
    const item = object(entry, "preset entry"); const preset = object(item.preset, "preset");
    if (item.type === "image") image.push({ id: String(preset.id), name: String(preset.name), createdAt: String(preset.createdAt), values: validateImage(object(preset.values, "image preset values")) });
    else if (item.type === "gif") gif.push({ id: String(preset.id), name: String(preset.name), createdAt: String(preset.createdAt), values: validateGif(object(preset.values, "GIF preset values")) });
    else throw new Error("preset type is invalid");
  }
  return { image, gif };
}

export function formatPresetTransferError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const mappings: ReadonlyArray<readonly [string, string]> = [
    ["preset file is not valid JSON", "预设文件不是有效的 JSON"],
    ["unsupported preset schema or version", "不支持的预设结构或版本"],
    ["must be an object", "必须是对象"],
    ["contains unsupported fields", "包含不支持的字段"],
    ["is out of range", "超出有效范围"],
    ["image output format is invalid", "图片输出格式无效"],
    ["image ordering values are invalid", "图片排序参数无效"],
    ["image preset values are invalid", "图片预设参数无效"],
    ["GIF preset values are invalid", "GIF 预设参数无效"],
    ["preset type is invalid", "预设类型无效"],
  ];
  for (const [prefix, label] of mappings) {
    const index = message.indexOf(prefix);
    if (index < 0) continue;
    const suffix = message.slice(index + prefix.length);
    return `${message.slice(0, index)}${label}${suffix.startsWith(":") ? `：${suffix.slice(1).trim()}` : suffix}`;
  }
  return message || "预设导入失败，请重试。";
}

export function mergeImportedPresets<T extends { id: string; name: string }>(existing: readonly T[], incoming: readonly T[], strategy: DuplicatePresetStrategy): T[] {
  const result = [...existing];
  for (const item of incoming) {
    const same = result.findIndex((value) => value.name.trim().toLocaleLowerCase() === item.name.trim().toLocaleLowerCase());
    if (same < 0) { result.push(item); continue; }
    if (strategy === "skip") continue;
    if (strategy === "replace") { result[same] = item; continue; }
    let suffix = 2; let name = `${item.name} (${suffix})`;
    while (result.some((value) => value.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) name = `${item.name} (${++suffix})`;
    result.push({ ...item, id: `${item.id}-${suffix}`, name });
  }
  return result;
}
