import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

export interface GifExportFrame {
  data: Uint8Array;
  durationMs: number;
}

export type GifOutputLocation = "path" | "source" | "subfolder" | "directory";

export interface GifOutputLocationRequest {
  outputPath?: string;
  outputLocation?: GifOutputLocation;
  fileName?: string;
  sourcePath?: string | null;
  outputSubdirectory?: string;
  outputDirectory?: string;
}

export type GifExportJobStatus = "running" | "cancelling" | "completed" | "cancelled" | "failed";
export type GifExportJobStage = "validating" | "encoding" | "publishing" | "completed" | "cancelled" | "failed";

export interface GifExportProgress {
  jobId: string;
  format: string;
  status: GifExportJobStatus;
  stage: GifExportJobStage;
  completedFrames: number;
  totalFrames: number;
  outputPath: string | null;
  error: string | null;
}

export interface GifExportRequest extends GifOutputLocationRequest {
  jobId?: string;
  width: number;
  height: number;
  loopMode: "infinite" | "finite";
  // GIF 保存首次播放后的重复次数，因此 finite 时总播放次数为 loopCount + 1。
  loopCount: number;
  encodingSpeed?: number;
  colorCount?: number;
  ditherMode?: "none" | "floydSteinberg" | "atkinson";
  frames: GifExportFrame[];
  overwriteExisting?: boolean;
}

export interface GifSizeEstimateRequest {
  width: number;
  height: number;
  loopMode: "infinite" | "finite";
  loopCount: number;
  encodingSpeed?: number;
  colorCount?: number;
  ditherMode?: "none" | "floydSteinberg" | "atkinson";
  frames: GifExportFrame[];
}

export interface GifSizeEstimateResult {
  bytes: number;
}

// Keep temporary String.fromCharCode calls bounded while avoiding a full JS number array.
export const GIF_IPC_BASE64_CHUNK_BYTES = 64 * 1024;
export const GIF_SPOOL_FRAME_THRESHOLD = 64;

export interface AnimationSizeEstimateResult {
  bytes: number;
}

export interface PngSequenceSizeEstimateResult {
  bytes: number;
  frames: number;
}

export interface PngSequenceExportRequest {
  jobId?: string;
  outputDir?: string;
  outputLocation?: GifOutputLocation;
  sourcePath?: string | null;
  outputSubdirectory?: string;
  outputDirectory?: string;
  baseName: string;
  frames: GifExportFrame[];
  overwriteExisting?: boolean;
}

export interface AnimationExportRequest extends GifOutputLocationRequest {
  jobId?: string;
  width: number;
  height: number;
  loopMode: "infinite" | "finite";
  loopCount: number;
  frames: GifExportFrame[];
  overwriteExisting?: boolean;
}

export function isTauriEnvironment(): boolean {
  return typeof window !== "undefined"
    && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function getErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "GIF 导出失败，请检查帧图片和参数后重试。";
}

const GIF_EXPORT_JOB_STATUSES = ["running", "cancelling", "completed", "cancelled", "failed"] as const;
const GIF_EXPORT_JOB_STAGES = ["validating", "encoding", "publishing", "completed", "cancelled", "failed"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`GIF 导出进度字段 ${field} 无效。`);
  }
  return value;
}

function readNullableString(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  if (value !== null && typeof value !== "string") {
    throw new Error(`GIF 导出进度字段 ${field} 无效。`);
  }
  return value;
}

function readFrameCount(payload: Record<string, unknown>, field: string): number {
  const value = payload[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`GIF 导出进度字段 ${field} 无效。`);
  }
  return value;
}

function isGifExportJobStatus(value: unknown): value is GifExportJobStatus {
  return typeof value === "string" && GIF_EXPORT_JOB_STATUSES.includes(value as GifExportJobStatus);
}

function isGifExportJobStage(value: unknown): value is GifExportJobStage {
  return typeof value === "string" && GIF_EXPORT_JOB_STAGES.includes(value as GifExportJobStage);
}

function normalizeJobId(jobId: string): string {
  const normalized = jobId.trim();
  if (!normalized) throw new Error("导出任务 ID 不能为空。");
  return normalized;
}

