import { describe, expect, it } from "vitest";
import {
  COMPRESSION_PREFERENCES_STORAGE_KEY,
  DEFAULT_COMPRESSION_PREFERENCES,
  loadCompressionPreferences,
  saveCompressionPreferences,
} from "./compressionPreferences";
import { getCompressionPreset } from "./imageCompressionLogic";

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    read: (key: string) => values.get(key),
  };
}

describe("compression preferences", () => {
  it("keeps the default balanced preset aligned with its PNG optimization level", () => {
    expect(DEFAULT_COMPRESSION_PREFERENCES.preset).toBe("balanced");
    expect(DEFAULT_COMPRESSION_PREFERENCES.pngOptimizationLevel).toBe(getCompressionPreset("balanced").pngOptimizationLevel);
  });

  it("round-trips parameters without persisting image or output paths", () => {
    const storage = createStorage();
    const preferences = {
      ...DEFAULT_COMPRESSION_PREFERENCES,
      format: "jpg" as const,
      quality: 68,
      webpMethod: 2,
      jpegBackground: "#123456",
      pngOptimizationLevel: 5,
      targetSizeEnabled: true,
      targetSizeKiB: "96",
      maxCandidates: 10,
      targetResizePercent: 63,
      skipIfLarger: false,
      lossless: false,
      preset: "custom" as const,
      outputLocation: "subfolder" as const,
      outputFileName: "旅行照片.jpg",
      outputSubdirectory: "compressed",
      overwrite: true,
      autoNumbering: false,
      replaceOriginal: true,
      deleteSource: true,
    };

    saveCompressionPreferences(preferences, storage);
    const stored = JSON.parse(storage.read(COMPRESSION_PREFERENCES_STORAGE_KEY) ?? "{}");
    expect(stored.version).toBe(3);
    expect(stored).not.toHaveProperty("sourcePath");
    expect(stored).not.toHaveProperty("outputPath");
    expect(stored).not.toHaveProperty("outputDirectory");
    expect(stored).not.toHaveProperty("items");
    expect(stored.outputFileName).toBe("旅行照片.jpg");
    expect(stored.webpMethod).toBe(2);
    expect(stored.jpegBackground).toBe("#123456");
    expect(stored.skipIfLarger).toBe(false);
    expect(stored.maxCandidates).toBe(10);
    expect(stored.targetResizePercent).toBe(63);
    expect(stored.deleteSource).toBe(true);
    expect(loadCompressionPreferences(storage)).toEqual(preferences);
  });

  it("keeps the dangerous source-replacement option disabled by default", () => {
    expect(DEFAULT_COMPRESSION_PREFERENCES.replaceOriginal).toBe(false);
    expect(DEFAULT_COMPRESSION_PREFERENCES.autoNumbering).toBe(false);
    expect(loadCompressionPreferences(createStorage({
      [COMPRESSION_PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 1, format: "jpg", replaceOriginal: "yes" }),
    })).replaceOriginal).toBe(false);
  });

  it("restores auto numbering without persisting output paths", () => {
    const storage = createStorage();
    saveCompressionPreferences({ ...DEFAULT_COMPRESSION_PREFERENCES, autoNumbering: true, outputLocation: "subfolder", outputSubdirectory: "compressed" }, storage);
    const stored = JSON.parse(storage.read(COMPRESSION_PREFERENCES_STORAGE_KEY) ?? "{}");
    expect(stored.autoNumbering).toBe(true);
    expect(stored).not.toHaveProperty("outputDirectory");
    expect(loadCompressionPreferences(storage).autoNumbering).toBe(true);
  });

  it("ignores unknown fields and repairs malformed known fields", () => {
    const storage = createStorage({
      [COMPRESSION_PREFERENCES_STORAGE_KEY]: JSON.stringify({
        version: 1,
        format: "png",
        quality: 999,
        pngOptimizationLevel: -2,
        targetSizeEnabled: "yes",
        targetSizeKiB: "not-a-size",
        lossless: false,
        outputLocation: "invalid",
        outputSubdirectory: "../escape",
      outputFileName: "../escape.webp",
      webpMethod: 99,
        maxCandidates: 99,
        unknownFutureField: true,
      }),
    });

    expect(loadCompressionPreferences(storage)).toMatchObject({
      format: "png",
      quality: 100,
      pngOptimizationLevel: 0,
      targetSizeEnabled: false,
      targetSizeKiB: "",
      skipIfLarger: true,
      lossless: true,
      outputLocation: "source",
      outputSubdirectory: "",
      outputFileName: "",
      webpMethod: 4,
      maxCandidates: 12,
    });
  });

  it("uses the safe default for older or malformed WebP method preferences", () => {
    expect(loadCompressionPreferences(createStorage({ [COMPRESSION_PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 1, format: "webp", lossless: false }) })).webpMethod).toBe(4);
    expect(loadCompressionPreferences(createStorage({ [COMPRESSION_PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 1, format: "webp", webpMethod: 99 }) })).webpMethod).toBe(4);
  });

  it("defaults the larger-output guard on for legacy or malformed preferences", () => {
    expect(loadCompressionPreferences(createStorage({ [COMPRESSION_PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 1, skipIfLarger: "no" }) })).skipIfLarger).toBe(true);
    expect(loadCompressionPreferences(createStorage({ [COMPRESSION_PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 1, skipIfLarger: false }) })).skipIfLarger).toBe(false);
  });

  it("falls back to strip when legacy preferences request unsupported metadata preservation", () => {
    expect(loadCompressionPreferences(createStorage({ [COMPRESSION_PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 1, metadataPolicy: "preserve" }) })).metadataPolicy).toBe("strip");
  });

  it("restores JPEG stripSafe metadata policy", () => {
    expect(loadCompressionPreferences(createStorage({ [COMPRESSION_PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 1, format: "jpg", metadataPolicy: "stripSafe" }) })).metadataPolicy).toBe("stripSafe");
  });

  it("restores only a safe custom filename and never stores a path", () => {
    const storage = createStorage();
    saveCompressionPreferences({ ...DEFAULT_COMPRESSION_PREFERENCES, format: "webp", outputFileName: "旅行照片.webp" }, storage);
    const stored = JSON.parse(storage.read(COMPRESSION_PREFERENCES_STORAGE_KEY) ?? "{}");
    expect(stored.outputFileName).toBe("旅行照片.webp");
    expect(stored).not.toHaveProperty("outputDirectory");
    expect(loadCompressionPreferences(storage).outputFileName).toBe("旅行照片.webp");
    expect(loadCompressionPreferences(createStorage({ [COMPRESSION_PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 1, format: "webp", outputFileName: "../escape.webp" }) })).outputFileName).toBe("");
  });

  it("falls back completely for broken or old-version storage", () => {
    expect(loadCompressionPreferences(createStorage({ [COMPRESSION_PREFERENCES_STORAGE_KEY]: "broken" }))).toEqual(DEFAULT_COMPRESSION_PREFERENCES);
    expect(loadCompressionPreferences(createStorage({ [COMPRESSION_PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 0, quality: 1 }) }))).toEqual(DEFAULT_COMPRESSION_PREFERENCES);
  });

  it("migrates version 1 preferences by applying safe defaults for new fields", () => {
    const storage = createStorage({
      [COMPRESSION_PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 1, format: "webp", quality: 73, lossless: false, metadataPolicy: "strip" }),
    });
    const migrated = loadCompressionPreferences(storage);
    expect(migrated).toMatchObject({ format: "webp", quality: 73, webpMethod: 4, outputFileName: "", skipIfLarger: true });
    saveCompressionPreferences(migrated, storage);
    expect(JSON.parse(storage.read(COMPRESSION_PREFERENCES_STORAGE_KEY) ?? "{}").version).toBe(3);
  });

  it("ignores storage failures because preferences are optional", () => {
    const storage = {
      getItem: () => { throw new Error("storage disabled"); },
      setItem: () => { throw new Error("storage disabled"); },
    };
    expect(loadCompressionPreferences(storage)).toEqual(DEFAULT_COMPRESSION_PREFERENCES);
    expect(() => saveCompressionPreferences(DEFAULT_COMPRESSION_PREFERENCES, storage)).not.toThrow();
  });
});
