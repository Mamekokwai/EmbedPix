import { clampFrameDuration } from "./gifMakerLogic";
import type {
  GifCanvasPreset,
  GifColorCount,
  GifContentAlignment,
  GifContentFit,
  GifContentMargins,
  GifPlaybackSpeed,
} from "./gifMakerLogic";

export type GifMakerBackground = "transparent" | "white" | "black" | "custom";
export type GifMakerLoopMode = "infinite" | "finite";
export type GifMakerEncodingQuality = "high" | "balanced" | "fast";
export type GifMakerDitherMode = "none" | "floydSteinberg" | "atkinson";
export type GifMakerOutputFormat = "gif" | "png-sequence" | "webp" | "apng";
export type GifMakerPreset = "custom" | "high" | "balanced" | "small";
export type GifMakerVideoCropPreset = "original" | "center16x9" | "center1x1" | "custom";
export type GifMakerVideoRotation = 0 | 90 | 180 | 270;

export interface GifMakerPreferences {
  canvasPreset: GifCanvasPreset;
  canvasWidth: number;
  canvasHeight: number;
  keepAspectRatio: boolean;
  fitMode: GifContentFit;
  contentAlignment: GifContentAlignment;
  contentMargins: GifContentMargins;
  globalDuration: number;
  batchDuration: number;
  firstFrameHoldDuration: number;
  lastFrameHoldDuration: number;
  playbackSpeed: GifPlaybackSpeed;
  background: GifMakerBackground;
  customBackgroundColor: string;
  loopMode: GifMakerLoopMode;
  loopCount: number;
  encodingQuality: GifMakerEncodingQuality;
  colorCount: GifColorCount;
  ditherMode: GifMakerDitherMode;
  gifPreset: GifMakerPreset;
  targetSizeKiB: string;
  maxSizeKiB: string;
  autoCompress: boolean;
  overwriteExisting: boolean;
  outputFormat: GifMakerOutputFormat;
  videoFps: number;
  videoEveryNthFrame: number;
  videoMaxFrames: number;
  videoCropPreset: GifMakerVideoCropPreset;
  videoRotation: GifMakerVideoRotation;
  videoReverse: boolean;
}

export const GIF_MAKER_PREFERENCES_STORAGE_KEY = "embedpix.gif-maker-preferences.v1";
export const GIF_MAKER_PREFERENCES_VERSION = 1;

export const DEFAULT_GIF_MAKER_PREFERENCES: GifMakerPreferences = {
  canvasPreset: "custom",
  canvasWidth: 320,
  canvasHeight: 240,
  keepAspectRatio: true,
  fitMode: "contain",
  contentAlignment: "center",
  contentMargins: { top: 0, right: 0, bottom: 0, left: 0 },
  globalDuration: 100,
  batchDuration: 100,
  firstFrameHoldDuration: 0,
  lastFrameHoldDuration: 0,
  playbackSpeed: 1,
  background: "transparent",
  customBackgroundColor: "#ffffff",
  loopMode: "infinite",
  loopCount: 3,
  encodingQuality: "high",
  colorCount: 256,
  ditherMode: "none",
  gifPreset: "high",
  targetSizeKiB: "",
  maxSizeKiB: "",
  autoCompress: false,
  overwriteExisting: false,
  outputFormat: "gif",
  videoFps: 10,
  videoEveryNthFrame: 1,
  videoMaxFrames: 200,
  videoCropPreset: "original",
  videoRotation: 0,
  videoReverse: false,
};

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const CANVAS_PRESETS = new Set<GifCanvasPreset>(["source", "75", "50", "custom"]);
const FIT_MODES = new Set<GifContentFit>(["contain", "cover", "stretch"]);
const ALIGNMENTS = new Set<GifContentAlignment>(["center", "top", "bottom"]);
const PLAYBACK_SPEEDS = new Set<GifPlaybackSpeed>([0.25, 0.5, 1, 2]);
const BACKGROUNDS = new Set<GifMakerBackground>(["transparent", "white", "black", "custom"]);
const LOOP_MODES = new Set<GifMakerLoopMode>(["infinite", "finite"]);
const ENCODING_QUALITIES = new Set<GifMakerEncodingQuality>(["high", "balanced", "fast"]);
const COLOR_COUNTS = new Set<GifColorCount>([2, 16, 32, 64, 128, 256]);
const DITHER_MODES = new Set<GifMakerDitherMode>(["none", "floydSteinberg", "atkinson"]);
const GIF_PRESETS = new Set<GifMakerPreset>(["custom", "high", "balanced", "small"]);
const OUTPUT_FORMATS = new Set<GifMakerOutputFormat>(["gif", "png-sequence", "webp", "apng"]);
const VIDEO_CROP_PRESETS = new Set<GifMakerVideoCropPreset>(["original", "center16x9", "center1x1", "custom"]);
const VIDEO_ROTATIONS = new Set<GifMakerVideoRotation>([0, 90, 180, 270]);

