import { describe, expect, it } from "vitest";
import {
  DEFAULT_GIF_MAKER_PREFERENCES,
  GIF_MAKER_PREFERENCES_STORAGE_KEY,
  loadGifMakerPreferences,
  saveGifMakerPreferences,
} from "./gifMakerPreferences";

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    read: (key: string) => values.get(key),
  };
}

describe("GIF maker preferences", () => {
  it("round-trips safe animation parameters without storing files or paths", () => {
    const storage = createStorage();
    const preferences = {
      ...DEFAULT_GIF_MAKER_PREFERENCES,
      canvasPreset: "custom" as const,
      canvasWidth: 800,
      canvasHeight: 480,
      keepAspectRatio: false,
      fitMode: "cover" as const,
      contentAlignment: "bottom" as const,
      contentMargins: { top: 8, right: 12, bottom: 16, left: 20 },
      globalDuration: 80,
      batchDuration: 140,
      firstFrameHoldDuration: 250,
      lastFrameHoldDuration: 350,
      playbackSpeed: 0.5 as const,
      background: "custom" as const,
      customBackgroundColor: "#123456",
      loopMode: "finite" as const,
      loopCount: 5,
      encodingQuality: "balanced" as const,
      colorCount: 2 as const,
      ditherMode: "atkinson" as const,
      gifPreset: "custom" as const,
      targetSizeKiB: "96",
      maxSizeKiB: "128.5",
      autoCompress: true,
      overwriteExisting: true,
      outputFormat: "apng" as const,
      videoFps: 24,
      videoEveryNthFrame: 2,
      videoMaxFrames: 80,
      videoCropPreset: "custom" as const,
      videoRotation: 90 as const,
      videoReverse: true,
    };

    saveGifMakerPreferences(preferences, storage);
    const stored = JSON.parse(storage.read(GIF_MAKER_PREFERENCES_STORAGE_KEY) ?? "{}");
    expect(stored.version).toBe(1);
    expect(stored).not.toHaveProperty("frames");
    expect(stored).not.toHaveProperty("outputPath");
    expect(loadGifMakerPreferences(storage)).toEqual(preferences);
  });

  it("repairs malformed fields and clamps values to safe ranges", () => {
    const storage = createStorage({
      [GIF_MAKER_PREFERENCES_STORAGE_KEY]: JSON.stringify({
        version: 1,
        canvasWidth: 99999,
        canvasHeight: 0,
        fitMode: "invalid",
        contentMargins: { top: -4, right: 12.6, bottom: 99999, left: "bad" },
        globalDuration: 123,
        firstFrameHoldDuration: -1,
        loopCount: 999999,
        colorCount: 4,
        targetSizeKiB: "not-a-size",
        maxSizeKiB: " 128.5 ",
        customBackgroundColor: "javascript:alert(1)",
        outputFormat: "old-format",
      }),
    });

    expect(loadGifMakerPreferences(storage)).toMatchObject({
      canvasWidth: 4096,
      canvasHeight: 1,
      fitMode: "contain",
      contentMargins: { top: 0, right: 13, bottom: 4096, left: 0 },
      globalDuration: 120,
      firstFrameHoldDuration: 0,
      loopCount: 65535,
      colorCount: 256,
      targetSizeKiB: "",
      maxSizeKiB: "128.5",
      customBackgroundColor: "#ffffff",
      outputFormat: "gif",
    });
  });

  it("falls back completely for broken or old-version storage", () => {
    expect(loadGifMakerPreferences(createStorage({ [GIF_MAKER_PREFERENCES_STORAGE_KEY]: "broken" }))).toEqual(DEFAULT_GIF_MAKER_PREFERENCES);
    expect(loadGifMakerPreferences(createStorage({ [GIF_MAKER_PREFERENCES_STORAGE_KEY]: JSON.stringify({ version: 0, canvasWidth: 1 }) }))).toEqual(DEFAULT_GIF_MAKER_PREFERENCES);
  });

  it("ignores storage failures because preferences are optional", () => {
    const storage = {
      getItem: () => { throw new Error("storage disabled"); },
      setItem: () => { throw new Error("storage disabled"); },
    };
    expect(loadGifMakerPreferences(storage)).toEqual(DEFAULT_GIF_MAKER_PREFERENCES);
    expect(() => saveGifMakerPreferences(DEFAULT_GIF_MAKER_PREFERENCES, storage)).not.toThrow();
  });
});
