import type { OutputFormat } from "../../features/image-converter/types";

export type ThemeMode = "system" | "light" | "dark";

export interface AppPreferences {
  themeMode: ThemeMode;
  defaultOutputFormat: OutputFormat;
  defaultJpegQuality: number;
  keepAspectRatio: boolean;
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  themeMode: "system",
  defaultOutputFormat: "bmp",
  defaultJpegQuality: 85,
  keepAspectRatio: true,
};

const STORAGE_KEY = "embedpix.app-preferences.v1";
const OUTPUT_FORMATS = new Set<OutputFormat>(["bmp", "png", "jpg", "rgb565", "c-array"]);

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function parseStoredPreferences(value: string | null): Partial<AppPreferences> {
  if (!value) return {};

  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    return {
      ...(isThemeMode(record.themeMode) ? { themeMode: record.themeMode } : {}),
      ...(typeof record.defaultOutputFormat === "string" && OUTPUT_FORMATS.has(record.defaultOutputFormat as OutputFormat)
        ? { defaultOutputFormat: record.defaultOutputFormat as OutputFormat }
        : {}),
      ...(typeof record.defaultJpegQuality === "number" && Number.isInteger(record.defaultJpegQuality) && record.defaultJpegQuality >= 1 && record.defaultJpegQuality <= 100
        ? { defaultJpegQuality: record.defaultJpegQuality }
        : {}),
      ...(typeof record.keepAspectRatio === "boolean" ? { keepAspectRatio: record.keepAspectRatio } : {}),
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

