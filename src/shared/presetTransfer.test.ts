import { describe, expect, it } from "vitest";
import { DEFAULT_APP_PREFERENCES } from "../platform/preferences/appPreferences";
import { DEFAULT_GIF_MAKER_PREFERENCES } from "../features/gif-maker/gifMakerPreferences";
import { exportPresetBundle, importPresetBundle, mergeImportedPresets } from "./presetTransfer";

const { themeMode: _themeMode, sidebarMode: _sidebarMode, imagePreset: _imagePreset, ...imageValues } = DEFAULT_APP_PREFERENCES;
const image = { id: "i1", name: "图标", createdAt: "2026-01-01T00:00:00Z", values: imageValues };
const gif = { id: "g1", name: "动画", createdAt: "2026-01-01T00:00:00Z", values: DEFAULT_GIF_MAKER_PREFERENCES };

describe("preset transfer", () => {
  it("round trips typed versioned image and GIF presets", () => expect(importPresetBundle(exportPresetBundle([image], [gif]))).toEqual({ image: [image], gif: [gif] }));
  it("rejects old schema, unknown fields and invalid ranges", () => {
    expect(() => importPresetBundle(JSON.stringify({ schema: "embedpix.preset-transfer", version: 0, presets: [] }))).toThrow("schema");
    const payload = JSON.parse(exportPresetBundle([image], [])); payload.presets[0].preset.values.extra = true;
    expect(() => importPresetBundle(JSON.stringify(payload))).toThrow("unsupported fields");
    const bad = JSON.parse(exportPresetBundle([image], [])); bad.presets[0].preset.values.defaultJpegQuality = 101;
    expect(() => importPresetBundle(JSON.stringify(bad))).toThrow("out of range");
  });
  it("applies skip, replace and rename duplicate strategies", () => {
    expect(mergeImportedPresets([image], [image], "skip")).toHaveLength(1);
    expect(mergeImportedPresets([image], [{ ...image, id: "i2", values: DEFAULT_APP_PREFERENCES }], "replace")[0].id).toBe("i2");
    expect(mergeImportedPresets([image], [{ ...image, id: "i2" }], "rename")[1].name).toBe("图标 (2)");
  });
});
