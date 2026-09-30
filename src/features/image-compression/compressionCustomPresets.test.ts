import { describe, expect, it } from "vitest";
import {
  COMPRESSION_CUSTOM_PRESETS_SCHEMA,
  COMPRESSION_CUSTOM_PRESETS_VERSION,
  createCompressionCustomPreset,
  exportCompressionPresetsJson,
  importCompressionPresetsJson,
  loadCompressionCustomPresets,
  mergeCompressionCustomPresets,
  saveCompressionCustomPresets,
} from "./compressionCustomPresets";
import type { CompressionPresetValues } from "./compressionCustomPresets";

const values: CompressionPresetValues = {
  format: "webp",
  quality: 82,
  webpMethod: 4,
  webpAlphaQuality: 100,
  webpPass: 1,
  webpNearLossless: null,
  jpegBackground: "#ffffff",
  pngOptimizationLevel: 3,
  targetSizeEnabled: false,
  targetSizeKiB: "",
  maxCandidates: 8,
  maxRgbMae: "",
  maxInputMiB: 32,
  skipIfLarger: true,
  lossless: true,
  metadataPolicy: "strip",
};

function storage(initial = "") {
  let value = initial;
  return {
    getItem: () => value || null,
    setItem: (_key: string, next: string) => { value = next; },
    read: () => value,
  };
}

