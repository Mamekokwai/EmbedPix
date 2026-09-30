import { describe, expect, it } from "vitest";
import { DEFAULT_APP_PREFERENCES } from "../platform/preferences/appPreferences";
import { DEFAULT_GIF_MAKER_PREFERENCES } from "../features/gif-maker/gifMakerPreferences";
import { exportPresetBundle, formatPresetTransferError, importPresetBundle, mergeImportedPresets } from "./presetTransfer";

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

describe("preset transfer error formatting", () => {
  it("localizes stable import errors while preserving details", () => {
    expect(formatPresetTransferError(new Error("preset file is not valid JSON"))).toBe("预设文件不是有效的 JSON");
    expect(formatPresetTransferError(new Error("JPEG quality is out of range"))).toBe("JPEG 质量超出有效范围");
    expect(formatPresetTransferError(new Error("canvasWidth is out of range"))).toBe("画布宽度超出有效范围");
    expect(formatPresetTransferError(new Error("preset entry must be an object"))).toBe("预设条目必须是对象");
  });

  it("preserves unknown strings and safely falls back for non-errors", () => {
    expect(formatPresetTransferError("native preset failure")).toBe("native preset failure");
    expect(formatPresetTransferError(null)).toBe("预设导入失败，请重试。");
  });
});
