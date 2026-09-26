import type { GifMakerPreferences } from "./gifMakerPreferences";

export const GIF_CUSTOM_PRESETS_STORAGE_KEY = "embedpix.gif-custom-presets.v1";
const SCHEMA_VERSION = 1;
export interface GifCustomPreset { id: string; name: string; values: GifMakerPreferences; createdAt: string; }

function isPreset(value: unknown): value is GifCustomPreset {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.name === "string" && record.name.trim().length > 0
    && typeof record.createdAt === "string" && !!record.values && typeof record.values === "object";
}

export function loadGifCustomPresets(storage: Pick<Storage, "getItem"> = localStorage): GifCustomPreset[] {
  try {
    const record = JSON.parse(storage.getItem(GIF_CUSTOM_PRESETS_STORAGE_KEY) ?? "null") as { version?: number; presets?: unknown } | null;
    return record?.version === SCHEMA_VERSION && Array.isArray(record.presets) ? record.presets.filter(isPreset) : [];
  } catch { return []; }
}

export function saveGifCustomPresets(presets: GifCustomPreset[], storage: Pick<Storage, "setItem"> = localStorage): void {
  try { storage.setItem(GIF_CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, presets })); } catch { /* Optional local feature. */ }
}

export function createGifCustomPreset(name: string, values: GifMakerPreferences): GifCustomPreset {
  return { id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: name.trim(), values, createdAt: new Date().toISOString() };
}

export function exportGifPresetsJson(presets: GifCustomPreset[]): string { return JSON.stringify({ version: SCHEMA_VERSION, presets }, null, 2); }
export function importGifPresetsJson(value: string): GifCustomPreset[] {
  const parsed = JSON.parse(value) as { version?: number; presets?: unknown } | null;
  if (parsed?.version !== SCHEMA_VERSION || !Array.isArray(parsed.presets)) throw new Error("GIF 预设文件版本不兼容或格式无效。");
  const presets = parsed.presets.filter(isPreset);
  if (presets.length !== parsed.presets.length) throw new Error("GIF 预设文件包含无效项目。");
  return presets;
}
