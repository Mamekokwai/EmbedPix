import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, MouseEvent } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Film,
  FolderOpen,
  ImagePlus,
  Images,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import ThemeSelect from "../../shared/components/ThemeSelect";
import { estimateAnimationSize, estimateGifSize, estimatePngSequenceSize, exportApng, exportGif, exportPngSequence, exportWebpAnimation, isTauriEnvironment, pickAnimationOutput, pickGifOutput, pickGifSequenceOutput, revealGifOutput } from "../../platform/gif/gifGateway";
import type { AnimationExportRequest, GifExportFrame, PngSequenceExportRequest } from "../../platform/gif/gifGateway";
import type { GifOutputLocation } from "../../platform/gif/gifGateway";
import { advanceGifPlayback, calculateBoundaryFrameDuration, clampFrameDuration, clampGifHoldDuration, compareGifSizes, durationFromGifFps, estimateGifWorkload, formatGifBytes, fpsFromFrameDuration, getGifCompressionColorCandidates, getGifFrameOrder, getGifSamplingCandidates, GifImportQueue, MAX_TOTAL_PIXELS, mergeConsecutiveIdenticalFrames, previewFrameDurationAtSpeed, readGifBatch, resolveGifCanvasPreset, resolveGifCanvasSize, resolveGifContentRect, sampleGifFrames, validateGifFiles, validateGifPixels } from "./gifMakerLogic";
import type { GifCanvasPreset, GifCanvasSize, GifColorCount, GifContentAlignment, GifContentFit, GifContentMargins, GifPlaybackSpeed, GifSizeComparison } from "./gifMakerLogic";
import { loadGifMakerPreferences, saveGifMakerPreferences } from "./gifMakerPreferences";
import type { GifMakerBackground, GifMakerDitherMode, GifMakerEncodingQuality, GifMakerLoopMode, GifMakerOutputFormat, GifMakerPreferences, GifMakerPreset, GifMakerVideoCropPreset, GifMakerVideoRotation } from "./gifMakerPreferences";
import { clampVideoFps, formatVideoTime, normalizeVideoCropRect, planVideoFramesWithSampling } from "./videoGifLogic";
import type { VideoCropRect } from "./videoGifLogic";
import { extractVideoFrameBlobs } from "./videoFrameExtraction";
import "../../styles/features/gif-maker.css";

export type GifFitMode = GifContentFit;
export type GifBackground = GifMakerBackground;
export type GifLoopMode = GifMakerLoopMode;
export type GifEncodingQuality = GifMakerEncodingQuality;
export type GifDitherMode = GifMakerDitherMode;
export type GifPreset = GifMakerPreset;

export interface GifPresetConfig {
  label: string;
  encodingQuality: GifEncodingQuality;
  colorCount: GifColorCount;
  ditherMode: GifDitherMode;
  canvasPreset: Exclude<GifCanvasPreset, "custom">;
}

export const GIF_PRESETS: Record<Exclude<GifPreset, "custom">, GifPresetConfig> = {
  high: { label: "高质量", encodingQuality: "high", colorCount: 256, ditherMode: "none", canvasPreset: "source" },
  balanced: { label: "平衡", encodingQuality: "balanced", colorCount: 128, ditherMode: "floydSteinberg", canvasPreset: "75" },
  small: { label: "小体积", encodingQuality: "fast", colorCount: 64, ditherMode: "none", canvasPreset: "50" },
};
export type GifSettingsGroup = "timing" | "canvas" | "export";
export const DEFAULT_GIF_SETTINGS_GROUP: GifSettingsGroup | null = null;
type GifOutputFormat = GifMakerOutputFormat;
type GifSourceMode = "image" | "video";

function defaultGifFileName(format: GifOutputFormat): string {
  return format === "png-sequence" ? "embedpix-animation" : `embedpix-animation.${format}`;
}

export interface GifFrameModel {
  id: string;
  file: File;
  previewUrl: string;
  name: string;
  width: number;
  height: number;
  durationMs: number;
  sourcePath: string | null;
}

type GifStatus =
  | { kind: "idle" | "ready" | "success"; text: string }
  | { kind: "importing" | "exporting"; text: string }
  | { kind: "error"; text: string };

const DEFAULT_DURATION = 100;
const DEFAULT_FILE_NAME = "embedpix-animation.gif";
const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/bmp,.png,.jpg,.jpeg,.webp,.bmp";
const VIDEO_ACCEPT = "video/mp4,video/webm,video/ogg,.mp4,.webm,.ogv";
const MAX_VIDEO_FRAME_LIMIT = 200;

interface VideoSourceModel {
  file: File;
  previewUrl: string;
  name: string;
  width: number;
  height: number;
  duration: number;
  sourcePath: string | null;
}

type FileWithPath = File & { path?: string };

function getSourcePath(file: File): string | null {
  const path = (file as FileWithPath).path;
  return typeof path === "string" && path.trim() ? path.trim() : null;
}

export function getGifSourcePath(frames: ReadonlyArray<Pick<GifFrameModel, "sourcePath">>): string | null {
  const sourcePath = frames[0]?.sourcePath?.trim() ?? "";
  return sourcePath && frames.every((frame) => Boolean(frame.sourcePath?.trim())) ? sourcePath : null;
}

function getSubdirectoryError(value: string): string | null {
  const name = value.trim();
  if (!name) return "请输入子文件夹名称。";
  if (name === "." || name === "..") return "子文件夹名称不能是 . 或 ..。";
  if (/[\\/:*?"<>|\u0000-\u001f]/u.test(name)) return "子文件夹名称不能包含路径分隔符或 Windows 保留字符。";
  return null;
}

export function getGifOutputLocationError(
  location: GifOutputLocation,
  sourcePath: string | null,
  subdirectory: string,
  directory: string,
  enforceSourcePath: boolean,
): string | null {
  if (enforceSourcePath && (location === "source" || location === "subfolder") && !sourcePath) {
    return "当前导入方式没有可用的源文件路径，请改用“指定目录”或手动选择保存位置。";
  }
  if (location === "subfolder") return getSubdirectoryError(subdirectory);
  if (location === "directory" && !directory.trim()) return "请输入输出目录。";
  return null;
}

export function getPngSequenceOutputLocationFields(
  location: GifOutputLocation,
  sequenceOutputDir: string | null,
  sourcePath: string | null,
  outputSubdirectory: string,
  outputDirectory: string,
): Pick<PngSequenceExportRequest, "outputDir" | "outputLocation" | "sourcePath" | "outputSubdirectory" | "outputDirectory"> {
  return {
    outputDir: location === "path" ? sequenceOutputDir ?? undefined : undefined,
    outputLocation: location,
    sourcePath: location === "source" || location === "subfolder" ? sourcePath : undefined,
    outputSubdirectory: location === "subfolder" ? outputSubdirectory.trim() || undefined : undefined,
    outputDirectory: location === "directory" ? outputDirectory.trim() || undefined : undefined,
  };
}

type VideoCropPreset = GifMakerVideoCropPreset;
type VideoRotation = GifMakerVideoRotation;
type VideoCropField = keyof VideoCropRect;

function resolveVideoCrop(width: number, height: number, preset: VideoCropPreset, customRect?: VideoCropRect): VideoCropRect {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  if (preset === "custom") return normalizeVideoCropRect(customRect, safeWidth, safeHeight);
  if (preset === "original") return { x: 0, y: 0, width: safeWidth, height: safeHeight };
  if (preset === "center1x1") {
    const size = Math.min(safeWidth, safeHeight);
    return { x: Math.floor((safeWidth - size) / 2), y: Math.floor((safeHeight - size) / 2), width: size, height: size };
  }
  const targetRatio = 16 / 9;
  const currentRatio = safeWidth / safeHeight;
  const cropWidth = currentRatio >= targetRatio ? Math.floor(safeHeight * targetRatio) : safeWidth;
  const cropHeight = currentRatio >= targetRatio ? safeHeight : Math.floor(safeWidth / targetRatio);
  return {
    x: Math.floor((safeWidth - cropWidth) / 2),
    y: Math.floor((safeHeight - cropHeight) / 2),
    width: Math.max(1, cropWidth),
    height: Math.max(1, cropHeight),
  };
}

function resolveVideoOutputSize(crop: VideoCropRect, rotation: VideoRotation): GifCanvasSize {
  return rotation === 90 || rotation === 270
    ? { width: crop.height, height: crop.width }
    : { width: crop.width, height: crop.height };
}

function isImageFile(file: File): boolean {
  return /\.(bmp|jpe?g|png|webp)$/iu.test(file.name) && !file.type.startsWith("video/");
}

function isVideoFile(file: File): boolean {
  return file.type.startsWith("video/") || /\.(mp4|webm|ogv)$/iu.test(file.name);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请检查图片和参数后重试。";
}

interface GifCompressionResult {
  bytes: number;
  baselineBytes?: number;
  frames: GifExportFrame[];
  width: number;
  height: number;
  colorCount: GifColorCount;
  samplingEvery: number;
  mergedIdenticalFrames: boolean;
}

interface AnimationCompressionResult {
  bytes: number;
  baselineBytes?: number;
  frames: GifExportFrame[];
  width: number;
  height: number;
  samplingEvery: number;
  mergedIdenticalFrames: boolean;
}

interface PngSequenceCompressionResult {
  bytes: number;
  baselineBytes?: number;
  frames: GifExportFrame[];
  width: number;
  height: number;
  samplingEvery: number;
  mergedIdenticalFrames: boolean;
}

interface GifSizeComparisonState extends GifSizeComparison { autoCompress: boolean }
interface GifExportFrameSummary { frameCount: number; totalDurationMs: number }

function formatGifCompressionSummary(result: GifCompressionResult): string {
  const sampling = result.samplingEvery === 1 ? "原始采样" : `每 ${result.samplingEvery} 帧采样`;
  const merged = result.mergedIdenticalFrames ? " · 已合并重复帧" : "";
  return `尺寸 ${result.width} × ${result.height} · ${result.colorCount} 色 · ${result.frames.length} 帧 · ${sampling}${merged}`;
}

function formatAnimationCompressionSummary(result: AnimationCompressionResult): string {
  const sampling = result.samplingEvery === 1 ? "原始采样" : `每 ${result.samplingEvery} 帧采样`;
  const merged = result.mergedIdenticalFrames ? " · 已合并重复帧" : "";
  return `尺寸 ${result.width} × ${result.height} · ${result.frames.length} 帧 · ${sampling}${merged}`;
}

function formatPngSequenceCompressionSummary(result: PngSequenceCompressionResult): string {
  const sampling = result.samplingEvery === 1 ? "原始采样" : `每 ${result.samplingEvery} 帧采样`;
  const merged = result.mergedIdenticalFrames ? " · 已合并重复帧" : "";
  return `尺寸 ${result.width} × ${result.height} · ${result.frames.length} 帧 · ${sampling}${merged}`;
}

export function selectAnimationCompressionResult<T extends { bytes: number }>(
  results: ReadonlyArray<T>,
  targetBytes?: number,
  maxBytes?: number,
): T | null {
  const available = maxBytes === undefined ? [...results] : results.filter((result) => result.bytes <= maxBytes);
  if (!available.length) return null;
  const target = targetBytes ?? maxBytes;
  if (target === undefined) return available[0] ?? null;
  const underTarget = targetBytes === undefined ? available : available.filter((result) => result.bytes <= target);
  const pool = underTarget.length ? underTarget : available;
  return pool.reduce((best, result) => {
    const resultDistance = Math.abs(result.bytes - target);
    const bestDistance = Math.abs(best.bytes - target);
    return resultDistance < bestDistance ? result : best;
  });
}

function parseSizeBytes(value: string): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed * 1024);
}

function formatGifTimelineTime(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  return seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : `${seconds.toFixed(2)} 秒`;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取这张图片，请选择有效的图片文件。"));
    image.src = url;
  });
}

function loadVideoMetadata(url: string): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", handleMetadata);
      video.removeEventListener("error", handleError);
      video.removeAttribute("src");
      video.load();
    };
    const handleMetadata = () => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0 || video.videoWidth <= 0 || video.videoHeight <= 0) {
        cleanup();
        reject(new Error("无法读取视频时长或尺寸，请选择有效的视频文件。"));
        return;
      }
      const metadata = { width: video.videoWidth, height: video.videoHeight, duration };
      cleanup();
      resolve(metadata);
    };
    const handleError = () => {
      cleanup();
      reject(new Error("当前环境无法读取该视频格式，请尝试 MP4 或 WebM。"));
    };
    video.addEventListener("loadedmetadata", handleMetadata, { once: true });
    video.addEventListener("error", handleError, { once: true });
    video.src = url;
  });
}

function readImageFrame(file: File, id: string): Promise<GifFrameModel> {
  const previewUrl = URL.createObjectURL(file);
  return loadImage(previewUrl)
    .then((image) => ({
      id,
      file,
      previewUrl,
      name: file.name,
      width: image.naturalWidth,
      height: image.naturalHeight,
      durationMs: DEFAULT_DURATION,
      sourcePath: getSourcePath(file),
    }))
    .catch((error) => {
      URL.revokeObjectURL(previewUrl);
      throw error;
    });
}

function drawGifFrame(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement | HTMLVideoElement,
  canvasSize: GifCanvasSize,
  fitMode: GifFitMode,
  alignment: GifContentAlignment,
  margins: GifContentMargins,
  background: GifBackground,
  customBackgroundColor: string,
) {
  context.clearRect(0, 0, canvasSize.width, canvasSize.height);
  if (background !== "transparent") {
    context.fillStyle = background === "black" ? "#000000" : background === "white" ? "#ffffff" : customBackgroundColor;
    context.fillRect(0, 0, canvasSize.width, canvasSize.height);
  }

  const sourceWidth = image instanceof HTMLVideoElement ? image.videoWidth : image.naturalWidth;
  const sourceHeight = image instanceof HTMLVideoElement ? image.videoHeight : image.naturalHeight;
  const rect = resolveGifContentRect(canvasSize, { width: sourceWidth, height: sourceHeight }, fitMode, alignment, margins);
  const width = Math.max(1, Math.round(canvasSize.width));
  const height = Math.max(1, Math.round(canvasSize.height));
  const left = Math.min(width - 1, Math.max(0, Math.round(margins.left)));
  const top = Math.min(height - 1, Math.max(0, Math.round(margins.top)));
  const right = Math.min(width - left - 1, Math.max(0, Math.round(margins.right)));
  const bottom = Math.min(height - top - 1, Math.max(0, Math.round(margins.bottom)));
  context.save();
  context.beginPath();
  context.rect(left, top, width - left - right, height - top - bottom);
  context.clip();
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
  context.restore();
}

function drawVideoFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  crop: VideoCropRect,
  rotation: VideoRotation,
  outputSize: GifCanvasSize,
) {
  context.clearRect(0, 0, outputSize.width, outputSize.height);
  context.save();
  if (rotation === 90) {
    context.translate(outputSize.width, 0);
    context.rotate(Math.PI / 2);
  } else if (rotation === 180) {
    context.translate(outputSize.width, outputSize.height);
    context.rotate(Math.PI);
  } else if (rotation === 270) {
    context.translate(0, outputSize.height);
    context.rotate(-Math.PI / 2);
  }
  context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  context.restore();
}

async function canvasToBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("无法生成 GIF 帧数据，请重试。");
  return new Uint8Array(await blob.arrayBuffer());
}

function SelectField<T extends string | number>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <label className="gif-field" htmlFor={id}>
      <span>{label}</span>
      <ThemeSelect id={id} value={value} options={options} onChange={onChange} aria-label={label} />
    </label>
  );
}

function EmptyFrames({ onImport, sourceMode }: { onImport: () => void; sourceMode: GifSourceMode }) {
  return (
    <div className="gif-empty-frames">
      <ImagePlus size={24} aria-hidden="true" />
      <strong>还没有动画帧</strong>
      <span>{sourceMode === "video" ? "先导入视频并提取时间范围内的帧。" : "导入多张图片，按顺序组成 GIF。"}</span>
      <button className="quiet-button" type="button" onClick={onImport}>
        <Upload size={15} aria-hidden="true" />{sourceMode === "video" ? "导入视频" : "导入图片"}
      </button>
    </div>
  );
}