function fallbackPreferences(): GifMakerPreferences {
  return { ...DEFAULT_GIF_MAKER_PREFERENCES, contentMargins: { ...DEFAULT_GIF_MAKER_PREFERENCES.contentMargins } };
}

function resolveStorage(): PreferenceStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function enumValue<T extends string | number>(record: Record<string, unknown>, key: string, values: ReadonlySet<T>, fallback: T): T {
  const value = record[key];
  return values.has(value as T) ? value as T : fallback;
}

function integerValue(record: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function holdDurationValue(record: Record<string, unknown>, key: string, fallback: number): number {
  return integerValue(record, key, 0, 60_000, fallback);
}

function sizeInputValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || !/^\d+(?:\.\d+)?$/u.test(trimmed)) return "";
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? trimmed.slice(0, 32) : "";
}

function parsePreferences(value: string | null): GifMakerPreferences {
  if (!value) return fallbackPreferences();
  try {
    const record = recordFrom(JSON.parse(value));
    if (!record || record.version !== GIF_MAKER_PREFERENCES_VERSION) return fallbackPreferences();
    const margins = recordFrom(record.contentMargins);
    return {
      canvasPreset: enumValue(record, "canvasPreset", CANVAS_PRESETS, DEFAULT_GIF_MAKER_PREFERENCES.canvasPreset),
      canvasWidth: integerValue(record, "canvasWidth", 1, 4096, DEFAULT_GIF_MAKER_PREFERENCES.canvasWidth),
      canvasHeight: integerValue(record, "canvasHeight", 1, 4096, DEFAULT_GIF_MAKER_PREFERENCES.canvasHeight),
      keepAspectRatio: typeof record.keepAspectRatio === "boolean" ? record.keepAspectRatio : DEFAULT_GIF_MAKER_PREFERENCES.keepAspectRatio,
      fitMode: enumValue(record, "fitMode", FIT_MODES, DEFAULT_GIF_MAKER_PREFERENCES.fitMode),
      contentAlignment: enumValue(record, "contentAlignment", ALIGNMENTS, DEFAULT_GIF_MAKER_PREFERENCES.contentAlignment),
      contentMargins: {
        top: margins ? integerValue(margins, "top", 0, 4096, 0) : 0,
        right: margins ? integerValue(margins, "right", 0, 4096, 0) : 0,
        bottom: margins ? integerValue(margins, "bottom", 0, 4096, 0) : 0,
        left: margins ? integerValue(margins, "left", 0, 4096, 0) : 0,
      },
      globalDuration: clampFrameDuration(integerValue(record, "globalDuration", 10, 60_000, DEFAULT_GIF_MAKER_PREFERENCES.globalDuration)),
      batchDuration: clampFrameDuration(integerValue(record, "batchDuration", 10, 60_000, DEFAULT_GIF_MAKER_PREFERENCES.batchDuration)),
      firstFrameHoldDuration: holdDurationValue(record, "firstFrameHoldDuration", DEFAULT_GIF_MAKER_PREFERENCES.firstFrameHoldDuration),
      lastFrameHoldDuration: holdDurationValue(record, "lastFrameHoldDuration", DEFAULT_GIF_MAKER_PREFERENCES.lastFrameHoldDuration),
      playbackSpeed: enumValue(record, "playbackSpeed", PLAYBACK_SPEEDS, DEFAULT_GIF_MAKER_PREFERENCES.playbackSpeed),
      background: enumValue(record, "background", BACKGROUNDS, DEFAULT_GIF_MAKER_PREFERENCES.background),
      customBackgroundColor: typeof record.customBackgroundColor === "string" && /^#[0-9a-f]{6}$/iu.test(record.customBackgroundColor)
        ? record.customBackgroundColor
        : DEFAULT_GIF_MAKER_PREFERENCES.customBackgroundColor,
      loopMode: enumValue(record, "loopMode", LOOP_MODES, DEFAULT_GIF_MAKER_PREFERENCES.loopMode),
      loopCount: integerValue(record, "loopCount", 1, 65_535, DEFAULT_GIF_MAKER_PREFERENCES.loopCount),
      encodingQuality: enumValue(record, "encodingQuality", ENCODING_QUALITIES, DEFAULT_GIF_MAKER_PREFERENCES.encodingQuality),
      colorCount: enumValue(record, "colorCount", COLOR_COUNTS, DEFAULT_GIF_MAKER_PREFERENCES.colorCount),
      ditherMode: enumValue(record, "ditherMode", DITHER_MODES, DEFAULT_GIF_MAKER_PREFERENCES.ditherMode),
      gifPreset: enumValue(record, "gifPreset", GIF_PRESETS, DEFAULT_GIF_MAKER_PREFERENCES.gifPreset),
      targetSizeKiB: sizeInputValue(record, "targetSizeKiB"),
      maxSizeKiB: sizeInputValue(record, "maxSizeKiB"),
      autoCompress: typeof record.autoCompress === "boolean" ? record.autoCompress : DEFAULT_GIF_MAKER_PREFERENCES.autoCompress,
      overwriteExisting: typeof record.overwriteExisting === "boolean" ? record.overwriteExisting : DEFAULT_GIF_MAKER_PREFERENCES.overwriteExisting,
      outputFormat: enumValue(record, "outputFormat", OUTPUT_FORMATS, DEFAULT_GIF_MAKER_PREFERENCES.outputFormat),
      videoFps: integerValue(record, "videoFps", 1, 30, DEFAULT_GIF_MAKER_PREFERENCES.videoFps),
      videoEveryNthFrame: integerValue(record, "videoEveryNthFrame", 1, 200, DEFAULT_GIF_MAKER_PREFERENCES.videoEveryNthFrame),
      videoMaxFrames: integerValue(record, "videoMaxFrames", 1, 200, DEFAULT_GIF_MAKER_PREFERENCES.videoMaxFrames),
      videoCropPreset: enumValue(record, "videoCropPreset", VIDEO_CROP_PRESETS, DEFAULT_GIF_MAKER_PREFERENCES.videoCropPreset),
      videoRotation: enumValue(record, "videoRotation", VIDEO_ROTATIONS, DEFAULT_GIF_MAKER_PREFERENCES.videoRotation),
      videoReverse: typeof record.videoReverse === "boolean" ? record.videoReverse : DEFAULT_GIF_MAKER_PREFERENCES.videoReverse,
    };
  } catch {
    return fallbackPreferences();
  }
}

