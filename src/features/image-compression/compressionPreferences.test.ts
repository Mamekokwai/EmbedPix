import { describe, expect, it } from "vitest";
import {
  COMPRESSION_PREFERENCES_STORAGE_KEY,
  DEFAULT_COMPRESSION_PREFERENCES,
  loadCompressionPreferences,
  saveCompressionPreferences,
} from "./compressionPreferences";

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    read: (key: string) => values.get(key),
  };
}

describe("compression preferences", () => {
  it("round-trips parameters without persisting image or output paths", () => {
    const storage = createStorage();
    const preferences = {
      ...DEFAULT_COMPRESSION_PREFERENCES,
      format: "jpg" as const,
      quality: 68,
      pngOptimizationLevel: 5,
      targetSizeEnabled: true,
      targetSizeKiB: "96",
      lossless: false,
      preset: "custom" as const,
      outputLocation: "subfolder" as const,
      outputFileName: "旅行照片.jpg",
      outputSubdirectory: "compressed",
      overwrite: true,
      autoNumbering: false,
      replaceOriginal: true,
    };

    saveCompressionPreferences(preferences, storage);
    const stored = JSON.parse(storage.read(COMPRESSION_PREFERENCES_STORAGE_KEY) ?? "{}");
    expect(stored.version).toBe(1);
    expect(stored).not.toHaveProperty("sourcePath");
    expect(stored).not.toHaveProperty("outputPath");
    expect(stored).not.toHaveProperty("outputDirectory");
    expect(stored).not.toHaveProperty("items");
    expect(stored.outputFileName).toBe("旅行照片.jpg");
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
        unknownFutureField: true,
      }),
    });

    expect(loadCompressionPreferences(storage)).toMatchObject({
      format: "png",
      quality: 100,
      pngOptimizationLevel: 0,
      targetSizeEnabled: false,
      targetSizeKiB: "",
      lossless: true,
      outputLocation: "source",
      outputSubdirectory: "",
      outputFileName: "",
    });
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

  it("ignores storage failures because preferences are optional", () => {
    const storage = {
      getItem: () => { throw new Error("storage disabled"); },
      setItem: () => { throw new Error("storage disabled"); },
    };
    expect(loadCompressionPreferences(storage)).toEqual(DEFAULT_COMPRESSION_PREFERENCES);
    expect(() => saveCompressionPreferences(DEFAULT_COMPRESSION_PREFERENCES, storage)).not.toThrow();
  });
});