describe("compression custom presets", () => {
  it("round-trips a versioned safe schema without paths or temporary state", () => {
    const preset = createCompressionCustomPreset("嵌入式 WebP", values);
    const json = exportCompressionPresetsJson([preset]);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).toMatchObject({ schema: COMPRESSION_CUSTOM_PRESETS_SCHEMA, version: COMPRESSION_CUSTOM_PRESETS_VERSION });
    expect(json).not.toContain("sourcePath");
    expect(json).not.toContain("outputDirectory");
    expect(json).not.toContain("replaceOriginal");
    expect(json).not.toContain("resultStats");
    expect(importCompressionPresetsJson(json)[0]).toMatchObject({ name: preset.name, values });
  });

  it("ignores unknown fields while rejecting malformed known fields in Chinese", () => {
    const json = JSON.stringify({ schema: COMPRESSION_CUSTOM_PRESETS_SCHEMA, version: 1, future: true, presets: [{ name: "未来兼容", values: { ...values, futureOption: "ignored" }, ignored: "ignored" }] });
    expect(importCompressionPresetsJson(json)[0].name).toBe("未来兼容");
    expect(() => importCompressionPresetsJson("not-json")).toThrow("压缩预设 JSON 格式无效");
    expect(() => importCompressionPresetsJson(JSON.stringify({ schema: COMPRESSION_CUSTOM_PRESETS_SCHEMA, version: 1, presets: [{ name: "坏预设", values: { ...values, quality: 101 } }] }))).toThrow("质量无效");
    expect(() => importCompressionPresetsJson(JSON.stringify({ schema: COMPRESSION_CUSTOM_PRESETS_SCHEMA, version: 1, presets: [{ name: "坏方法", values: { ...values, webpMethod: 7 } }] }))).toThrow("WebP 编码方法无效");
    expect(() => createCompressionCustomPreset("坏方法", { ...values, webpMethod: 7 })).toThrow("WebP 编码方法必须");
    expect(() => importCompressionPresetsJson(JSON.stringify({ schema: COMPRESSION_CUSTOM_PRESETS_SCHEMA, version: 1, presets: [{ name: "坏候选", values: { ...values, maxCandidates: 13 } }] }))).toThrow("候选搜索次数无效");
    expect(() => createCompressionCustomPreset("坏候选", { ...values, maxCandidates: 13 })).toThrow("候选搜索次数必须");
    expect(() => importCompressionPresetsJson(JSON.stringify({ schema: COMPRESSION_CUSTOM_PRESETS_SCHEMA, version: 1, presets: [{ name: "坏近无损", values: { ...values, format: "jpg", lossless: false, webpNearLossless: 90 } }] }))).toThrow("仅适用于无损 WebP");
    expect(() => importCompressionPresetsJson(JSON.stringify({ schema: COMPRESSION_CUSTOM_PRESETS_SCHEMA, version: 1, presets: [{ name: "坏背景", values: { ...values, jpegBackground: "white" } }] }))).toThrow("JPEG 透明背景无效");
    expect(() => importCompressionPresetsJson(JSON.stringify({ schema: COMPRESSION_CUSTOM_PRESETS_SCHEMA, version: 1, presets: [{ name: "坏开关", values: { ...values, skipIfLarger: "yes" } }] }))).toThrow("压缩后更大时跳过无效");
    expect(() => importCompressionPresetsJson(JSON.stringify({ schema: COMPRESSION_CUSTOM_PRESETS_SCHEMA, version: 1, presets: [{ name: "保留元数据", values: { ...values, metadataPolicy: "preserve" } }] }))).toThrow("元数据策略无效");
  });

  it("imports JPEG stripSafe presets", () => {
    const imported = importCompressionPresetsJson(JSON.stringify({ schema: COMPRESSION_CUSTOM_PRESETS_SCHEMA, version: 1, presets: [{ name: "JPEG 安全清理", values: { ...values, format: "jpg", lossless: false, metadataPolicy: "stripSafe" } }] }));
    expect(imported[0]?.values.metadataPolicy).toBe("stripSafe");
  });

  it("round-trips a custom lossy resize percentage", () => {
    const jpegValues: CompressionPresetValues = { ...values, format: "jpg", lossless: false, targetResizePercent: 63 };
    const preset = createCompressionCustomPreset("JPEG 自定义尺寸", jpegValues);
    const imported = importCompressionPresetsJson(exportCompressionPresetsJson([preset]));
    expect(imported[0]?.values.targetResizePercent).toBe(63);
    expect(() => createCompressionCustomPreset("无损缩放", { ...values, targetResizePercent: 63 })).toThrow("仅适用于 JPEG 或有损 WebP");
  });

  it("round-trips automatic target resizing without a fixed resize", () => {
    const jpegValues: CompressionPresetValues = { ...values, format: "jpg", lossless: false, targetSizeEnabled: true, targetSizeKiB: "64", autoResizeToTarget: true, targetResizePercent: null };
    const preset = createCompressionCustomPreset("JPEG 自动缩放", jpegValues);
    const imported = importCompressionPresetsJson(exportCompressionPresetsJson([preset]));
    expect(imported[0]?.values.autoResizeToTarget).toBe(true);
    expect(imported[0]?.values.targetResizePercent).toBeNull();
    expect(() => createCompressionCustomPreset("自动缩放冲突", { ...jpegValues, targetResizePercent: 50 })).toThrow("不能与固定输出缩放");
    expect(() => createCompressionCustomPreset("自动缩放无目标", { ...jpegValues, targetSizeEnabled: false })).toThrow("需要 JPEG/有损 WebP 的目标体积");
  });

  it("keeps older custom presets compatible with the safe default method", () => {
    const legacyValues = { ...values };
    delete (legacyValues as Partial<typeof values>).webpMethod;
    delete (legacyValues as Partial<typeof values>).skipIfLarger;
    const imported = importCompressionPresetsJson(JSON.stringify({ schema: COMPRESSION_CUSTOM_PRESETS_SCHEMA, version: 1, presets: [{ name: "旧预设", values: legacyValues }] }));
    expect(imported[0]?.values.webpMethod).toBe(4);
    expect(imported[0]?.values.skipIfLarger).toBe(true);
    expect(imported[0]?.values.maxCandidates).toBe(8);
  });

  it("deduplicates imported names without applying or mutating existing presets", () => {
    const existing = [createCompressionCustomPreset("屏幕", values)];
    const incoming = importCompressionPresetsJson(JSON.stringify({ schema: COMPRESSION_CUSTOM_PRESETS_SCHEMA, version: 1, presets: [{ name: "屏幕", values }, { name: "屏幕", values }] }));
    const merged = mergeCompressionCustomPresets(existing, incoming);
    expect(merged.map((preset) => preset.name)).toEqual(["屏幕", "屏幕 (2)", "屏幕 (3)"]);
    expect(existing).toHaveLength(1);
  });

  it("persists only validated local presets and tolerates broken storage", () => {
    const store = storage();
    const preset = createCompressionCustomPreset("本地", values);
    saveCompressionCustomPresets([preset], store);
    expect(loadCompressionCustomPresets(store)[0]).toMatchObject({ name: "本地", values });
    expect(loadCompressionCustomPresets(storage("broken"))).toEqual([]);
  });
});
