import type { ImageConverterDefaults } from "../../platform/preferences/appPreferences";

export const IMAGE_CUSTOM_PRESETS_STORAGE_KEY = "embedpix.image-presets.v1";
const SCHEMA_VERSION = 1;

export interface ImageCustomPreset {
  id: string;
  name: string;
  values: ImageConverterDefaults;
  createdAt: string;
}

interface StoredImagePresets {
  version: number;
  presets: ImageCustomPreset[];
}

function isPreset(value: unknown): value is ImageCustomPreset {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const values = record.values;
  return typeof record.id === "string" && typeof record.name === "string" && record.name.trim().length > 0
    && typeof record.createdAt === "string" && !!values && typeof values === "object"
    && typeof (values as Record<string, unknown>).defaultOutputFormat === "string";
}

export function loadImageCustomPresets(storage: Pick<Storage, "getItem"> = localStorage): ImageCustomPreset[] {
  try {
    const parsed = JSON.parse(storage.getItem(IMAGE_CUSTOM_PRESETS_STORAGE_KEY) ?? "null") as Partial<StoredImagePresets> | null;
    return parsed?.version === SCHEMA_VERSION && Array.isArray(parsed.presets)
      ? parsed.presets.filter(isPreset)
      : [];
  } catch {
    return [];
  }
}

export function saveImageCustomPresets(presets: ImageCustomPreset[], storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(IMAGE_CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, presets } satisfies StoredImagePresets));
  } catch {
    // Local presets are optional and must not prevent the settings page from working.
  }
}

export function createImageCustomPreset(name: string, values: ImageConverterDefaults): ImageCustomPreset {
  return { id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: name.trim(), values, createdAt: new Date().toISOString() };
}

export function exportImagePresetsJson(presets: ImageCustomPreset[]): string {
  return JSON.stringify({ version: SCHEMA_VERSION, presets }, null, 2);
}

export function importImagePresetsJson(value: string): ImageCustomPreset[] {
  const parsed = JSON.parse(value) as Partial<StoredImagePresets> | null;
  if (parsed?.version !== SCHEMA_VERSION || !Array.isArray(parsed.presets)) throw new Error("图片预设文件版本不兼容或格式无效。");
  const presets = parsed.presets.filter(isPreset);
  if (presets.length !== parsed.presets.length) throw new Error("图片预设文件包含无效项目。");
  return presets;
}
