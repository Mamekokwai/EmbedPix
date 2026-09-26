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