export default function GifMakerView({ active = true }: { active?: boolean }) {
  const [savedPreferences] = useState<GifMakerPreferences>(() => loadGifMakerPreferences());
  const [frames, setFrames] = useState<GifFrameModel[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedFrameIndices, setSelectedFrameIndices] = useState<Set<number>>(new Set());
  const selectionAnchorRef = useRef(0);
  const [canvasWidth, setCanvasWidth] = useState(savedPreferences.canvasWidth);
  const [canvasHeight, setCanvasHeight] = useState(savedPreferences.canvasHeight);
  const [canvasPreset, setCanvasPreset] = useState<GifCanvasPreset>(savedPreferences.canvasPreset);
  const [keepAspectRatio, setKeepAspectRatio] = useState(savedPreferences.keepAspectRatio);
  const [fitMode, setFitMode] = useState<GifFitMode>(savedPreferences.fitMode);
  const [contentAlignment, setContentAlignment] = useState<GifContentAlignment>(savedPreferences.contentAlignment);
  const [contentMargins, setContentMargins] = useState<GifContentMargins>(savedPreferences.contentMargins);
  const [background, setBackground] = useState<GifBackground>(savedPreferences.background);
  const [customBackgroundColor, setCustomBackgroundColor] = useState(savedPreferences.customBackgroundColor);
  const [globalDuration, setGlobalDuration] = useState(savedPreferences.globalDuration);
  const [batchDuration, setBatchDuration] = useState(savedPreferences.batchDuration);
  const [firstFrameHoldDuration, setFirstFrameHoldDuration] = useState(savedPreferences.firstFrameHoldDuration);
  const [lastFrameHoldDuration, setLastFrameHoldDuration] = useState(savedPreferences.lastFrameHoldDuration);
  const [playbackSpeed, setPlaybackSpeed] = useState<GifPlaybackSpeed>(savedPreferences.playbackSpeed);
  const [loopMode, setLoopMode] = useState<GifLoopMode>(savedPreferences.loopMode);
  const [loopCount, setLoopCount] = useState(savedPreferences.loopCount);
  const [encodingQuality, setEncodingQuality] = useState<GifEncodingQuality>(savedPreferences.encodingQuality);
  const [colorCount, setColorCount] = useState<GifColorCount>(savedPreferences.colorCount);
  const [ditherMode, setDitherMode] = useState<GifDitherMode>(savedPreferences.ditherMode);
  const [gifPreset, setGifPreset] = useState<GifPreset>(savedPreferences.gifPreset);
  const [targetSizeKiB, setTargetSizeKiB] = useState(savedPreferences.targetSizeKiB);
  const [maxSizeKiB, setMaxSizeKiB] = useState(savedPreferences.maxSizeKiB);
  const [autoCompress, setAutoCompress] = useState(savedPreferences.autoCompress);
  const [mergeIdenticalFrames, setMergeIdenticalFrames] = useState(savedPreferences.mergeIdenticalFrames);
  const [overwriteExisting, setOverwriteExisting] = useState(savedPreferences.overwriteExisting);
  const [measuredSizeBytes, setMeasuredSizeBytes] = useState<number | null>(null);
  const [sizeComparison, setSizeComparison] = useState<GifSizeComparisonState | null>(null);
  const [compressionSummary, setCompressionSummary] = useState<string | null>(null);
  const [exportFrameSummary, setExportFrameSummary] = useState<GifExportFrameSummary | null>(null);
  const [fileName, setFileName] = useState(() => defaultGifFileName(savedPreferences.outputFormat));
  const [outputLocation, setOutputLocation] = useState<GifOutputLocation>("path");
  const [outputSubdirectory, setOutputSubdirectory] = useState("");
  const [outputDirectory, setOutputDirectory] = useState("");
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [sequenceOutputDir, setSequenceOutputDir] = useState<string | null>(null);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);
  const [outputFormat, setOutputFormat] = useState<GifOutputFormat>(savedPreferences.outputFormat);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [sourceMode, setSourceMode] = useState<GifSourceMode>("image");
  const [videoSource, setVideoSource] = useState<VideoSourceModel | null>(null);
  const [videoStart, setVideoStart] = useState(0);
  const [videoEnd, setVideoEnd] = useState(0);
  const [videoFps, setVideoFps] = useState(savedPreferences.videoFps);
  const [videoEveryNthFrame, setVideoEveryNthFrame] = useState(savedPreferences.videoEveryNthFrame);
  const [videoMaxFrames, setVideoMaxFrames] = useState(savedPreferences.videoMaxFrames);
  const [videoCropPreset, setVideoCropPreset] = useState<VideoCropPreset>(savedPreferences.videoCropPreset);
  const [customVideoCrop, setCustomVideoCrop] = useState<VideoCropRect>({ x: 0, y: 0, width: 1, height: 1 });
  const [videoRotation, setVideoRotation] = useState<VideoRotation>(savedPreferences.videoRotation);
  const [videoReverse, setVideoReverse] = useState(savedPreferences.videoReverse);
  const [status, setStatus] = useState<GifStatus>({ kind: "idle", text: "等待导入图片" });
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<GifSettingsGroup | null>(DEFAULT_GIF_SETTINGS_GROUP);
  const [locked, setLocked] = useState(false);
  const [pendingImports, setPendingImports] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceFrameIdRef = useRef<string | null>(null);
  const frameIdRef = useRef(0);
  const importQueueRef = useRef(new GifImportQueue());
  const draggedFrameIndexRef = useRef<number | null>(null);
  const lockedRef = useRef(false);
  const pendingRef = useRef(0);
  const initializedRef = useRef(false);
  const videoExtractControllerRef = useRef<AbortController | null>(null);
  const ratioRef = useRef<GifCanvasSize>({ width: savedPreferences.canvasWidth, height: savedPreferences.canvasHeight });
  const repeatRef = useRef(0);
  const framesRef = useRef<GifFrameModel[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const clearOutputSelection = () => {
    setOutputPath(null);
    setSequenceOutputDir(null);
    setLastExportPath(null);
  };

  const changeOutputLocation = (location: GifOutputLocation) => {
    setOutputLocation(location);
    clearOutputSelection();
    const nextError = getGifOutputLocationError(location, getGifSourcePath(frames), outputSubdirectory, outputDirectory, isTauriEnvironment());
    setError(nextError);
    if (nextError) setStatus({ kind: "error", text: "输出位置不可用" });
  };

  const changeOutputFormat = (format: GifOutputFormat) => {
    setOutputFormat(format);
    clearOutputSelection();
    setMeasuredSizeBytes(null);
    setFileName((current) => {
      const stem = current.trim().replace(/\.[^.]+$/u, "");
      if (format === "png-sequence") return stem || "embedpix-animation";
      const extension = format === "gif" ? "gif" : format;
      return `${stem || "embedpix-animation"}.${extension}`;
    });
  };

  framesRef.current = frames;

  useEffect(() => () => {
    importQueueRef.current.cancel();
    videoExtractControllerRef.current?.abort();
    framesRef.current.forEach((frame) => URL.revokeObjectURL(frame.previewUrl));
    if (videoSource) URL.revokeObjectURL(videoSource.previewUrl);
  }, [videoSource]);

  useEffect(() => {
    saveGifMakerPreferences({
      canvasPreset,
      canvasWidth,
      canvasHeight,
      keepAspectRatio,
      fitMode,
      contentAlignment,
      contentMargins,
      globalDuration,
      batchDuration,
      firstFrameHoldDuration,
      lastFrameHoldDuration,
      playbackSpeed,
      background,
      customBackgroundColor,
      loopMode,
      loopCount,
      encodingQuality,
      colorCount,
      ditherMode,
      gifPreset,
      targetSizeKiB,
      maxSizeKiB,
      autoCompress,
      mergeIdenticalFrames,
      overwriteExisting,
      outputFormat,
      videoFps,
      videoEveryNthFrame,
      videoMaxFrames,
      videoCropPreset,
      videoRotation,
      videoReverse,
    });
  }, [autoCompress, background, batchDuration, canvasHeight, canvasPreset, canvasWidth, colorCount, contentAlignment, contentMargins, customBackgroundColor, ditherMode, encodingQuality, fitMode, firstFrameHoldDuration, gifPreset, globalDuration, keepAspectRatio, lastFrameHoldDuration, loopCount, loopMode, maxSizeKiB, mergeIdenticalFrames, outputFormat, overwriteExisting, playbackSpeed, targetSizeKiB, videoCropPreset, videoEveryNthFrame, videoFps, videoMaxFrames, videoReverse, videoRotation]);

  useEffect(() => {
    setMeasuredSizeBytes(null);
    setSizeComparison(null);
    setCompressionSummary(null);
    setExportFrameSummary(null);
  }, [autoCompress, background, canvasHeight, canvasWidth, colorCount, contentAlignment, contentMargins, customBackgroundColor, ditherMode, encodingQuality, firstFrameHoldDuration, fitMode, frames, globalDuration, lastFrameHoldDuration, loopCount, loopMode, maxSizeKiB, mergeIdenticalFrames, outputFormat, targetSizeKiB]);

  const selectedFrame = frames[selectedIndex] ?? null;
  const sourcePath = useMemo(() => getGifSourcePath(frames), [frames]);
  const outputLocationError = useMemo(
    () => getGifOutputLocationError(outputLocation, sourcePath, outputSubdirectory, outputDirectory, isTauriEnvironment()),
    [outputDirectory, outputLocation, outputSubdirectory, sourcePath],
  );
  const singleOutputReady = outputLocation === "path"
    ? outputFormat === "png-sequence" ? Boolean(sequenceOutputDir) : Boolean(outputPath)
    : !outputLocationError;
  const canvasSize = useMemo(
    () => ({ width: canvasWidth, height: canvasHeight }),
    [canvasHeight, canvasWidth],
  );
  const workload = useMemo(
    () => estimateGifWorkload(canvasSize, frames.length, colorCount),
    [canvasSize, colorCount, frames.length],
  );
  const timeline = useMemo(() => {
    const durations = frames.map((frame, index) => calculateBoundaryFrameDuration(
      frame.durationMs,
      frames.length === 1
        ? firstFrameHoldDuration + lastFrameHoldDuration
        : index === 0 ? firstFrameHoldDuration : index === frames.length - 1 ? lastFrameHoldDuration : 0,
    ));
    return {
      currentMs: durations.slice(0, selectedIndex).reduce((total, duration) => total + duration, 0),
      totalMs: durations.reduce((total, duration) => total + duration, 0),
    };
  }, [firstFrameHoldDuration, frames, lastFrameHoldDuration, selectedIndex]);
  const exportParameterSummary = useMemo(() => {
    const format = outputFormat === "png-sequence" ? "PNG 帧序列" : outputFormat === "webp" ? "WebP 动图" : outputFormat === "apng" ? "APNG 动图" : "GIF 动图";
    const fit = fitMode === "contain" ? "适应画布" : fitMode === "cover" ? "裁剪填充" : "拉伸填满";
    const alignment = contentAlignment === "top" ? "上对齐" : contentAlignment === "bottom" ? "下对齐" : "居中";
    const margins = `${contentMargins.top}/${contentMargins.right}/${contentMargins.bottom}/${contentMargins.left}`;
    const mergeEnabled = mergeIdenticalFrames && outputFormat !== "png-sequence";
    const frameCount = exportFrameSummary?.frameCount ?? frames.length;
    const totalDurationMs = exportFrameSummary?.totalDurationMs ?? timeline.totalMs;
    const frameSummary = mergeEnabled
      ? exportFrameSummary ? `${frameCount} 帧（已合并）` : `${frames.length} 帧（导出时合并）`
      : `${frameCount} 帧`;
    const details = [`${canvasSize.width} × ${canvasSize.height} px`, frameSummary, `总时长 ${formatGifTimelineTime(totalDurationMs)}`, `基准 ${fpsFromFrameDuration(globalDuration)} FPS`, `${fit} · ${alignment}`, `边距 ${margins} px`, overwriteExisting ? "覆盖同名" : outputFormat === "png-sequence" ? "自动序号" : "拒绝同名"];
    if (outputFormat === "gif") {
      const dither = ditherMode === "none" ? "无抖动" : ditherMode === "atkinson" ? "Atkinson" : "Floyd-Steinberg";
      const quality = encodingQuality === "high" ? "高质量编码" : encodingQuality === "balanced" ? "平衡编码" : "快速编码";
      details.push(`${colorCount} 色`, dither, quality, loopMode === "infinite" ? "无限循环" : `重复 ${loopCount} 次`);
      if (autoCompress) details.push("自动压缩");
      if (mergeEnabled) details.push("合并连续相同帧");
      if (targetSizeKiB.trim()) details.push(`目标 ≤ ${targetSizeKiB.trim()} KiB`);
      if (maxSizeKiB.trim()) details.push(`上限 ≤ ${maxSizeKiB.trim()} KiB`);
    } else if (outputFormat === "webp" || outputFormat === "apng") {
      if (autoCompress) details.push("自动压缩");
      if (mergeEnabled) details.push("合并连续相同帧");
      if (targetSizeKiB.trim()) details.push(`目标 ≤ ${targetSizeKiB.trim()} KiB`);
      if (maxSizeKiB.trim()) details.push(`上限 ≤ ${maxSizeKiB.trim()} KiB`);
    } else if (outputFormat === "png-sequence") {
      if (autoCompress) details.push("自动压缩");
      if (targetSizeKiB.trim()) details.push(`目标 ≤ ${targetSizeKiB.trim()} KiB`);
      if (maxSizeKiB.trim()) details.push(`上限 ≤ ${maxSizeKiB.trim()} KiB`);
    }
    return `${format} · ${details.join(" · ")}`;
  }, [autoCompress, canvasSize, colorCount, contentAlignment, contentMargins, ditherMode, encodingQuality, exportFrameSummary, fitMode, frames.length, globalDuration, loopCount, loopMode, maxSizeKiB, mergeIdenticalFrames, outputFormat, overwriteExisting, targetSizeKiB, timeline.totalMs]);
  const compressionComparisonSummary = useMemo(() => {
    if (!sizeComparison) return null;
    const summary = compareGifSizes(sizeComparison);
    const change = summary.reduced ? `减少 ${summary.changePercent.toFixed(1)}%` : `增加 ${summary.changePercent.toFixed(1)}%`;
    const targetStatus = summary.meetsTarget === null
      ? "目标未设置"
      : summary.meetsTarget ? "达到目标" : "未达到目标";
    const maxStatus = summary.withinMax === null
      ? "上限未设置"
      : summary.withinMax ? "未超过上限" : "超过上限";
    return {
      size: `压缩前 ${formatGifBytes(sizeComparison.baselineBytes)} → 压缩后 ${formatGifBytes(sizeComparison.finalBytes)} · 保留 ${summary.ratioPercent.toFixed(1)}%（${change}）`,
      limits: `${targetStatus} · ${maxStatus}`,
    };
  }, [sizeComparison]);

  useEffect(() => { if (!active) setIsPlaying(false); }, [active]);

  useEffect(() => {
    if (!frames.length) {
      setSelectedIndex(0);
      setSelectedFrameIndices(new Set());
      setIsPlaying(false);
      return;
    }
    setSelectedIndex((current) => Math.min(current, frames.length - 1));
    setSelectedFrameIndices((current) => new Set([...current].filter((index) => index < frames.length)));
  }, [frames.length]);

  useEffect(() => {
    if (!active || !isPlaying || frames.length < 2) return undefined;
    const timer = window.setTimeout(() => {
      const next = advanceGifPlayback(selectedIndex, frames.length, repeatRef.current, loopMode, loopCount);
      repeatRef.current = next.repeats;
      setSelectedIndex(next.index);
      if (next.stopped) setIsPlaying(false);
    }, previewFrameDurationAtSpeed(
      calculateBoundaryFrameDuration(
        frames[selectedIndex]?.durationMs ?? DEFAULT_DURATION,
        frames.length === 1
          ? firstFrameHoldDuration + lastFrameHoldDuration
          : selectedIndex === 0 ? firstFrameHoldDuration : selectedIndex === frames.length - 1 ? lastFrameHoldDuration : 0,
      ),
      playbackSpeed,
    ));
    return () => window.clearTimeout(timer);
  }, [active, firstFrameHoldDuration, frames, isPlaying, lastFrameHoldDuration, loopCount, loopMode, playbackSpeed, selectedIndex]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || !canvas || !selectedFrame) return;
    let cancelled = false;
    canvas.width = canvasSize.width;
    canvas.height = canvasSize.height;
    void loadImage(selectedFrame.previewUrl).then((image) => {
      if (cancelled) return;
      const context = canvas.getContext("2d");
      if (context) drawGifFrame(context, image, canvasSize, fitMode, contentAlignment, contentMargins, background, customBackgroundColor);
    }).catch(() => {
      if (!cancelled) setError("预览帧读取失败，请重新导入图片。");
    });
    return () => { cancelled = true; };
  }, [active, background, canvasSize, contentAlignment, contentMargins, customBackgroundColor, fitMode, selectedFrame]);

  const openFileDialog = (frameId: string | null = null) => {
    if (lockedRef.current) return;
    replaceFrameIdRef.current = frameId;
    fileInputRef.current?.click();
  };

  const invalidateVideoFrames = () => {
    framesRef.current.forEach((frame) => URL.revokeObjectURL(frame.previewUrl));
    framesRef.current = [];
    setFrames([]);
    setSelectedIndex(0);
    setSelectedFrameIndices(new Set());
    setIsPlaying(false);
    clearOutputSelection();
  };

  const markVideoFramesStale = () => {
    if (!framesRef.current.length) return;
    invalidateVideoFrames();
    setStatus({ kind: "ready", text: "视频参数已更新，请重新提取帧" });
  };

  const updateVideoTransform = (cropPreset: VideoCropPreset, rotation: VideoRotation) => {
    setVideoCropPreset(cropPreset);
    setVideoRotation(rotation);
    if (!videoSource) return;
    const crop = resolveVideoCrop(videoSource.width, videoSource.height, cropPreset, customVideoCrop);
    const outputSize = resolveVideoOutputSize(crop, rotation);
    setCanvasWidth(outputSize.width);
    setCanvasHeight(outputSize.height);
    setCanvasPreset(cropPreset === "original" && rotation === 0 ? "source" : "custom");
    ratioRef.current = outputSize;
    markVideoFramesStale();
  };

  const updateCustomVideoCrop = (field: VideoCropField, value: number) => {
    if (!videoSource) return;
    const next = normalizeVideoCropRect(
      { ...customVideoCrop, [field]: Number.isFinite(value) ? Math.floor(value) : 0 },
      videoSource.width,
      videoSource.height,
    );
    setCustomVideoCrop(next);
    setVideoCropPreset("custom");
    setCanvasPreset("custom");
    const outputSize = resolveVideoOutputSize(next, videoRotation);
    setCanvasWidth(outputSize.width);
    setCanvasHeight(outputSize.height);
    ratioRef.current = outputSize;
    markVideoFramesStale();
  };

  const importVideo = async (file: File) => {
    if (lockedRef.current || !isVideoFile(file)) {
      setError("请选择 MP4、WebM 或 OGG 视频文件。");
      setStatus({ kind: "error", text: "视频导入失败" });
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    setIsPlaying(false);
    setError(null);
    setCompressionSummary(null);
    setStatus({ kind: "importing", text: "正在读取视频信息…" });
    try {
      const metadata = await loadVideoMetadata(previewUrl);
      if (videoSource) URL.revokeObjectURL(videoSource.previewUrl);
      const nextSource = { file, previewUrl, name: file.name, sourcePath: getSourcePath(file), ...metadata };
      setVideoSource(nextSource);
      setVideoStart(0);
      setVideoEnd(metadata.duration);
      setVideoEveryNthFrame(1);
      setVideoMaxFrames(MAX_VIDEO_FRAME_LIMIT);
      setVideoCropPreset("original");
      setCustomVideoCrop({ x: 0, y: 0, width: metadata.width, height: metadata.height });
      setVideoRotation(0);
      setVideoReverse(false);
      setFrames((current) => {
        current.forEach((frame) => URL.revokeObjectURL(frame.previewUrl));
        return [];
      });
      framesRef.current = [];
      setSelectedIndex(0);
      clearOutputSelection();
      setCanvasWidth(metadata.width);
      setCanvasHeight(metadata.height);
      setCanvasPreset("source");
      ratioRef.current = metadata;
      initializedRef.current = true;
      setStatus({ kind: "ready", text: `已载入视频：${formatVideoTime(metadata.duration)}` });
    } catch (loadError) {
      URL.revokeObjectURL(previewUrl);
      setError(getErrorMessage(loadError));
      setStatus({ kind: "error", text: "视频导入失败" });
    }
  };

  const extractVideo = async () => {
    if (lockedRef.current || !videoSource) {
      setError("请先导入视频。");
      return;
    }
    const start = Math.max(0, Math.min(videoSource.duration, videoStart));
    const end = Math.max(start, Math.min(videoSource.duration, videoEnd));
    if (end - start < 0.01) {
      setError("视频时间范围至少需要 0.01 秒。");
      return;
    }
    const plan = planVideoFramesWithSampling(start, end, videoSource.duration, videoFps, {
      everyNthFrame: videoEveryNthFrame,
      maxFrames: videoMaxFrames,
    });
    const crop = resolveVideoCrop(videoSource.width, videoSource.height, videoCropPreset, customVideoCrop);
    const outputSize = resolveVideoOutputSize(crop, videoRotation);
    const extractionPlan = videoReverse ? { ...plan, times: [...plan.times].reverse() } : plan;
    setIsPlaying(false);
    lockedRef.current = true;
    setLocked(true);
    setError(null);
    setStatus({ kind: "importing", text: `正在提取视频帧 0/${extractionPlan.times.length}…` });
    const controller = new AbortController();
    videoExtractControllerRef.current = controller;
    try {
      const extractedFrames = await extractVideoFrameBlobs(videoSource, extractionPlan, crop, videoRotation, outputSize, (current, total) => {
        setStatus({ kind: "importing", text: `正在提取视频帧 ${current}/${total}…` });
      }, {
        createVideo: () => document.createElement("video"),
        createCanvas: () => document.createElement("canvas"),
        drawFrame: drawVideoFrame,
        createObjectURL: (blob) => URL.createObjectURL(blob),
        revokeObjectURL: (url) => URL.revokeObjectURL(url),
      }, controller.signal);
      let nextFrames: GifFrameModel[];
      try {
        nextFrames = extractedFrames.map(({ blob, previewUrl, durationMs }, index) => {
          const file = new File([blob], `${videoSource.name.replace(/\.[^.]+$/u, "")}-${String(index + 1).padStart(3, "0")}.png`, { type: "image/png" });
          return {
            id: `video-frame-${index + 1}`,
            file,
            previewUrl,
            name: file.name,
            width: outputSize.width,
            height: outputSize.height,
            durationMs,
            sourcePath: videoSource.sourcePath,
          };
        });
      } catch (error) {
        extractedFrames.forEach((frame) => URL.revokeObjectURL(frame.previewUrl));
        throw error;
      }
      framesRef.current.forEach((frame) => URL.revokeObjectURL(frame.previewUrl));
      framesRef.current = nextFrames;
      setFrames(nextFrames);
      setSelectedIndex(0);
      setSelectedFrameIndices(nextFrames.length ? new Set([0]) : new Set());
      clearOutputSelection();
      setCanvasWidth(outputSize.width);
      setCanvasHeight(outputSize.height);
      setStatus({ kind: "ready", text: `已提取 ${nextFrames.length} 帧，可以预览或导出` });
    } catch (extractError) {
      if (controller.signal.aborted) {
        setError(null);
        setStatus({ kind: "ready", text: "已取消视频抽帧" });
      } else {
        setError(getErrorMessage(extractError));
        setStatus({ kind: "error", text: "视频抽帧失败" });
      }
    } finally {
      if (videoExtractControllerRef.current === controller) videoExtractControllerRef.current = null;
      lockedRef.current = false;
      setLocked(false);
    }
  };

  const cancelVideoExtraction = () => {
    videoExtractControllerRef.current?.abort();
  };

  const importFiles = async (inputFiles: File[], replaceFrameId: string | null = null) => {
    if (lockedRef.current || !inputFiles.length) return;
    const imageFiles = inputFiles.filter(isImageFile);
    if (imageFiles.length !== inputFiles.length) {
      setError("请选择 PNG、JPEG、BMP 或 WEBP 静态图片；不支持视频和 GIF 拆帧。");
      setStatus({ kind: "error", text: "导入失败" });
      return;
    }
    const filesToRead = replaceFrameId ? imageFiles.slice(0, 1) : imageFiles;
    pendingRef.current += 1;
    setPendingImports(pendingRef.current);
    setIsPlaying(false);
    setError(null);
    setStatus({ kind: "importing", text: `正在读取 ${filesToRead.length} 张图片…` });
    try {
      await importQueueRef.current.run(async (isCurrent) => {
        const retained = framesRef.current.filter((frame) => frame.id !== replaceFrameId);
        validateGifFiles([...retained.map((frame) => frame.file), ...filesToRead]);
        let pixels = retained.reduce((sum, frame) => sum + frame.width * frame.height, 0);
        const loadedFrames = await readGifBatch(filesToRead, async (file) => {
          const frame = await readImageFrame(file, `gif-frame-${++frameIdRef.current}`);
          try {
            validateGifPixels(frame, 1);
            pixels += frame.width * frame.height;
            if (pixels > MAX_TOTAL_PIXELS) throw new Error("素材累计像素超过 64 Mi，请减少图片或先缩小原图。");
            return { ...frame, durationMs: globalDuration };
          } catch (loadError) { URL.revokeObjectURL(frame.previewUrl); throw loadError; }
        }, (frame) => URL.revokeObjectURL(frame.previewUrl), isCurrent);
        if (!isCurrent() || !loadedFrames.length) return;
        const current = framesRef.current;
        const index = current.findIndex((frame) => frame.id === replaceFrameId);
        if (replaceFrameId && index < 0) {
          loadedFrames.forEach((frame) => URL.revokeObjectURL(frame.previewUrl));
          return;
        }
        if (!initializedRef.current) {
          initializedRef.current = true;
          ratioRef.current = loadedFrames[0];
          setCanvasWidth(loadedFrames[0].width);
          setCanvasHeight(loadedFrames[0].height);
          setCanvasPreset("source");
        }
        const next = replaceFrameId ? current.map((frame, i) => i === index ? { ...loadedFrames[0], durationMs: frame.durationMs } : frame) : [...current, ...loadedFrames];
        if (index >= 0) URL.revokeObjectURL(current[index].previewUrl);
        framesRef.current = next;
        setFrames(next);
        setSelectedIndex(replaceFrameId ? index : current.length);
        setSelectedFrameIndices(new Set([replaceFrameId ? index : current.length]));
        setStatus({ kind: "ready", text: `已加入 ${loadedFrames.length} 张图片` });
      });
    } catch (loadError) {
      setError(getErrorMessage(loadError));
      setStatus({ kind: "error", text: "导入失败" });
    } finally {
      pendingRef.current -= 1;
      setPendingImports(pendingRef.current);
    }
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    const replaceFrameId = replaceFrameIdRef.current;
    replaceFrameIdRef.current = null;
    event.target.value = "";
    if (sourceMode === "video") {
      if (selectedFiles[0]) void importVideo(selectedFiles[0]);
    } else {
      void importFiles(selectedFiles, replaceFrameId);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const droppedFiles = Array.from(event.dataTransfer.files);
    if (sourceMode === "video") {
      if (droppedFiles[0]) void importVideo(droppedFiles[0]);
    } else {
      void importFiles(droppedFiles);
    }
  };

  const removeFrame = (index: number) => {
    if (lockedRef.current) return;
    setIsPlaying(false);
    const frame = frames[index];
    if (!frame) return;
    URL.revokeObjectURL(frame.previewUrl);
    const next = frames.filter((_, frameIndex) => frameIndex !== index);
    framesRef.current = next;
    setFrames(next);
    const nextIndex = next.length ? Math.min(index, next.length - 1) : 0;
    setSelectedIndex(nextIndex);
    setSelectedFrameIndices(next.length ? new Set([nextIndex]) : new Set());
    selectionAnchorRef.current = nextIndex;
    setStatus({ kind: "ready", text: "已移除一帧" });
  };

  const selectFrame = (index: number, event: MouseEvent<HTMLButtonElement>) => {
    setIsPlaying(false);
    if (event.shiftKey) {
      const start = Math.min(selectionAnchorRef.current, index);
      const end = Math.max(selectionAnchorRef.current, index);
      setSelectedFrameIndices(new Set(Array.from({ length: end - start + 1 }, (_, offset) => start + offset)));
    } else if (event.ctrlKey || event.metaKey) {
      setSelectedFrameIndices((current) => {
        const next = new Set(current);
        if (next.has(index)) next.delete(index); else next.add(index);
        return next;
      });
      selectionAnchorRef.current = index;
    } else {
      setSelectedFrameIndices(new Set([index]));
      selectionAnchorRef.current = index;
    }
    setSelectedIndex(index);
  };

  const seekPreviewFrame = (value: number) => {
    if (!frames.length) return;
    const index = Math.min(frames.length - 1, Math.max(0, Math.floor(value)));
    setIsPlaying(false);
    setSelectedIndex(index);
    setSelectedFrameIndices(new Set([index]));
    selectionAnchorRef.current = index;
  };

  const copySelectedFrame = () => {
    if (lockedRef.current || !selectedFrame) return;
    try {
      validateGifFiles([...frames.map((frame) => frame.file), selectedFrame.file]);
    } catch (copyError) {
      setError(getErrorMessage(copyError));
      setStatus({ kind: "error", text: "复制失败" });
      return;
    }
    const insertAt = selectedIndex + 1;
    const copy = { ...selectedFrame, id: `gif-frame-${++frameIdRef.current}`, previewUrl: URL.createObjectURL(selectedFrame.file), name: `${selectedFrame.name.replace(/(\.[^.]+)$/u, "")}-copy$1` };
    const next = [...frames.slice(0, insertAt), copy, ...frames.slice(insertAt)];
    framesRef.current = next;
    setFrames(next);
    setSelectedIndex(insertAt);
    setSelectedFrameIndices(new Set([insertAt]));
    selectionAnchorRef.current = insertAt;
    setStatus({ kind: "ready", text: "已复制当前帧" });
  };

  const removeSelectedFrames = () => {
    if (lockedRef.current || !selectedFrameIndices.size) return;
    setIsPlaying(false);
    selectedFrameIndices.forEach((index) => { const frame = frames[index]; if (frame) URL.revokeObjectURL(frame.previewUrl); });
    const next = frames.filter((_, index) => !selectedFrameIndices.has(index));
    framesRef.current = next;
    setFrames(next);
    const nextIndex = next.length ? Math.min(selectedIndex, next.length - 1) : 0;
    setSelectedIndex(nextIndex);
    setSelectedFrameIndices(next.length ? new Set([nextIndex]) : new Set());
    selectionAnchorRef.current = nextIndex;
    setStatus({ kind: "ready", text: `已移除 ${selectedFrameIndices.size} 帧` });
  };

  const moveFrame = (index: number, direction: -1 | 1) => {
    if (lockedRef.current) return;
    setIsPlaying(false);
    const targetIndex = getGifFrameOrder(frames.length, index, direction);
    if (targetIndex === index || targetIndex < 0) return;
    const next = [...frames];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    framesRef.current = next;
    setFrames(next);
    setSelectedFrameIndices((current) => new Set([...current].map((selected) => selected === index ? targetIndex : selected === targetIndex ? index : selected)));
    setSelectedIndex(targetIndex);
    selectionAnchorRef.current = targetIndex;
  };

  const reorderFrame = (fromIndex: number, toIndex: number) => {
    if (lockedRef.current || fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= frames.length || toIndex >= frames.length) return;
    setIsPlaying(false);
    const remapIndex = (index: number) => {
      if (index === fromIndex) return toIndex;
      if (fromIndex < toIndex && index > fromIndex && index <= toIndex) return index - 1;
      if (fromIndex > toIndex && index >= toIndex && index < fromIndex) return index + 1;
      return index;
    };
    const next = [...frames];
    const [moved] = next.splice(fromIndex, 1);
    if (!moved) return;
    next.splice(toIndex, 0, moved);
    framesRef.current = next;
    setFrames(next);
    setSelectedIndex((current) => remapIndex(current));
    setSelectedFrameIndices((current) => new Set([...current].map(remapIndex)));
    selectionAnchorRef.current = remapIndex(selectionAnchorRef.current);
    setStatus({ kind: "ready", text: "已调整帧顺序" });
  };

  const handleFrameDragStart = (event: DragEvent<HTMLDivElement>, index: number) => {
    if (lockedRef.current) return;
    draggedFrameIndexRef.current = index;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  };

  const handleFrameDrop = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault();
    const fromIndex = draggedFrameIndexRef.current;
    draggedFrameIndexRef.current = null;
    if (fromIndex !== null) reorderFrame(fromIndex, index);
  };

  const reverseFrames = () => {
    if (lockedRef.current) return;
    setIsPlaying(false);
    const next = [...frames].reverse();
    framesRef.current = next;
    setFrames(next);
    setSelectedIndex((current) => Math.max(0, frames.length - current - 1));
    setSelectedFrameIndices((current) => new Set([...current].map((index) => frames.length - index - 1)));
    selectionAnchorRef.current = Math.max(0, frames.length - selectionAnchorRef.current - 1);
  };

  const clearFrames = () => {
    if (lockedRef.current) return;
    importQueueRef.current.cancel();
    frames.forEach((frame) => URL.revokeObjectURL(frame.previewUrl));
    framesRef.current = [];
    setFrames([]);
    setSelectedIndex(0);
    setSelectedFrameIndices(new Set());
    selectionAnchorRef.current = 0;
    setIsPlaying(false);
    clearOutputSelection();
    setStatus({ kind: "idle", text: "等待导入图片" });
    setError(null);
  };

  const updateCanvasWidth = (value: number) => {
    initializedRef.current = true;
    setCanvasPreset("custom");
    setGifPreset("custom");
    setMeasuredSizeBytes(null);
    const next = resolveGifCanvasSize(ratioRef.current, value, canvasHeight, keepAspectRatio);
    setCanvasWidth(next.width);
    setCanvasHeight(next.height);
  };

  const updateCanvasHeight = (value: number) => {
    initializedRef.current = true;
    setCanvasPreset("custom");
    setGifPreset("custom");
    setMeasuredSizeBytes(null);
    const next = resolveGifCanvasSize({ width: ratioRef.current.height, height: ratioRef.current.width }, value, canvasWidth, keepAspectRatio);
    setCanvasHeight(next.width);
    setCanvasWidth(next.height);
  };

  const applyCanvasPreset = (preset: GifCanvasPreset, fromGifPreset = false) => {
    setCanvasPreset(preset);
    if (!fromGifPreset) {
      setGifPreset("custom");
      setMeasuredSizeBytes(null);
    }
    if (preset === "custom") return;
    const next = resolveGifCanvasPreset(ratioRef.current, preset);
    setCanvasWidth(next.width);
    setCanvasHeight(next.height);
    setKeepAspectRatio(true);
  };

  const applyGifPreset = (preset: Exclude<GifPreset, "custom">) => {
    const config = GIF_PRESETS[preset];
    setGifPreset(preset);
    setEncodingQuality(config.encodingQuality);
    setColorCount(config.colorCount);
    setDitherMode(config.ditherMode);
    setMeasuredSizeBytes(null);
    applyCanvasPreset(config.canvasPreset, true);
  };

  const updateGifEncodingQuality = (value: GifEncodingQuality) => {
    setEncodingQuality(value);
    setGifPreset("custom");
    setMeasuredSizeBytes(null);
  };

  const updateGifColorCount = (value: GifColorCount) => {
    setColorCount(value);
    setGifPreset("custom");
    setMeasuredSizeBytes(null);
  };

  const updateGifDitherMode = (value: GifDitherMode) => {
    setDitherMode(value);
    setGifPreset("custom");
    setMeasuredSizeBytes(null);
  };

  const updateAllDurations = (value: number) => {
    const duration = clampFrameDuration(value);
    setGlobalDuration(duration);
    setFrames((current) => current.map((frame) => ({ ...frame, durationMs: duration })));
  };

  const updateAnimationFps = (value: number) => {
    updateAllDurations(durationFromGifFps(value));
  };

  const updateSelectedDuration = (value: number) => {
    const duration = clampFrameDuration(value);
    setFrames((current) => current.map((frame, index) => index === selectedIndex ? { ...frame, durationMs: duration } : frame));
  };

  const updateSelectedFramesDuration = () => {
    if (lockedRef.current || !selectedFrameIndices.size) return;
    const duration = clampFrameDuration(batchDuration);
    setBatchDuration(duration);
    setFrames((current) => current.map((frame, index) => selectedFrameIndices.has(index) ? { ...frame, durationMs: duration } : frame));
  };

  const chooseOutput = async () => {
    if (lockedRef.current) return;
    if (outputLocation !== "path") {
      const message = outputLocationError ?? "当前输出位置不需要手动选择文件。";
      setError(message);
      setStatus({ kind: "error", text: "输出位置不可用" });
      return;
    }
    lockedRef.current = true;
    setLocked(true);
    setIsPlaying(false);
    try {
      if (outputFormat === "png-sequence") {
        const chosen = await pickGifSequenceOutput();
        if (chosen) {
          setSequenceOutputDir(chosen);
          setOutputPath(null);
          setLastExportPath(null);
          setError(null);
          setStatus({ kind: "ready", text: "已选择 PNG 帧序列输出目录" });
        }
      } else if (outputFormat === "gif") {
        const chosen = await pickGifOutput(fileName.trim() || DEFAULT_FILE_NAME);
        if (chosen) {
          setOutputPath(chosen);
          setSequenceOutputDir(null);
          setLastExportPath(null);
          setError(null);
          setStatus({ kind: "ready", text: "已选择 GIF 保存位置" });
        }
      } else {
        const chosen = await pickAnimationOutput(outputFormat, fileName.trim() || `embedpix-animation.${outputFormat}`);
        if (chosen) {
          setOutputPath(chosen);
          setSequenceOutputDir(null);
          setLastExportPath(null);
          setError(null);
          setStatus({ kind: "ready", text: `已选择 ${outputFormat.toUpperCase()} 动图保存位置` });
        }
      }
    } catch (chooseError) {
      setError(getErrorMessage(chooseError));
      setStatus({ kind: "error", text: "无法选择保存位置" });
    } finally {
      lockedRef.current = false;
      setLocked(false);
    }
  };

  const renderExportFrames = async (size: GifCanvasSize): Promise<GifExportFrame[]> => {
    validateGifPixels(size, frames.length);
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = size.width;
    exportCanvas.height = size.height;
    const context = exportCanvas.getContext("2d");
    if (!context) throw new Error("当前环境无法创建 GIF 画布。");
    const rendered: GifExportFrame[] = [];
    try {
      for (const [index, frame] of frames.entries()) {
        let data: Uint8Array;
        const image = await loadImage(frame.previewUrl);
        drawGifFrame(context, image, size, fitMode, contentAlignment, contentMargins, background, customBackgroundColor);
        data = await canvasToBytes(exportCanvas);
        const holdDuration = frames.length === 1
          ? firstFrameHoldDuration + lastFrameHoldDuration
          : index === 0 ? firstFrameHoldDuration : index === frames.length - 1 ? lastFrameHoldDuration : 0;
        rendered.push({ data, durationMs: calculateBoundaryFrameDuration(frame.durationMs, holdDuration) });
      }
      validateGifFiles(rendered.map((entry) => ({ size: entry.data.byteLength })));
      return rendered;
    } finally {
      exportCanvas.width = 0;
      exportCanvas.height = 0;
    }
  };

  const prepareAnimatedExportFrames = (rendered: GifExportFrame[]): GifExportFrame[] => {
    const prepared = mergeIdenticalFrames ? mergeConsecutiveIdenticalFrames(rendered) : rendered;
    setExportFrameSummary({
      frameCount: prepared.length,
      totalDurationMs: prepared.reduce((total, frame) => total + frame.durationMs, 0),
    });
    return prepared;
  };

  const createAnimationExportRequest = (exportFrames: GifExportFrame[], size: GifCanvasSize = canvasSize): AnimationExportRequest => ({
    outputPath: outputPath ?? undefined,
    outputLocation,
    fileName: fileName.trim() || undefined,
    sourcePath,
    outputSubdirectory: outputSubdirectory.trim() || undefined,
    outputDirectory: outputDirectory.trim() || undefined,
    width: size.width,
    height: size.height,
    loopMode,
    loopCount: loopMode === "finite" ? Math.max(1, Math.round(loopCount)) : 0,
    frames: exportFrames,
    overwriteExisting,
  });

  const createPngSequenceSizeRequest = (exportFrames: GifExportFrame[]) => ({
    baseName: fileName.trim().replace(/\.[^.]+$/u, "") || "embedpix-animation",
    frames: exportFrames,
  });

  const measureCompressionCandidates = async (forceMeasure = false): Promise<GifCompressionResult> => {
    const targetBytes = parseSizeBytes(targetSizeKiB);
    const maxBytes = parseSizeBytes(maxSizeKiB);
    if (targetSizeKiB.trim() && targetBytes === undefined) throw new Error("目标文件大小必须是大于 0 的数字。");
    if (maxSizeKiB.trim() && maxBytes === undefined) throw new Error("最大文件大小必须是大于 0 的数字。");
    if (targetBytes !== undefined && maxBytes !== undefined && targetBytes > maxBytes) {
      throw new Error("目标文件大小不能大于最大文件大小。");
    }

    setStatus({ kind: "exporting", text: `正在准备 GIF 帧 ${frames.length} 帧…` });
    const renderedBaseFrames = await renderExportFrames(canvasSize);
    const baseFrames = mergeIdenticalFrames ? mergeConsecutiveIdenticalFrames(renderedBaseFrames) : renderedBaseFrames;
    const shouldMeasure = forceMeasure || autoCompress || targetBytes !== undefined || maxBytes !== undefined;
    if (!shouldMeasure) {
      return { bytes: 0, frames: baseFrames, width: canvasSize.width, height: canvasSize.height, colorCount, samplingEvery: 1, mergedIdenticalFrames: mergeIdenticalFrames };
    }
    const colors = getGifCompressionColorCandidates(colorCount);
    const sizes = [
      canvasSize,
      resolveGifCanvasSize(canvasSize, canvasSize.width * 0.75, canvasSize.height * 0.75, false),
      resolveGifCanvasSize(canvasSize, canvasSize.width * 0.5, canvasSize.height * 0.5, false),
    ].filter((size, index, all) => index === all.findIndex((candidate) => candidate.width === size.width && candidate.height === size.height));
    const frameVariants = autoCompress
      ? getGifSamplingCandidates(baseFrames.length).flatMap((samplingEvery) => {
        const sampled = sampleGifFrames(baseFrames, samplingEvery);
        const merged = mergeConsecutiveIdenticalFrames(sampled);
        return mergeIdenticalFrames
          ? [{ frames: merged, samplingEvery, mergedIdenticalFrames: true }]
          : [
              { frames: sampled, samplingEvery, mergedIdenticalFrames: false },
              { frames: merged, samplingEvery, mergedIdenticalFrames: true },
            ];
      })
      : [{ frames: baseFrames, samplingEvery: 1, mergedIdenticalFrames: mergeIdenticalFrames }];
    let best: GifCompressionResult | null = null;
    let baselineBytes: number | undefined;
    let attempt = 0;
    const totalAttempts = autoCompress ? colors.length * frameVariants.length * sizes.length : 1;

    for (const size of sizes) {
      for (const candidate of frameVariants) {
        if (!autoCompress && size !== canvasSize) continue;
        for (const candidateColorCount of colors) {
          attempt += 1;
          setStatus({ kind: "exporting", text: `正在测量 GIF 体积 ${attempt}/${totalAttempts}…` });
          const measured = await estimateGifSize({
            width: size.width,
            height: size.height,
            loopMode,
            loopCount: loopMode === "finite" ? Math.max(1, Math.round(loopCount)) : 0,
            encodingSpeed: encodingQuality === "high" ? 1 : encodingQuality === "balanced" ? 10 : 30,
            colorCount: candidateColorCount,
            ditherMode,
            frames: candidate.frames,
          });
          baselineBytes ??= measured.bytes;
          const result = { bytes: measured.bytes, baselineBytes, frames: candidate.frames, width: size.width, height: size.height, colorCount: candidateColorCount, samplingEvery: candidate.samplingEvery, mergedIdenticalFrames: candidate.mergedIdenticalFrames };
          if (!best || Math.abs(measured.bytes - (targetBytes ?? maxBytes ?? measured.bytes)) < Math.abs(best.bytes - (targetBytes ?? maxBytes ?? best.bytes))) best = result;
          const underMax = maxBytes === undefined || measured.bytes <= maxBytes;
          const reachesTarget = targetBytes === undefined || measured.bytes <= targetBytes;
          if (underMax && reachesTarget) return result;
          if (!autoCompress) {
            if (!underMax) throw new Error(`当前 GIF 预计为 ${formatGifBytes(measured.bytes)}，超过最大文件大小 ${formatGifBytes(maxBytes ?? 0)}。请开启自动压缩或调整参数。`);
            return result;
          }
        }
      }
    }

    if (maxBytes !== undefined && (!best || best.bytes > maxBytes)) {
      throw new Error(`自动压缩后 GIF 仍为 ${formatGifBytes(best?.bytes ?? 0)}，超过最大文件大小 ${formatGifBytes(maxBytes)}。请降低画布尺寸或减少帧数。`);
    }
    if (!best) throw new Error("无法测量 GIF 文件体积。");
    return best;
  };

  const measureAnimationCompressionCandidates = async (forceMeasure = false): Promise<AnimationCompressionResult> => {
    if (outputFormat !== "webp" && outputFormat !== "apng") throw new Error("当前输出格式不支持动图体积测量。");
    const targetBytes = parseSizeBytes(targetSizeKiB);
    const maxBytes = parseSizeBytes(maxSizeKiB);
    if (targetSizeKiB.trim() && targetBytes === undefined) throw new Error("目标文件大小必须是大于 0 的数字。");
    if (maxSizeKiB.trim() && maxBytes === undefined) throw new Error("最大文件大小必须是大于 0 的数字。");
    if (targetBytes !== undefined && maxBytes !== undefined && targetBytes > maxBytes) {
      throw new Error("目标文件大小不能大于最大文件大小。");
    }

    const format = outputFormat.toUpperCase();
    setStatus({ kind: "exporting", text: `正在准备 ${format} 帧 ${frames.length} 帧…` });
    const renderedBaseFrames = await renderExportFrames(canvasSize);
    const baseFrames = mergeIdenticalFrames ? mergeConsecutiveIdenticalFrames(renderedBaseFrames) : renderedBaseFrames;
    const baseline = await estimateAnimationSize(outputFormat, createAnimationExportRequest(baseFrames));
    const baselineResult: AnimationCompressionResult = {
      bytes: baseline.bytes,
      baselineBytes: baseline.bytes,
      frames: baseFrames,
      width: canvasSize.width,
      height: canvasSize.height,
      samplingEvery: 1,
      mergedIdenticalFrames: mergeIdenticalFrames,
    };
    const shouldTryCompression = autoCompress && (targetBytes !== undefined || maxBytes !== undefined);
    const shouldMeasure = forceMeasure || autoCompress || targetBytes !== undefined || maxBytes !== undefined;
    if (!shouldMeasure || !shouldTryCompression) {
      if (maxBytes !== undefined && baseline.bytes > maxBytes) {
        throw new Error(`当前 ${format} 预计为 ${formatGifBytes(baseline.bytes)}，超过最大文件大小 ${formatGifBytes(maxBytes)}。请开启自动压缩或调整参数。`);
      }
      return shouldMeasure ? baselineResult : { ...baselineResult, baselineBytes: undefined };
    }

    const sizes = [
      canvasSize,
      resolveGifCanvasSize(canvasSize, canvasSize.width * 0.75, canvasSize.height * 0.75, false),
      resolveGifCanvasSize(canvasSize, canvasSize.width * 0.5, canvasSize.height * 0.5, false),
    ].filter((size, index, all) => index === all.findIndex((candidate) => candidate.width === size.width && candidate.height === size.height));
    const frameVariants = getGifSamplingCandidates(baseFrames.length).flatMap((samplingEvery) => {
      const sampled = sampleGifFrames(baseFrames, samplingEvery);
      const merged = mergeConsecutiveIdenticalFrames(sampled);
      return mergeIdenticalFrames
        ? [{ frames: merged, samplingEvery, mergedIdenticalFrames: true }]
        : [
            { frames: sampled, samplingEvery, mergedIdenticalFrames: false },
            { frames: merged, samplingEvery, mergedIdenticalFrames: true },
          ];
    });
    const candidates = sizes.flatMap((size) => frameVariants
      .filter((candidate) => !(size.width === canvasSize.width
        && size.height === canvasSize.height
        && candidate.samplingEvery === 1
        && candidate.mergedIdenticalFrames === mergeIdenticalFrames))
      .map((candidate) => ({ size, ...candidate })));
    const results: AnimationCompressionResult[] = [baselineResult];
    for (const [index, candidate] of candidates.entries()) {
      setStatus({ kind: "exporting", text: `正在测量 ${format} 体积 ${index + 2}/${candidates.length + 1}…` });
      const measured = await estimateAnimationSize(outputFormat, createAnimationExportRequest(candidate.frames, candidate.size));
      results.push({
        bytes: measured.bytes,
        baselineBytes: baseline.bytes,
        frames: candidate.frames,
        width: candidate.size.width,
        height: candidate.size.height,
        samplingEvery: candidate.samplingEvery,
        mergedIdenticalFrames: candidate.mergedIdenticalFrames,
      });
    }

    const selected = selectAnimationCompressionResult(results, targetBytes, maxBytes);
    if (!selected) {
      throw new Error(`自动压缩后 ${format} 仍为 ${formatGifBytes(Math.min(...results.map((result) => result.bytes)))}，超过最大文件大小 ${formatGifBytes(maxBytes ?? 0)}。请降低画布尺寸或减少帧数。`);
    }
    return selected;
  };

  const measurePngSequenceCompressionCandidates = async (forceMeasure = false): Promise<PngSequenceCompressionResult> => {
    if (outputFormat !== "png-sequence") throw new Error("当前输出格式不支持 PNG 帧序列体积测量。");
    const targetBytes = parseSizeBytes(targetSizeKiB);
    const maxBytes = parseSizeBytes(maxSizeKiB);
    if (targetSizeKiB.trim() && targetBytes === undefined) throw new Error("目标文件大小必须是大于 0 的数字。");
    if (maxSizeKiB.trim() && maxBytes === undefined) throw new Error("最大文件大小必须是大于 0 的数字。");
    if (targetBytes !== undefined && maxBytes !== undefined && targetBytes > maxBytes) {
      throw new Error("目标文件大小不能大于最大文件大小。");
    }

    setStatus({ kind: "exporting", text: `正在准备 PNG 帧 ${frames.length} 帧…` });
    const renderedBaseFrames = await renderExportFrames(canvasSize);
    const baseline = await estimatePngSequenceSize(createPngSequenceSizeRequest(renderedBaseFrames));
    const baselineResult: PngSequenceCompressionResult = {
      bytes: baseline.bytes,
      baselineBytes: baseline.bytes,
      frames: renderedBaseFrames,
      width: canvasSize.width,
      height: canvasSize.height,
      samplingEvery: 1,
      mergedIdenticalFrames: false,
    };
    const shouldTryCompression = autoCompress && (targetBytes !== undefined || maxBytes !== undefined);
    const shouldMeasure = forceMeasure || autoCompress || targetBytes !== undefined || maxBytes !== undefined;
    if (!shouldMeasure || !shouldTryCompression) {
      if (maxBytes !== undefined && baseline.bytes > maxBytes) {
        throw new Error(`当前 PNG 帧序列预计为 ${formatGifBytes(baseline.bytes)}，超过最大文件大小 ${formatGifBytes(maxBytes)}。请开启自动压缩或调整参数。`);
      }
      return shouldMeasure ? baselineResult : { ...baselineResult, baselineBytes: undefined };
    }

    const sizes = [
      canvasSize,
      resolveGifCanvasSize(canvasSize, canvasSize.width * 0.75, canvasSize.height * 0.75, false),
      resolveGifCanvasSize(canvasSize, canvasSize.width * 0.5, canvasSize.height * 0.5, false),
    ].filter((size, index, all) => index === all.findIndex((candidate) => candidate.width === size.width && candidate.height === size.height));
    const candidates: Array<{ size: GifCanvasSize; frames: GifExportFrame[]; samplingEvery: number; mergedIdenticalFrames: boolean }> = [];
    for (const size of sizes) {
      const rendered = size.width === canvasSize.width && size.height === canvasSize.height
        ? renderedBaseFrames
        : await renderExportFrames(size);
      const frameVariants = getGifSamplingCandidates(rendered.length).flatMap((samplingEvery) => {
        const sampled = sampleGifFrames(rendered, samplingEvery);
        const merged = mergeConsecutiveIdenticalFrames(sampled);
        return [
          { frames: sampled, samplingEvery, mergedIdenticalFrames: false },
          { frames: merged, samplingEvery, mergedIdenticalFrames: true },
        ];
      });
      candidates.push(...frameVariants
        .filter((candidate) => !(size.width === canvasSize.width
          && size.height === canvasSize.height
          && candidate.samplingEvery === 1
          && !candidate.mergedIdenticalFrames))
        .map((candidate) => ({ size, ...candidate })));
    }

    const results: PngSequenceCompressionResult[] = [baselineResult];
    for (const [index, candidate] of candidates.entries()) {
      setStatus({ kind: "exporting", text: `正在测量 PNG 帧序列体积 ${index + 2}/${candidates.length + 1}…` });
      const measured = await estimatePngSequenceSize(createPngSequenceSizeRequest(candidate.frames));
      results.push({
        bytes: measured.bytes,
        baselineBytes: baseline.bytes,
        frames: candidate.frames,
        width: candidate.size.width,
        height: candidate.size.height,
        samplingEvery: candidate.samplingEvery,
        mergedIdenticalFrames: candidate.mergedIdenticalFrames,
      });
    }

    const selected = selectAnimationCompressionResult(results, targetBytes, maxBytes);
    if (!selected) {
      throw new Error(`自动压缩后 PNG 帧序列仍为 ${formatGifBytes(Math.min(...results.map((result) => result.bytes)))}，超过最大文件大小 ${formatGifBytes(maxBytes ?? 0)}。请降低画布尺寸或减少帧数。`);
    }
    return selected;
  };

  const applySizeMeasurement = (result: Pick<GifCompressionResult, "bytes" | "baselineBytes" | "frames">) => {
    setExportFrameSummary({
      frameCount: result.frames.length,
      totalDurationMs: result.frames.reduce((total, frame) => total + frame.durationMs, 0),
    });
    if (result.baselineBytes === undefined || result.bytes <= 0) {
      setMeasuredSizeBytes(null);
      setSizeComparison(null);
      return;
    }
    setMeasuredSizeBytes(result.bytes);
    setSizeComparison({
      baselineBytes: result.baselineBytes,
      finalBytes: result.bytes,
      targetBytes: parseSizeBytes(targetSizeKiB),
      maxBytes: parseSizeBytes(maxSizeKiB),
      autoCompress,
    });
  };

  const estimateGifSizeBeforeExport = async () => {
    if (lockedRef.current || !frames.length || outputFormat !== "gif") return;
    lockedRef.current = true;
    setLocked(true);
    setIsPlaying(false);
    setError(null);
    try {
      const result = await measureCompressionCandidates(true);
      applySizeMeasurement(result);
      setCompressionSummary(formatGifCompressionSummary(result));
      setStatus({ kind: "ready", text: `预计 GIF 体积：${formatGifBytes(result.bytes)}` });
    } catch (estimateError) {
      setError(getErrorMessage(estimateError));
      setStatus({ kind: "error", text: "GIF 体积估算失败" });
    } finally {
      lockedRef.current = false;
      setLocked(false);
    }
  };

  const estimateAnimationSizeBeforeExport = async () => {
    if (lockedRef.current || !frames.length || (outputFormat !== "webp" && outputFormat !== "apng")) return;
    lockedRef.current = true;
    setLocked(true);
    setIsPlaying(false);
    setError(null);
    setStatus({ kind: "exporting", text: `正在测量 ${outputFormat.toUpperCase()} 体积…` });
    try {
      const result = await measureAnimationCompressionCandidates(true);
      applySizeMeasurement(result);
      setCompressionSummary(formatAnimationCompressionSummary(result));
      setStatus({ kind: "ready", text: `预计 ${outputFormat.toUpperCase()} 体积：${formatGifBytes(result.bytes)}` });
    } catch (estimateError) {
      setError(getErrorMessage(estimateError));
      setStatus({ kind: "error", text: `${outputFormat.toUpperCase()} 体积测量失败` });
    } finally {
      lockedRef.current = false;
      setLocked(false);
    }
  };

  const estimatePngSequenceSizeBeforeExport = async () => {
    if (lockedRef.current || !frames.length || outputFormat !== "png-sequence") return;
    lockedRef.current = true;
    setLocked(true);
    setIsPlaying(false);
    setError(null);
    setStatus({ kind: "exporting", text: "正在测量 PNG 帧序列体积…" });
    try {
      const result = await measurePngSequenceCompressionCandidates(true);
      applySizeMeasurement(result);
      setCompressionSummary(formatPngSequenceCompressionSummary(result));
      setStatus({ kind: "ready", text: `预计 PNG 帧序列体积：${formatGifBytes(result.bytes)}` });
    } catch (estimateError) {
      setError(getErrorMessage(estimateError));
      setStatus({ kind: "error", text: "PNG 帧序列体积测量失败" });
    } finally {
      lockedRef.current = false;
      setLocked(false);
    }
  };

  const exportAnimation = async () => {
    if (lockedRef.current || pendingRef.current) return;
    if (!frames.length) {
      setError("请先导入至少一张图片。");
      return;
    }
    if (!fileName.trim()) {
      setError("请输入输出名称。");
      return;
    }
    const outputReady = singleOutputReady;
    if (!outputReady) {
      setError(outputLocation === "path"
        ? `请先选择 ${outputFormat === "png-sequence" ? "PNG 帧序列输出目录" : `${outputFormat.toUpperCase()} 保存位置`}。`
        : outputLocationError ?? `请先完成 ${outputFormat.toUpperCase()} 输出位置设置。`);
      return;
    }
    setError(null);
    lockedRef.current = true;
    setLocked(true);
    setIsPlaying(false);
    setStatus({ kind: "exporting", text: `正在准备 ${frames.length} 帧…` });
    try {
      if (outputFormat === "png-sequence") {
        const needsPngMeasurement = autoCompress || targetSizeKiB.trim() || maxSizeKiB.trim();
        const compression = needsPngMeasurement ? await measurePngSequenceCompressionCandidates() : null;
        const exportFrames = compression?.frames ?? await renderExportFrames(canvasSize);
        if (compression) {
          applySizeMeasurement(compression);
          setCompressionSummary(formatPngSequenceCompressionSummary(compression));
        }
        const result = await exportPngSequence({
          ...getPngSequenceOutputLocationFields(outputLocation, sequenceOutputDir, sourcePath, outputSubdirectory, outputDirectory),
          baseName: createPngSequenceSizeRequest(exportFrames).baseName,
          frames: exportFrames,
          overwriteExisting,
        });
        setLastExportPath(result[0] ?? sequenceOutputDir);
        setStatus({ kind: "success", text: `PNG 帧序列已导出：${result.length} 帧` });
        return;
      }
      if (outputLocation === "path" && !outputPath) throw new Error(`请先选择 ${outputFormat.toUpperCase()} 保存位置。`);
      if (outputFormat === "webp" || outputFormat === "apng") {
        const needsAnimationMeasurement = autoCompress || targetSizeKiB.trim() || maxSizeKiB.trim();
        const compression = needsAnimationMeasurement ? await measureAnimationCompressionCandidates() : null;
        const exportFrames = compression?.frames ?? prepareAnimatedExportFrames(await renderExportFrames(canvasSize));
        if (compression) {
          applySizeMeasurement(compression);
          setCompressionSummary(formatAnimationCompressionSummary(compression));
        }
        const request = createAnimationExportRequest(exportFrames, compression ? { width: compression.width, height: compression.height } : canvasSize);
        const result = outputFormat === "webp"
          ? await exportWebpAnimation(request)
          : await exportApng(request);
        setLastExportPath(result);
        setStatus({ kind: "success", text: `${outputFormat.toUpperCase()} 动图已导出：${result}` });
        return;
      }
      const compression = await measureCompressionCandidates();
      const { frames: exportFrames, width, height } = compression;
      applySizeMeasurement(compression);
      setCompressionSummary(formatGifCompressionSummary(compression));
      const result = await exportGif({
        outputPath: outputPath ?? undefined,
        outputLocation,
        fileName: fileName.trim() || undefined,
        sourcePath,
        outputSubdirectory: outputSubdirectory.trim() || undefined,
        outputDirectory: outputDirectory.trim() || undefined,
        width,
        height,
        loopMode,
        loopCount: loopMode === "finite" ? Math.max(1, Math.round(loopCount)) : 0,
        encodingSpeed: encodingQuality === "high" ? 1 : encodingQuality === "balanced" ? 10 : 30,
        colorCount: compression.colorCount,
        ditherMode,
        frames: exportFrames,
        overwriteExisting,
      });
      setLastExportPath(result);
      setStatus({ kind: "success", text: `GIF 已导出：${result} · ${formatGifCompressionSummary(compression)}` });
    } catch (exportError) {
      setError(getErrorMessage(exportError));
      setStatus({ kind: "error", text: `${outputFormat.toUpperCase()} 导出失败` });
    } finally {
      lockedRef.current = false;
      setLocked(false);
    }
  };

  const updateContentMargin = (side: keyof GifContentMargins, value: number) => {
    const margin = Math.min(4096, Math.max(0, Math.floor(Number.isFinite(value) ? value : 0)));
    setContentMargins((current) => ({ ...current, [side]: margin }));
    setGifPreset("custom");
    setMeasuredSizeBytes(null);
  };

  const openLastExportFolder = async () => {
    if (!lastExportPath) return;
    try {
      await revealGifOutput(lastExportPath);
      setStatus({ kind: "success", text: "已打开导出文件夹" });
    } catch (openError) {
      setError(getErrorMessage(openError));
      setStatus({ kind: "error", text: "无法打开导出文件夹" });
    }
  };

  const copyLastExportPath = async () => {
    if (!lastExportPath) return;
    try {
      if (!navigator.clipboard) throw new Error("当前环境不支持复制路径，请手动复制。");
      await navigator.clipboard.writeText(lastExportPath);
      setStatus({ kind: "success", text: "导出路径已复制" });
    } catch (copyError) {
      setError(getErrorMessage(copyError));
      setStatus({ kind: "error", text: "无法复制导出路径" });
    }
  };

  const sourceHint = selectedFrame ? `${selectedFrame.width} × ${selectedFrame.height} px` : "导入后自动读取尺寸";
  const canMoveLeft = selectedIndex > 0;
  const canMoveRight = selectedIndex >= 0 && selectedIndex < frames.length - 1;
  const outputLocationLabel = outputFormat === "png-sequence" ? "输出目录" : "保存位置";
  const outputLocationHelp = outputLocationError ?? (
    outputLocation === "path"
      ? `使用原生保存对话框选择${outputFormat === "png-sequence" ? "输出目录" : "单文件位置"}。`
      : outputLocation === "source"
        ? "由桌面安全命令根据源文件路径解析所在文件夹，不在前端拼接路径。"
        : outputLocation === "subfolder"
          ? "子文件夹名称由桌面安全命令校验后创建。"
          : "目录路径由桌面安全命令校验后创建。"
  );
  const outputDisplayPath = outputLocation === "path"
    ? outputFormat === "png-sequence" ? (sequenceOutputDir ?? "尚未选择输出目录") : (outputPath ?? "尚未选择保存位置")
    : outputLocation === "source"
      ? (sourcePath ? "使用首个源文件所在文件夹" : "等待可用源文件路径")
      : outputLocation === "subfolder"
        ? (sourcePath ? `源文件夹 / ${outputSubdirectory.trim() || "未填写子文件夹"}` : "等待可用源文件路径")
        : (outputDirectory.trim() || "尚未填写自定义目录");

  return (
    <div className={`gif-maker-view page-view gif-source-${sourceMode}`}>
      <header className="page-header gif-maker-header">
        <div className="page-header-icon"><Film size={19} aria-hidden="true" /></div>
        <div className="page-header-copy">
          <p className="page-eyebrow">GIF MAKER</p>
          <h1>GIF 制作</h1>
          <div className="gif-source-tabs" role="tablist" aria-label="GIF 来源">
            <button
              className={`gif-source-tab${sourceMode === "image" ? " gif-source-tab-active" : ""}`}
              type="button"
              role="tab"
              aria-selected={sourceMode === "image"}
              onClick={() => setSourceMode("image")}
            >
              <Images size={14} aria-hidden="true" />图生 GIF
            </button>
            <button
              className={`gif-source-tab${sourceMode === "video" ? " gif-source-tab-active" : ""}`}
              type="button"
              role="tab"
              aria-selected={sourceMode === "video"}
              onClick={() => { setIsPlaying(false); setSourceMode("video"); }}
            >
              <Video size={14} aria-hidden="true" />视频生 GIF
            </button>
          </div>
          <p>{sourceMode === "image" ? "把图片序列整理成适合界面演示和嵌入式资源预览的轻量动画。" : "截取视频片段并按指定帧率生成轻量 GIF。"}</p>
        </div>
        <div className="gif-header-note"><span className="status-dot" />支持图片序列与视频</div>
      </header>

      <fieldset className="page-content gif-maker-content" disabled={locked} aria-label="GIF 制作工作区" aria-busy={locked || pendingImports > 0}>
        <>
        <div className="gif-maker-toolbar">
          <button className="primary-button" type="button" onClick={() => openFileDialog()}>
            <Upload size={16} aria-hidden="true" />{sourceMode === "video" ? "导入视频" : "导入图片序列"}
          </button>
          <span>{sourceMode === "video" ? "支持 MP4 / WebM / OGG · 最多提取 200 帧" : "多选 / 拖放追加 · 最多 200 帧，32 MiB / 帧，总计 128 MiB"}</span>
          {pendingImports > 0 ? <button className="quiet-button" type="button" onClick={clearFrames}>取消导入并清空</button> : null}
          <input ref={fileInputRef} className="gif-hidden-input" type="file" accept={sourceMode === "video" ? VIDEO_ACCEPT : IMAGE_ACCEPT} multiple={sourceMode === "image"} onChange={handleInputChange} />
        </div>

        {sourceMode === "video" ? (
          <section className="gif-card gif-video-card" aria-label="视频源设置">
            <div className="gif-card-heading">
              <div><p className="gif-card-kicker">VIDEO SOURCE</p><h2>视频片段</h2></div>
              {videoSource ? <span className="gif-count-badge">{formatVideoTime(videoSource.duration)}</span> : null}
            </div>
            {videoSource ? (
              <>
                <video className="gif-video-preview" src={videoSource.previewUrl} controls preload="metadata" aria-label="视频预览" />
                <div className="gif-video-grid">
                  <label className="gif-field"><span>开始时间 · 秒</span><input type="number" min="0" max={videoSource.duration} step="0.01" value={videoStart} onChange={(event) => { setVideoStart(Math.max(0, Math.min(videoSource.duration, Number(event.target.value) || 0))); markVideoFramesStale(); }} /></label>
                  <label className="gif-field"><span>结束时间 · 秒</span><input type="number" min="0" max={videoSource.duration} step="0.01" value={videoEnd} onChange={(event) => { setVideoEnd(Math.max(0, Math.min(videoSource.duration, Number(event.target.value) || 0))); markVideoFramesStale(); }} /></label>
                  <label className="gif-field"><span>帧率 · FPS</span><input type="number" min="1" max="30" step="1" value={videoFps} onChange={(event) => { setVideoFps(clampVideoFps(Number(event.target.value))); markVideoFramesStale(); }} /></label>
                  <label className="gif-field"><span>每隔 N 帧</span><input type="number" min="1" max="200" step="1" value={videoEveryNthFrame} onChange={(event) => { setVideoEveryNthFrame(Math.min(MAX_VIDEO_FRAME_LIMIT, Math.max(1, Math.floor(Number(event.target.value) || 1)))); markVideoFramesStale(); }} /></label>
                  <label className="gif-field"><span>最大帧数</span><input type="number" min="1" max={MAX_VIDEO_FRAME_LIMIT} step="1" value={videoMaxFrames} onChange={(event) => { setVideoMaxFrames(Math.min(MAX_VIDEO_FRAME_LIMIT, Math.max(1, Math.floor(Number(event.target.value) || 1)))); markVideoFramesStale(); }} /></label>
                  <SelectField id="gif-video-crop" label="裁剪区域" value={videoCropPreset} options={[{ value: "original" as const, label: "原始画面" }, { value: "center16x9" as const, label: "居中 16:9" }, { value: "center1x1" as const, label: "居中 1:1" }, { value: "custom" as const, label: "自定义" }]} onChange={(value) => updateVideoTransform(value, videoRotation)} />
                  <SelectField id="gif-video-rotation" label="旋转" value={videoRotation} options={[{ value: 0 as const, label: "0°" }, { value: 90 as const, label: "90°" }, { value: 180 as const, label: "180°" }, { value: 270 as const, label: "270°" }]} onChange={(value) => updateVideoTransform(videoCropPreset, value)} />
                  {videoCropPreset === "custom" ? <div className="gif-video-custom-crop" aria-label="自定义裁剪区域">
                    <span className="gif-field-label">自定义裁剪 · 源视频像素</span>
                    <div className="gif-video-custom-crop-grid">
                      <label className="gif-field"><span>X</span><input type="number" min="0" max={Math.max(0, videoSource.width - customVideoCrop.width)} step="1" value={customVideoCrop.x} onChange={(event) => updateCustomVideoCrop("x", Number(event.target.value))} /></label>
                      <label className="gif-field"><span>Y</span><input type="number" min="0" max={Math.max(0, videoSource.height - customVideoCrop.height)} step="1" value={customVideoCrop.y} onChange={(event) => updateCustomVideoCrop("y", Number(event.target.value))} /></label>
                      <label className="gif-field"><span>宽度</span><input type="number" min="1" max={Math.max(1, videoSource.width - customVideoCrop.x)} step="1" value={customVideoCrop.width} onChange={(event) => updateCustomVideoCrop("width", Number(event.target.value))} /></label>
                      <label className="gif-field"><span>高度</span><input type="number" min="1" max={Math.max(1, videoSource.height - customVideoCrop.y)} step="1" value={customVideoCrop.height} onChange={(event) => updateCustomVideoCrop("height", Number(event.target.value))} /></label>
                    </div>
                    <small className="gif-video-custom-crop-help">左上角为 0,0；宽高始终限制在源视频范围内，修改后需重新提取帧。</small>
                  </div> : null}
                  <label className="gif-check-row gif-video-reverse"><input type="checkbox" checked={videoReverse} onChange={(event) => { setVideoReverse(event.target.checked); markVideoFramesStale(); }} /><span><strong>视频倒放</strong><small>按反向时间顺序抽帧</small></span></label>
                  <div className="gif-video-summary"><span>当前范围</span><strong>{formatVideoTime(videoStart)} – {formatVideoTime(videoEnd)}</strong><small>预计 {planVideoFramesWithSampling(videoStart, videoEnd, videoSource.duration, videoFps, { everyNthFrame: videoEveryNthFrame, maxFrames: videoMaxFrames }).times.length} 帧（最多 {MAX_VIDEO_FRAME_LIMIT} 帧）</small></div>
                </div>
                <div className="gif-video-actions">
                  <span>{videoSource.name} · {videoSource.width} × {videoSource.height} px</span>
                  <button className="primary-button" type="button" onClick={() => void extractVideo()}><Video size={15} aria-hidden="true" />提取视频帧</button>
                </div>
              </>
            ) : (
              <div className="gif-video-empty"><Video size={24} aria-hidden="true" /><span>导入视频后设置截取范围与帧率。</span><button className="quiet-button" type="button" onClick={() => openFileDialog()}>选择视频</button></div>
            )}
          </section>
        ) : null}

        <div className="gif-workspace-grid">
          <section className="gif-card gif-assets-card" aria-labelledby="gif-assets-title">
            <div className="gif-card-heading">
              <div><p className="gif-card-kicker">01 / ASSETS</p><h2 id="gif-assets-title">素材帧</h2></div>
              {frames.length ? <span className="gif-count-badge">{frames.length} 帧</span> : null}
            </div>
            <div
              className={`gif-drop-zone${isDragging ? " gif-drop-zone-active" : ""}`}
              role="button"
              tabIndex={locked ? -1 : 0}
              aria-disabled={locked}
              onClick={() => openFileDialog()}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openFileDialog(); } }}
              onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
              onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              aria-label={sourceMode === "video" ? "拖放视频或选择视频" : "拖放图片或选择图片"}
            >
              <Upload size={20} aria-hidden="true" />
              <strong>
                <span className="gif-drop-label-full">{isDragging ? `松开以添加${sourceMode === "video" ? "视频" : "图片"}` : `拖放${sourceMode === "video" ? "视频" : "图片"}到这里`}</span>
                <span className="gif-drop-label-compact">添加{sourceMode === "video" ? "视频" : "图片"}</span>
              </strong>
              <span>{sourceMode === "video" ? "或点击选择视频文件" : "或点击选择多个文件"}</span>
            </div>
            {frames.length ? (
              <>
                <div className="gif-frame-toolbar">
                  <span>帧顺序 · 已选 {selectedFrameIndices.size}</span>
                  <div>
                    <button className="icon-button" type="button" aria-label="删除首帧" title="删除首帧" disabled={!frames.length || locked} onClick={() => removeFrame(0)}><ChevronsLeft size={15} aria-hidden="true" /></button>
                    <button className="icon-button" type="button" aria-label="删除尾帧" title="删除尾帧" disabled={!frames.length || locked} onClick={() => removeFrame(frames.length - 1)}><ChevronsRight size={15} aria-hidden="true" /></button>
                    <button className="icon-button" type="button" aria-label="复制当前帧" title="复制当前帧" disabled={!selectedFrame || locked} onClick={copySelectedFrame}><Copy size={15} aria-hidden="true" /></button>
                    <button className="icon-button" type="button" aria-label="删除选中帧" title="删除选中帧" disabled={!selectedFrameIndices.size || locked} onClick={removeSelectedFrames}><Trash2 size={15} aria-hidden="true" /></button>
                    <button className="icon-button" type="button" aria-label="倒序" title="倒序" onClick={reverseFrames}><RotateCcw size={15} aria-hidden="true" /></button>
                    <button className="icon-button" type="button" aria-label="清空帧" title="清空帧" onClick={clearFrames}><Trash2 size={15} aria-hidden="true" /></button>
                  </div>
                </div>
                <div className="gif-frame-list" aria-label="GIF 帧列表">
                  {frames.map((frame, index) => (
                    <div className={`gif-frame-row${selectedFrameIndices.has(index) ? " gif-frame-row-selected" : ""}`} key={frame.id} draggable={!locked} onDragStart={(event) => handleFrameDragStart(event, index)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => handleFrameDrop(event, index)} onDragEnd={() => { draggedFrameIndexRef.current = null; }}>
                      <button className="gif-frame-select" type="button" onClick={(event) => selectFrame(index, event)} aria-pressed={selectedFrameIndices.has(index)} aria-label={`选择第 ${index + 1} 帧：${frame.name}`}>
                        <span className="gif-frame-number">{String(index + 1).padStart(2, "0")}</span>
                        <img src={frame.previewUrl} alt="" />
                        <span className="gif-frame-meta"><strong>{frame.name}</strong><small>{frame.width} × {frame.height} · {frame.durationMs} ms</small></span>
                      </button>
                      <div className="gif-frame-actions">
                        <button className="icon-button" type="button" aria-label={`第 ${index + 1} 帧上移`} title="上移" disabled={!canMoveLeft || selectedIndex !== index} onClick={() => moveFrame(index, -1)}><ArrowUp size={14} aria-hidden="true" /></button>
                        <button className="icon-button" type="button" aria-label={`第 ${index + 1} 帧下移`} title="下移" disabled={!canMoveRight || selectedIndex !== index} onClick={() => moveFrame(index, 1)}><ArrowDown size={14} aria-hidden="true" /></button>
                        <button className="icon-button" type="button" aria-label={`更换第 ${index + 1} 帧`} title="更换此帧" onClick={() => openFileDialog(frame.id)}><RotateCcw size={14} aria-hidden="true" /></button>
                        <button className="icon-button" type="button" aria-label={`移除第 ${index + 1} 帧`} title="移除" onClick={() => removeFrame(index)}><X size={14} aria-hidden="true" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : <EmptyFrames sourceMode={sourceMode} onImport={() => openFileDialog()} />}
          </section>

          <div className="gif-main-column">
            <section className="gif-card gif-preview-card" aria-labelledby="gif-preview-title">
              <div className="gif-card-heading">
                <div><p className="gif-card-kicker">02 / PREVIEW</p><h2 id="gif-preview-title">动画预览</h2></div>
                <div className="gif-playback-controls">
                <button className="icon-button" type="button" aria-label="上一帧" disabled={!canMoveLeft} onClick={() => seekPreviewFrame(selectedIndex - 1)}><ArrowLeft size={15} /></button>
                <button className="quiet-button gif-play-button" type="button" disabled={frames.length < 2 || pendingImports > 0} onClick={() => { repeatRef.current = 0; if (!isPlaying) setSelectedIndex(0); setIsPlaying((playing) => !playing); }}>
                  {isPlaying ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}{isPlaying ? "暂停" : "播放"}
                </button>
                <button className="icon-button" type="button" aria-label="下一帧" disabled={!canMoveRight} onClick={() => seekPreviewFrame(selectedIndex + 1)}><ArrowRight size={15} /></button>
                </div>
              </div>
              <div className={`gif-canvas-stage gif-background-${background}`} style={background === "custom" ? { backgroundColor: customBackgroundColor } : undefined}>
                {selectedFrame ? <canvas ref={canvasRef} className="gif-preview-canvas" aria-label={`第 ${selectedIndex + 1} 帧预览`} /> : <div className="gif-preview-empty"><Film size={28} aria-hidden="true" /><span>导入图片后预览动画</span></div>}
              </div>
              {frames.length ? <div className="gif-timeline"><input type="range" min="0" max={Math.max(0, frames.length - 1)} step="1" value={selectedIndex} aria-label="动画时间轴" onChange={(event) => seekPreviewFrame(Number(event.target.value))} /><span aria-label={`当前时间 ${formatGifTimelineTime(timeline.currentMs)}，总时长 ${formatGifTimelineTime(timeline.totalMs)}`}>当前 {formatGifTimelineTime(timeline.currentMs)} / 总计 {formatGifTimelineTime(timeline.totalMs)}</span></div> : null}
              <div className="gif-preview-footer"><span>{frames.length ? `第 ${selectedIndex + 1} / ${frames.length} 帧` : "未选择帧"}</span><span>{sourceHint}</span><span>{canvasSize.width} × {canvasSize.height} px 画布</span></div>
            </section>

          </div>
        </div>

        <section className="gif-card gif-settings-card" aria-label="GIF 参数">
          <div className="gif-group-tabs">
            {([['timing', '帧时长'], ['canvas', '画布'], ['export', '导出设置']] as const).map(([id, label]) => (
              <button key={id} id={`gif-group-${id}`} className={`quiet-button${group === id ? ' gif-group-active' : ''}`} type="button" aria-expanded={group === id} aria-controls={`gif-panel-${id}`} onClick={() => setGroup(group === id ? null : id)}>{label}</button>
            ))}
            <span>再次点击折叠</span>
          </div>
          {group === "timing" ? <div id="gif-panel-timing" role="region" aria-labelledby="gif-group-timing">
              <div className="gif-settings-grid">
                <label className="gif-field"><span>全局帧时长 · 应用全部帧</span><div className="gif-input-with-suffix"><input type="number" min="10" max="60000" step="10" value={globalDuration} onChange={(event) => updateAllDurations(Number(event.target.value))} /><small>ms</small></div></label>
                <label className="gif-field"><span>动画帧率 · 应用全部帧</span><div className="gif-input-with-suffix"><input type="number" min="1" max="100" step="0.01" value={fpsFromFrameDuration(globalDuration)} onChange={(event) => updateAnimationFps(Number(event.target.value))} /><small>FPS</small></div></label>
                <label className="gif-field"><span>当前帧时长</span><div className="gif-input-with-suffix"><input type="number" min="10" max="60000" step="10" value={selectedFrame?.durationMs ?? DEFAULT_DURATION} disabled={!selectedFrame} onChange={(event) => updateSelectedDuration(Number(event.target.value))} /><small>ms</small></div></label>
                <label className="gif-field"><span>批量设置选中帧时长 · {selectedFrameIndices.size} 帧</span><div className="gif-batch-duration-row"><div className="gif-input-with-suffix"><input type="number" min="10" max="60000" step="10" value={batchDuration} disabled={!selectedFrameIndices.size} onChange={(event) => setBatchDuration(clampFrameDuration(Number(event.target.value)))} /><small>ms</small></div><button className="quiet-button" type="button" disabled={!selectedFrameIndices.size || locked} onClick={updateSelectedFramesDuration}>应用</button></div></label>
                <label className="gif-field"><span>首帧停留时间</span><div className="gif-hold-row"><div className="gif-input-with-suffix"><input type="number" min="0" max="60000" step="10" value={firstFrameHoldDuration} onChange={(event) => setFirstFrameHoldDuration(clampGifHoldDuration(Number(event.target.value)))} /><small>ms</small></div><button className="quiet-button" type="button" disabled={locked} onClick={() => setFirstFrameHoldDuration((current) => clampGifHoldDuration(current + 100))}>+100</button><button className="quiet-button" type="button" disabled={locked || firstFrameHoldDuration === 0} onClick={() => setFirstFrameHoldDuration(0)}>清零</button></div></label>
                <label className="gif-field"><span>尾帧停留时间</span><div className="gif-hold-row"><div className="gif-input-with-suffix"><input type="number" min="0" max="60000" step="10" value={lastFrameHoldDuration} onChange={(event) => setLastFrameHoldDuration(clampGifHoldDuration(Number(event.target.value)))} /><small>ms</small></div><button className="quiet-button" type="button" disabled={locked} onClick={() => setLastFrameHoldDuration((current) => clampGifHoldDuration(current + 100))}>+100</button><button className="quiet-button" type="button" disabled={locked || lastFrameHoldDuration === 0} onClick={() => setLastFrameHoldDuration(0)}>清零</button></div></label>
                <SelectField id="gif-playback-speed" label="预览速度" value={playbackSpeed} options={[{ value: 0.25 as const, label: "0.25x" }, { value: 0.5 as const, label: "0.5x" }, { value: 1 as const, label: "1x" }, { value: 2 as const, label: "2x" }]} onChange={setPlaybackSpeed} />
              </div>
              <p className="gif-help-text">10–60000 ms，向下取整到 10 ms；总时长 {(frames.reduce((sum, frame) => sum + frame.durationMs, 0) / 1000).toFixed(2)} 秒 / 轮。首尾停留会写入导出时长，预览速度仅影响预览。</p>
          </div> : null}
          {group === "canvas" ? <div id="gif-panel-canvas" role="region" aria-labelledby="gif-group-canvas">
              <div className="gif-settings-grid">
                <SelectField id="gif-size-preset" label="输出尺寸" value={canvasPreset} options={[{ value: "source" as const, label: "原始尺寸" }, { value: "75" as const, label: "缩小到 75%" }, { value: "50" as const, label: "缩小到 50%" }, { value: "custom" as const, label: "自定义尺寸" }]} onChange={applyCanvasPreset} />
                <div className="gif-field"><span>画布尺寸 · {canvasPreset === "custom" ? "自定义" : "预设"}</span><div className="gif-dimensions-row"><label><span className="sr-only">宽度</span><input aria-label="画布宽度" type="number" min="1" max="4096" value={canvasWidth} onChange={(event) => updateCanvasWidth(Number(event.target.value))} /></label><span>×</span><label><span className="sr-only">高度</span><input aria-label="画布高度" type="number" min="1" max="4096" value={canvasHeight} onChange={(event) => updateCanvasHeight(Number(event.target.value))} /></label></div></div>
                <label className="gif-check-row"><input type="checkbox" checked={keepAspectRatio} onChange={(event) => { ratioRef.current = canvasSize; setKeepAspectRatio(event.target.checked); setGifPreset("custom"); setMeasuredSizeBytes(null); }} /><span><strong>保持画布比例</strong><small>锁定当前画布，与选帧无关</small></span></label>
                <SelectField id="gif-fit-mode" label="缩放方式" value={fitMode} options={[{ value: "contain" as const, label: "适应画布（保持比例）" }, { value: "cover" as const, label: "裁剪填充（铺满）" }, { value: "stretch" as const, label: "拉伸填满画布" }]} onChange={(value) => { setFitMode(value); setGifPreset("custom"); setMeasuredSizeBytes(null); }} />
                <SelectField id="gif-content-alignment" label="内容对齐" value={contentAlignment} options={[{ value: "center" as const, label: "居中" }, { value: "top" as const, label: "上对齐" }, { value: "bottom" as const, label: "下对齐" }]} onChange={(value) => { setContentAlignment(value); setGifPreset("custom"); setMeasuredSizeBytes(null); }} />
                <SelectField id="gif-background" label="背景" value={background} options={[{ value: "transparent" as const, label: "透明" }, { value: "white" as const, label: "白色" }, { value: "black" as const, label: "黑色" }, { value: "custom" as const, label: "自定义颜色" }]} onChange={(value) => { setBackground(value); setGifPreset("custom"); setMeasuredSizeBytes(null); }} />
                {background === "custom" ? <label className="gif-field"><span>自定义背景色</span><input aria-label="自定义背景色" type="color" value={customBackgroundColor} onChange={(event) => { setCustomBackgroundColor(event.target.value); setMeasuredSizeBytes(null); }} /></label> : null}
                <div className="gif-field gif-margin-field"><span>自定义边距 · 上 / 右 / 下 / 左</span><div className="gif-margin-grid">
                  {([['top', '上'], ['right', '右'], ['bottom', '下'], ['left', '左']] as const).map(([side, label]) => <label key={side}><span className="sr-only">{label}边距</span><input aria-label={`${label}边距`} type="number" min="0" max="4096" step="1" value={contentMargins[side]} onChange={(event) => updateContentMargin(side, Number(event.target.value))} /><small>{label}</small></label>)}
                </div></div>
              </div>
              <p className="gif-help-text">{fitMode === "contain" ? "等比缩放并在内容区内留白，按所选背景补边。" : fitMode === "cover" ? "等比放大铺满内容区，超出部分按上/下对齐裁剪。" : "拉伸图片填满内容区；边距区域保留所选背景。"} 预览和导出使用相同规则。</p>
          </div> : null}
          {group === "export" ? <div id="gif-panel-export" role="region" aria-labelledby="gif-group-export">
          <div className="gif-export-grid">
            <SelectField id="gif-output-format" label="输出格式" value={outputFormat} options={[{ value: "gif" as const, label: "GIF 动图" }, { value: "webp" as const, label: "WebP 动图" }, { value: "apng" as const, label: "APNG 动图" }, { value: "png-sequence" as const, label: "PNG 帧序列" }]} onChange={changeOutputFormat} />
            <label className="gif-field"><span>{outputFormat === "png-sequence" ? "序列基础名" : "文件名"}</span><input value={fileName} maxLength={120} onChange={(event) => { setFileName(event.target.value); clearOutputSelection(); }} placeholder={outputFormat === "png-sequence" ? "embedpix-animation" : `embedpix-animation.${outputFormat}`} /></label>
            {outputFormat === "png-sequence" ? <>
              <div className="gif-animation-measure">
                <span>{measuredSizeBytes === null ? "尚未测量当前参数" : `预计体积：${formatGifBytes(measuredSizeBytes)}`}</span>
                {sizeComparison && measuredSizeBytes !== null ? <small>{sizeComparison.autoCompress && compressionComparisonSummary ? `${compressionComparisonSummary.size} · ${compressionComparisonSummary.limits}` : `实测基准 ${formatGifBytes(sizeComparison.finalBytes)}`}</small> : null}
                {compressionSummary !== null && sizeComparison?.autoCompress ? <small>采用参数：{compressionSummary}</small> : null}
                <button className="quiet-button gif-estimate-button" type="button" disabled={!frames.length || locked} onClick={() => void estimatePngSequenceSizeBeforeExport()}>{measuredSizeBytes === null ? "测量体积" : "重新测量"}</button>
              </div>
              <label className="gif-field"><span>目标文件大小</span><div className="gif-input-with-suffix"><input type="number" min="1" step="1" value={targetSizeKiB} onChange={(event) => { setTargetSizeKiB(event.target.value); setGifPreset("custom"); }} placeholder="可选" /><small>KiB</small></div></label>
              <label className="gif-field"><span>最大文件大小</span><div className="gif-input-with-suffix"><input type="number" min="1" step="1" value={maxSizeKiB} onChange={(event) => { setMaxSizeKiB(event.target.value); setGifPreset("custom"); }} placeholder="可选" /><small>KiB</small></div></label>
              <label className="gif-check-row gif-compression-toggle"><input type="checkbox" checked={autoCompress} onChange={(event) => { setAutoCompress(event.target.checked); setGifPreset("custom"); }} /><span><strong>自动压缩到目标大小</strong><small>合并相同帧 → 跳帧 → 75% / 50% 画布</small></span></label>
            </> : null}
            {outputFormat !== "png-sequence" ? <>
              <label className="gif-check-row gif-merge-toggle"><input type="checkbox" checked={mergeIdenticalFrames} onChange={(event) => setMergeIdenticalFrames(event.target.checked)} /><span><strong>合并连续相同帧</strong><small>仅影响导出，不修改原始帧列表；会保留累计时长</small></span></label>
              {outputFormat === "webp" || outputFormat === "apng" ? <div className="gif-animation-measure">
                <span>{measuredSizeBytes === null ? "尚未测量当前参数" : `预计体积：${formatGifBytes(measuredSizeBytes)}`}</span>
                {sizeComparison && measuredSizeBytes !== null ? <small>{sizeComparison.autoCompress && compressionComparisonSummary ? `${compressionComparisonSummary.size} · ${compressionComparisonSummary.limits}` : `实测基准 ${formatGifBytes(sizeComparison.finalBytes)}`}</small> : null}
                {compressionSummary !== null && sizeComparison?.autoCompress ? <small>采用参数：{compressionSummary}</small> : null}
                <button className="quiet-button gif-estimate-button" type="button" disabled={!frames.length || locked} onClick={() => void estimateAnimationSizeBeforeExport()}>{measuredSizeBytes === null ? "测量体积" : "重新测量"}</button>
              </div> : null}
              <SelectField id="gif-loop-mode" label="循环方式" value={loopMode} options={[{ value: "infinite" as const, label: "无限循环" }, { value: "finite" as const, label: "有限重复" }]} onChange={(value) => { setIsPlaying(false); setLoopMode(value); setGifPreset("custom"); }} />
              <label className="gif-field"><span>额外重复次数{loopMode === "finite" ? ` · 共播放 ${loopCount + 1} 次` : ""}</span><div className="gif-input-with-suffix"><input type="number" min="1" max="65535" value={loopCount} disabled={loopMode === "infinite"} onChange={(event) => { setIsPlaying(false); setLoopCount(Math.min(65535, Math.max(1, Math.floor(Number(event.target.value)) || 1))); setGifPreset("custom"); }} /><small>次</small></div></label>
              {outputFormat === "gif" ? <>
                <SelectField id="gif-preset" label="常用预设" value={gifPreset} options={[{ value: "high" as const, label: GIF_PRESETS.high.label }, { value: "balanced" as const, label: GIF_PRESETS.balanced.label }, { value: "small" as const, label: GIF_PRESETS.small.label }, { value: "custom" as const, label: "自定义" }]} onChange={(value) => { if (value === "custom") setGifPreset(value); else applyGifPreset(value); }} />
                <SelectField id="gif-encoding-quality" label="编码质量" value={encodingQuality} options={[{ value: "high" as const, label: "高质量（较慢）" }, { value: "balanced" as const, label: "平衡" }, { value: "fast" as const, label: "快速" }]} onChange={updateGifEncodingQuality} />
                <SelectField id="gif-color-count" label="颜色数量" value={colorCount} options={[{ value: 256 as const, label: "256 色（高质量）" }, { value: 128 as const, label: "128 色" }, { value: 64 as const, label: "64 色（小体积）" }, { value: 32 as const, label: "32 色（更小体积）" }, { value: 16 as const, label: "16 色（极小体积）" }, { value: 2 as const, label: "2 色（单色设备）" }]} onChange={updateGifColorCount} />
                <SelectField id="gif-dither-mode" label="抖动方式" value={ditherMode} options={[{ value: "none" as const, label: "无" }, { value: "floydSteinberg" as const, label: "Floyd-Steinberg" }, { value: "atkinson" as const, label: "Atkinson" }]} onChange={updateGifDitherMode} />
                <label className="gif-field"><span>目标文件大小</span><div className="gif-input-with-suffix"><input type="number" min="1" step="1" value={targetSizeKiB} onChange={(event) => { setTargetSizeKiB(event.target.value); setGifPreset("custom"); }} placeholder="可选" /><small>KiB</small></div></label>
                <label className="gif-field"><span>最大文件大小</span><div className="gif-input-with-suffix"><input type="number" min="1" step="1" value={maxSizeKiB} onChange={(event) => { setMaxSizeKiB(event.target.value); setGifPreset("custom"); }} placeholder="可选" /><small>KiB</small></div></label>
                <label className="gif-check-row gif-compression-toggle"><input type="checkbox" checked={autoCompress} onChange={(event) => { setAutoCompress(event.target.checked); setGifPreset("custom"); }} /><span><strong>自动压缩到目标大小</strong><small>颜色 → 跳帧 → 75% / 50% 画布</small></span></label>
              </> : <p className="gif-format-note">WebP/APNG 动图使用当前画布和帧时长导出；GIF 专属颜色和抖动参数不适用。</p>}
              {outputFormat === "webp" || outputFormat === "apng" ? <>
                <label className="gif-field"><span>目标文件大小</span><div className="gif-input-with-suffix"><input type="number" min="1" step="1" value={targetSizeKiB} onChange={(event) => { setTargetSizeKiB(event.target.value); setGifPreset("custom"); }} placeholder="可选" /><small>KiB</small></div></label>
                <label className="gif-field"><span>最大文件大小</span><div className="gif-input-with-suffix"><input type="number" min="1" step="1" value={maxSizeKiB} onChange={(event) => { setMaxSizeKiB(event.target.value); setGifPreset("custom"); }} placeholder="可选" /><small>KiB</small></div></label>
                <label className="gif-check-row gif-compression-toggle"><input type="checkbox" checked={autoCompress} onChange={(event) => { setAutoCompress(event.target.checked); setGifPreset("custom"); }} /><span><strong>自动压缩到目标大小</strong><small>合并相同帧 → 跳帧 → 75% / 50% 画布</small></span></label>
              </> : null}
            </> : <p className="gif-format-note">PNG 帧序列按当前画布逐帧输出 PNG；可通过目标体积控制候选尺寸、采样和重复帧。</p>}
            <div className="gif-output-picker">
              <span className="gif-field-label">{outputLocationLabel}</span>
              <ThemeSelect
                id="gif-output-location"
                value={outputLocation}
                options={[
                  { value: "path" as const, label: outputFormat === "png-sequence" ? "手动选择输出目录" : "手动选择保存位置" },
                  { value: "source" as const, label: "源文件夹" },
                  { value: "subfolder" as const, label: "源文件夹 / 子文件夹" },
                  { value: "directory" as const, label: "自定义目录" },
                ]}
                aria-label={`${outputFormat === "png-sequence" ? "PNG 帧序列" : "GIF"} 保存位置`}
                aria-describedby="gif-output-location-help"
                aria-invalid={Boolean(outputLocationError)}
                onChange={changeOutputLocation}
              />
              {outputLocation === "subfolder" ? <label className="gif-field"><span>子文件夹名称</span><input value={outputSubdirectory} aria-describedby="gif-output-location-help" aria-invalid={Boolean(outputLocationError)} onChange={(event) => { setOutputSubdirectory(event.target.value); clearOutputSelection(); setError(null); }} placeholder="例如 export" spellCheck={false} /></label> : null}
              {outputLocation === "directory" ? <label className="gif-field"><span>自定义目录</span><input value={outputDirectory} aria-describedby="gif-output-location-help" aria-invalid={Boolean(outputLocationError)} onChange={(event) => { setOutputDirectory(event.target.value); clearOutputSelection(); setError(null); }} placeholder="例如 D:\\Images\\Export" spellCheck={false} /></label> : null}
              <p className={`gif-help-text${outputLocationError ? " gif-output-location-error" : ""}`} id="gif-output-location-help" role={outputLocationError ? "alert" : undefined}>{outputLocationHelp}</p>
              <div className="gif-output-row"><span title={outputDisplayPath}>{outputDisplayPath}</span>{outputLocation === "path" ? <button className="quiet-button" type="button" onClick={() => void chooseOutput()}>{outputFormat === "png-sequence" ? "选择目录" : "选择位置"}</button> : null}</div>
              <label className="gif-check-row gif-output-overwrite"><input type="checkbox" checked={overwriteExisting} onChange={(event) => setOverwriteExisting(event.target.checked)} /><span><strong>{outputFormat === "png-sequence" ? "覆盖同名帧序列" : "覆盖同名文件"}</strong><small>{outputFormat === "png-sequence" ? "关闭时自动选择不冲突的序号前缀" : "关闭时同名文件会安全拒绝写入"}</small></span></label>
            </div>
            {lastExportPath ? <div className="gif-output-actions"><button className="quiet-button" type="button" onClick={() => void openLastExportFolder()}><FolderOpen size={14} aria-hidden="true" />打开文件夹</button><button className="quiet-button" type="button" onClick={() => void copyLastExportPath()}><Copy size={14} aria-hidden="true" />复制路径</button></div> : null}
          </div>
          <div className="gif-parameter-summary" aria-label="导出参数摘要"><strong>导出参数摘要</strong><span>{exportParameterSummary}</span></div>
          {outputFormat === "gif" ? <div className={`gif-workload-summary gif-workload-${workload.level}`}>
            <strong>导出负载</strong>
            <span>{(workload.totalPixels / 1_000_000).toFixed(1)} MP · 帧缓冲 {formatGifBytes(workload.decodedBytes)} · 调色板 {formatGifBytes(workload.paletteBytes)}</span>
            {sizeComparison && measuredSizeBytes !== null && !sizeComparison.autoCompress ? <span className="gif-measured-size">实测基准 {formatGifBytes(sizeComparison.finalBytes)}</span> : null}
            {sizeComparison && measuredSizeBytes !== null && sizeComparison.autoCompress && compressionComparisonSummary ? <div className="gif-size-comparison"><strong>压缩对比</strong><span>{compressionComparisonSummary.size}</span><small>{compressionComparisonSummary.limits}</small></div> : null}
            {compressionSummary !== null && sizeComparison?.autoCompress ? <span className="gif-measured-size">采用参数：{compressionSummary}</span> : null}
            <small>{workload.level === "heavy" ? "负载较高，建议缩小画布或减少帧数。" : "实际文件体积取决于画面内容；开启自动压缩后将先实际测量候选参数。"}</small>
            <button className="quiet-button gif-estimate-button" type="button" disabled={!frames.length || locked} onClick={() => void estimateGifSizeBeforeExport()}>{measuredSizeBytes === null ? "估算体积" : "重新估算"}</button>
          </div> : null}
          <p className="gif-help-text">{outputFormat === "png-sequence" ? "桌面端保存；每帧输出为 PNG。关闭覆盖时会自动选择不冲突的序号前缀。" : "桌面端保存；输出目录由原生保存对话框选择，关闭覆盖时同名文件会安全拒绝写入。"}</p>
          </div> : null}
        </section>
        </>
      </fieldset>
      <div className="gif-export-footer">
        {error ? <p className="gif-error-message" role="alert">{error}</p> : <p className={`gif-status gif-status-${status.kind}`} role="status">{status.text}</p>}
        {sourceMode === "video" && locked ? <button className="quiet-button" type="button" onClick={cancelVideoExtraction}>取消抽帧</button> : null}
        <button className="export-button gif-export-button" type="button" disabled={!frames.length || locked || pendingImports > 0} onClick={() => { if (!singleOutputReady) { setGroup("export"); if (outputLocation === "path") void chooseOutput(); else { setError(outputLocationError ?? "请先完成输出位置设置。"); setStatus({ kind: "error", text: "输出位置不可用" }); } } else { void exportAnimation(); } }}><Film size={17} aria-hidden="true" />{status.kind === "exporting" ? "处理中…" : outputFormat === "png-sequence" ? (singleOutputReady ? "导出 PNG 帧序列" : "选择输出目录") : outputLocation === "path" ? (outputPath ? `导出 ${outputFormat.toUpperCase()}` : "选择保存位置") : `导出 ${outputFormat.toUpperCase()}`}</button>
      </div>
    </div>
  );
}
