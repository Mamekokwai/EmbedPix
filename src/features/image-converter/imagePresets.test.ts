import { describe, expect, it } from "vitest";
import { DEFAULT_APP_PREFERENCES } from "../../platform/preferences/appPreferences";
import { createImageCustomPreset, loadImageCustomPresets, saveImageCustomPresets } from "./imagePresets";

function storage(initial: string | null = null) {
  let value = initial;
  return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
}

describe("image custom presets", () => {
  it("round trips versioned local presets", () => {
    const store = storage();
    const preset = createImageCustomPreset("屏幕图标", DEFAULT_APP_PREFERENCES);
    saveImageCustomPresets([preset], store);
    expect(loadImageCustomPresets(store)).toEqual([preset]);
  });

  it("rejects missing or incompatible schemas", () => {
    expect(loadImageCustomPresets(storage(JSON.stringify({ version: 0, presets: [] })))).toEqual([]);
    expect(loadImageCustomPresets(storage(JSON.stringify({ version: 1, presets: [{ name: "坏数据" }] })))).toEqual([]);
  });
});
