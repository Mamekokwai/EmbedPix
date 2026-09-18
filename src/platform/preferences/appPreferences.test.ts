import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_PREFERENCES,
  IMAGE_PRESETS,
  loadAppPreferences,
  resolveTheme,
  saveAppPreferences,
} from "./appPreferences";

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("app preferences", () => {
  it("provides explicit converter presets with different output tradeoffs", () => {
    expect(IMAGE_PRESETS["high-quality"]).toMatchObject({ defaultOutputFormat: "png", defaultBitDepth: 32, defaultJpegQuality: 95 });
    expect(IMAGE_PRESETS.balanced).toMatchObject({ defaultOutputFormat: "bmp", defaultBitDepth: 24, defaultJpegQuality: 85 });
    expect(IMAGE_PRESETS["small-size"]).toMatchObject({ defaultOutputFormat: "jpg", defaultJpegQuality: 75 });
  });

  it("loads valid values while ignoring malformed fields", () => {
    const storage = createStorage({
      "embedpix.app-preferences.v1": JSON.stringify({
        themeMode: "dark",
        defaultOutputFormat: "rgb565",
        defaultJpegQuality: 92,
        keepAspectRatio: false,
        unknown: "ignored",
      }),
    });

    expect(loadAppPreferences(storage)).toEqual({
      themeMode: "dark",
      sidebarMode: "icon",
      defaultOutputFormat: "rgb565",
      defaultJpegQuality: 92,
      defaultBitDepth: 24,
      defaultByteOrder: "little",
      defaultChannelOrder: "rgb",
      defaultRowOrder: "top-down",
      defaultRowAlignment: 1,
      defaultCArrayName: "image_data",
      defaultBackgroundColor: "#FFFFFF",
      keepAspectRatio: false,
      imagePreset: "balanced",
    });
  });

  it("falls back to safe defaults for invalid stored JSON", () => {
    expect(loadAppPreferences(createStorage({ "embedpix.app-preferences.v1": "broken" }))).toEqual(
      DEFAULT_APP_PREFERENCES,
    );
  });

  it("persists preferences and resolves system appearance", () => {
    const storage = createStorage();
    saveAppPreferences({
      ...DEFAULT_APP_PREFERENCES,
      themeMode: "dark",
      sidebarMode: "labeled",
      defaultBitDepth: 32,
      defaultByteOrder: "big",
      defaultChannelOrder: "bgr",
      defaultRowOrder: "bottom-up",
      defaultRowAlignment: 4,
      defaultCArrayName: "screen_logo",
      defaultBackgroundColor: "#123456",
      imagePreset: "custom",
    }, storage);
    expect(loadAppPreferences(storage).themeMode).toBe("dark");
    expect(loadAppPreferences(storage).sidebarMode).toBe("labeled");
    expect(loadAppPreferences(storage).defaultBitDepth).toBe(32);
    expect(loadAppPreferences(storage).defaultByteOrder).toBe("big");
    expect(loadAppPreferences(storage).defaultChannelOrder).toBe("bgr");
    expect(loadAppPreferences(storage).defaultRowOrder).toBe("bottom-up");
    expect(loadAppPreferences(storage).defaultRowAlignment).toBe(4);
    expect(loadAppPreferences(storage).defaultCArrayName).toBe("screen_logo");
    expect(loadAppPreferences(storage).defaultBackgroundColor).toBe("#123456");
    expect(loadAppPreferences(storage).imagePreset).toBe("custom");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });
});