export function parseGifExportProgress(value: unknown): GifExportProgress {
  if (!isRecord(value)) throw new Error("GIF 导出进度响应无效。");
  const status = value.status;
  const stage = value.stage;
  if (!isGifExportJobStatus(status)) throw new Error("GIF 导出进度字段 status 无效。");
  if (!isGifExportJobStage(stage)) throw new Error("GIF 导出进度字段 stage 无效。");
  const completedFrames = readFrameCount(value, "completedFrames");
  const totalFrames = readFrameCount(value, "totalFrames");
  if (completedFrames > totalFrames) {
    throw new Error("GIF 导出进度帧数无效。");
  }
  return {
    jobId: readRequiredString(value, "jobId"),
    format: readRequiredString(value, "format"),
    status,
    stage,
    completedFrames,
    totalFrames,
    outputPath: readNullableString(value, "outputPath"),
    error: readNullableString(value, "error"),
  };
}

function encodeFrameBase64(data: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < data.byteLength; offset += GIF_IPC_BASE64_CHUNK_BYTES) {
    const chunk = data.subarray(offset, offset + GIF_IPC_BASE64_CHUNK_BYTES);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function serializeGifFrames(frames: GifExportFrame[]) {
  return frames.map((frame) => ({
    dataBase64: encodeFrameBase64(frame.data),
    durationMs: frame.durationMs,
  }));
}

function serializeOutputLocation(request: GifOutputLocationRequest) {
  return {
    ...(request.outputPath?.trim() ? { outputPath: request.outputPath.trim() } : {}),
    ...(request.outputLocation ? { outputLocation: request.outputLocation } : {}),
    ...(request.fileName?.trim() ? { fileName: request.fileName.trim() } : {}),
    ...(request.sourcePath?.trim() ? { sourcePath: request.sourcePath.trim() } : {}),
    ...(request.outputSubdirectory?.trim() ? { outputSubdirectory: request.outputSubdirectory.trim() } : {}),
    ...(request.outputDirectory?.trim() ? { outputDirectory: request.outputDirectory.trim() } : {}),
  };
}

function serializeGifSizeRequest(request: GifSizeEstimateRequest) {
  const payload = { ...request } as GifSizeEstimateRequest & { outputPath?: string; overwriteExisting?: boolean };
  delete payload.outputPath;
  delete payload.overwriteExisting;
  return {
    ...payload,
    encodingSpeed: payload.encodingSpeed ?? 1,
    colorCount: payload.colorCount ?? 256,
    ditherMode: payload.ditherMode ?? "none",
    frames: serializeGifFrames(payload.frames),
  };
}

function serializeAnimationSizeRequest(request: AnimationExportRequest) {
  return {
    width: request.width,
    height: request.height,
    loopMode: request.loopMode,
    loopCount: request.loopCount,
    frames: serializeGifFrames(request.frames),
  };
}

function serializePngSequenceSizeRequest(request: PngSequenceExportRequest) {
  return {
    baseName: request.baseName,
    frames: serializeGifFrames(request.frames),
  };
}

export async function pickGifOutput(suggestedName: string): Promise<string | null> {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持 GIF 文件保存，请在桌面应用中执行导出。");
  }
  try {
    return await invoke<string | null>("pick_gif_output", { suggestedName });
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function revealGifOutput(path: string): Promise<void> {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持打开导出文件夹，请在桌面应用中执行。");
  }
  const normalizedPath = path.trim();
  if (!normalizedPath) throw new Error("导出路径为空，无法打开文件夹。");
  try {
    await revealItemInDir(normalizedPath);
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function exportGif(request: GifExportRequest): Promise<string> {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持 GIF 导出，请在桌面应用中执行导出。");
  }
  let spoolId: string | undefined;
  try {
    if (request.frames.length > GIF_SPOOL_FRAME_THRESHOLD) {
      spoolId = await invoke<string>("create_gif_frame_spool");
      for (const frame of request.frames) {
        await invoke<void>("write_gif_frame_spool", {
          request: { spoolId, dataBase64: encodeFrameBase64(frame.data) },
        });
      }
    }
    return await invoke<string>("export_gif", {
      request: {
        ...serializeOutputLocation(request),
        ...(request.jobId?.trim() ? { jobId: request.jobId.trim() } : {}),
        width: request.width,
        height: request.height,
        loopMode: request.loopMode,
        loopCount: request.loopCount,
        overwriteExisting: request.overwriteExisting ?? false,
        encodingSpeed: request.encodingSpeed ?? 1,
        colorCount: request.colorCount ?? 256,
        ditherMode: request.ditherMode ?? "none",
        ...(spoolId
          ? { frames: [], spoolId, spoolDurations: request.frames.map((frame) => frame.durationMs) }
          : { frames: serializeGifFrames(request.frames) }),
      },
    });
  } catch (error) {
    if (spoolId) {
      await invoke<void>("discard_gif_frame_spool", { spoolId }).catch(() => undefined);
    }
    throw new Error(getErrorMessage(error));
  }
}

export async function estimateGifSize(request: GifSizeEstimateRequest): Promise<GifSizeEstimateResult> {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持 GIF 体积测量，请在桌面应用中执行导出。");
  }
  try {
    return await invoke<GifSizeEstimateResult>("estimate_gif_size", {
      request: serializeGifSizeRequest(request),
    });
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function estimateAnimationSize(
  format: "webp" | "apng",
  request: AnimationExportRequest,
): Promise<AnimationSizeEstimateResult> {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持动图体积测量，请在桌面应用中执行。");
  }
  try {
    return await invoke<AnimationSizeEstimateResult>("estimate_animation_size", {
      format,
      request: serializeAnimationSizeRequest(request),
    });
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function pickGifSequenceOutput(): Promise<string | null> {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持选择 PNG 帧序列目录，请在桌面应用中执行导出。");
  }
  try {
    return await invoke<string | null>("pick_gif_sequence_output");
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function exportPngSequence(request: PngSequenceExportRequest): Promise<string[]> {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持 PNG 帧序列导出，请在桌面应用中执行导出。");
  }
  try {
    return await invoke<string[]>("export_png_sequence", {
      request: {
        ...(request.outputDir?.trim() ? { outputDir: request.outputDir.trim() } : {}),
        ...(request.outputLocation ? { outputLocation: request.outputLocation } : {}),
        ...(request.sourcePath?.trim() ? { sourcePath: request.sourcePath.trim() } : {}),
        ...(request.outputSubdirectory?.trim() ? { outputSubdirectory: request.outputSubdirectory.trim() } : {}),
        ...(request.outputDirectory?.trim() ? { outputDirectory: request.outputDirectory.trim() } : {}),
        ...(request.jobId?.trim() ? { jobId: request.jobId.trim() } : {}),
        baseName: request.baseName,
        overwriteExisting: request.overwriteExisting ?? false,
        frames: serializeGifFrames(request.frames),
      },
    });
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function estimatePngSequenceSize(
  request: PngSequenceExportRequest,
): Promise<PngSequenceSizeEstimateResult> {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持 PNG 帧序列体积测量，请在桌面应用中执行。");
  }
  try {
    return await invoke<PngSequenceSizeEstimateResult>("estimate_png_sequence_size", {
      request: serializePngSequenceSizeRequest(request),
    });
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function pickAnimationOutput(
  format: "webp" | "apng",
  suggestedName: string,
): Promise<string | null> {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持选择动图保存位置，请在桌面应用中执行导出。");
  }
  try {
    return await invoke<string | null>("pick_animation_output", { format, suggestedName });
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

async function exportAnimation(
  command: "export_webp_animation" | "export_apng",
  request: AnimationExportRequest,
): Promise<string> {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持动图导出，请在桌面应用中执行导出。");
  }
  try {
    return await invoke<string>(command, {
      request: {
        ...serializeOutputLocation(request),
        ...(request.jobId?.trim() ? { jobId: request.jobId.trim() } : {}),
        width: request.width,
        height: request.height,
        loopMode: request.loopMode,
        loopCount: request.loopCount,
        overwriteExisting: request.overwriteExisting ?? false,
        frames: serializeGifFrames(request.frames),
      },
    });
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export function exportWebpAnimation(request: AnimationExportRequest): Promise<string> {
  return exportAnimation("export_webp_animation", request);
}

export function exportApng(request: AnimationExportRequest): Promise<string> {
  return exportAnimation("export_apng", request);
}

export async function cancelGifExport(jobId: string): Promise<GifExportProgress> {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持取消 GIF 导出，请在桌面应用中执行导出。");
  }
  try {
    const progress = await invoke<unknown>("cancel_gif_export", { jobId: normalizeJobId(jobId) });
    return parseGifExportProgress(progress);
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function getGifExportProgress(jobId: string): Promise<GifExportProgress> {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持查询 GIF 导出进度，请在桌面应用中执行导出。");
  }
  try {
    const progress = await invoke<unknown>("get_gif_export_progress", { jobId: normalizeJobId(jobId) });
    return parseGifExportProgress(progress);
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}
