import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_PREFERENCES,
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
      defaultOutputFormat: "rgb565",
      defaultJpegQuality: 92,
      keepAspectRatio: false,
    });
  });

  it("falls back to safe defaults for invalid stored JSON", () => {
    expect(loadAppPreferences(createStorage({ "embedpix.app-preferences.v1": "broken" }))).toEqual(
      DEFAULT_APP_PREFERENCES,
    );
  });

  it("persists preferences and resolves system appearance", () => {
    const storage = createStorage();
    saveAppPreferences({ ...DEFAULT_APP_PREFERENCES, themeMode: "dark" }, storage);
    expect(loadAppPreferences(storage).themeMode).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });
});