export function loadGifMakerPreferences(storage: PreferenceStorage | undefined = resolveStorage()): GifMakerPreferences {
  if (!storage) return fallbackPreferences();
  try {
    return parsePreferences(storage.getItem(GIF_MAKER_PREFERENCES_STORAGE_KEY));
  } catch {
    return fallbackPreferences();
  }
}

export function saveGifMakerPreferences(
  preferences: GifMakerPreferences,
  storage: PreferenceStorage | undefined = resolveStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(GIF_MAKER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: GIF_MAKER_PREFERENCES_VERSION,
      canvasPreset: preferences.canvasPreset,
      canvasWidth: preferences.canvasWidth,
      canvasHeight: preferences.canvasHeight,
      keepAspectRatio: preferences.keepAspectRatio,
      fitMode: preferences.fitMode,
      contentAlignment: preferences.contentAlignment,
      contentMargins: { ...preferences.contentMargins },
      globalDuration: preferences.globalDuration,
      batchDuration: preferences.batchDuration,
      firstFrameHoldDuration: preferences.firstFrameHoldDuration,
      lastFrameHoldDuration: preferences.lastFrameHoldDuration,
      playbackSpeed: preferences.playbackSpeed,
      background: preferences.background,
      customBackgroundColor: preferences.customBackgroundColor,
      loopMode: preferences.loopMode,
      loopCount: preferences.loopCount,
      encodingQuality: preferences.encodingQuality,
      colorCount: preferences.colorCount,
      ditherMode: preferences.ditherMode,
      gifPreset: preferences.gifPreset,
      targetSizeKiB: preferences.targetSizeKiB,
      maxSizeKiB: preferences.maxSizeKiB,
      autoCompress: preferences.autoCompress,
      overwriteExisting: preferences.overwriteExisting,
      outputFormat: preferences.outputFormat,
      videoFps: preferences.videoFps,
      videoEveryNthFrame: preferences.videoEveryNthFrame,
      videoMaxFrames: preferences.videoMaxFrames,
      videoCropPreset: preferences.videoCropPreset,
      videoRotation: preferences.videoRotation,
      videoReverse: preferences.videoReverse,
    }));
  } catch {
    // Preferences are optional; a locked-down WebView must not break conversion.
  }
}
