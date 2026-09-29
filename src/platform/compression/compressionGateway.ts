import { invoke } from "@tauri-apps/api/core";
import { isTauriEnvironment, pickImageDirectory, pickImageFiles, type ImageDirectoryImportResult, type NativeImageFile } from "../image/imageExportGateway";
import type { CompressionFormat, CompressionOptions, CompressionOutputLocation, MetadataPolicy } from "../../features/image-compression/types";

export const PREFLIGHT_COMPRESSION_COMMAND = "preflight_compression" as const;
export const PREVIEW_COMPRESSION_COMMAND = "preview_compression" as const;
export const ESTIMATE_IMAGE_COMPRESSION_COMMAND = "estimate_image_compression" as const;
export const COMPRESS_IMAGE_COMMAND = "compress_image" as const;
export const CANCEL_COMPRESSION_COMMAND = "cancel_compression" as const;
export const GET_COMPRESSION_PROGRESS_COMMAND = "get_compression_progress" as const;
export const COMPRESSION_SCHEMA_VERSION = 1 as const;
export const MAX_COMPRESSION_INPUT_BYTES = 32 * 1024 * 1024;

export interface CompressionEnvelopeRequest {
  fileName: string;
  outputFileName?: string;
  inputData: Uint8Array;
  outputFormat: Exclude<CompressionFormat, "original">;
  outputLocation: CompressionOutputLocation;
  sourcePath?: string;
  outputSubdirectory?: string;
  outputDirectory?: string;
  overwriteExisting: boolean;
  autoSequence?: boolean;
  replaceOriginal?: boolean;
  deleteSource?: boolean;
  jpegQuality: number;
  jpegBackground?: string;
  webpMethod?: number;
  webpNearLossless?: number;
  lossless: boolean;
  skipIfLarger?: boolean;
  pngOptimizationLevel: number;
  maxOutputBytes?: number;
  maxCandidates?: number;
  metadataPolicy: MetadataPolicy;
  jobId?: string;
}

export interface CompressionPreflight { format: string; width: number; height: number; inputBytes: number; outputPath: string; overwritesExisting: boolean; requiredSpaceBytes?: number | null; }
export type CompressionResultStatus = "completed" | "skipped";
export interface CompressionResult {
  jobId: string;
  outputPath: string;
  status: CompressionResultStatus;
  skippedReason: string | null;
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  savingsPercent: number;
  width: number;
  height: number;
  format: string;
  lossless: boolean;
  metadataPolicy: MetadataPolicy;
  sourceDeleted?: boolean;
  targetBytes: number | null;
  targetMet: boolean;
  selectedQuality: number | null;
  candidateSearchMs?: number;
  candidateCount?: number;
}
export interface CompressionProgress { jobId: string; status: string; stage: string; outputPath: string | null; error: string | null; code?: string | null; inputBytes?: number; outputBytes?: number; }
export interface CompressionPreview {
  data: number[];
  width: number;
  height: number;
  format: string;
  outputBytes: number;
  lossless: boolean;
  metadataPolicy: MetadataPolicy;
  status: CompressionResultStatus;
  skippedReason: string | null;
  targetBytes: number | null;
  targetMet: boolean;
  selectedQuality: number | null;
  candidateSearchMs?: number;
  candidateCount?: number;
  qualityMetrics?: CompressionQualityMetrics;
}
export interface CompressionEstimate {
  inputBytes: number;
  outputBytes: number;
  savedBytes: number;
  savingsPercent: number;
  width: number;
  height: number;
  format: string;
  lossless: boolean;
  metadataPolicy: MetadataPolicy;
  status: CompressionResultStatus;
  skippedReason: string | null;
  targetBytes: number | null;
  targetMet: boolean;
  selectedQuality: number | null;
  candidateSearchMs?: number;
  candidateCount?: number;
}
export interface CompressionQualityMetrics { rgbMae: number; psnrDb: number | null; alphaMismatchPixels: number; }

export interface CompressionEstimateRequest {
  fileName: string;
  inputData: Uint8Array;
  outputFormat: Exclude<CompressionFormat, "original">;
  jpegQuality: number;
  jpegBackground?: string;
  webpMethod?: number;
  webpNearLossless?: number;
  lossless: boolean;
  metadataPolicy: MetadataPolicy;
  skipIfLarger?: boolean;
  pngOptimizationLevel: number;
  maxOutputBytes?: number;
  maxCandidates?: number;
}

function getCompressionMetadata(request: CompressionEnvelopeRequest) {
  if (request.metadataPolicy !== "strip") throw new Error("第一阶段原生压缩仅支持移除元数据。");
  return {
    schemaVersion: COMPRESSION_SCHEMA_VERSION,
    fileName: request.fileName,
    ...(request.outputFileName !== undefined ? { outputFileName: request.outputFileName } : {}),
    outputFormat: request.outputFormat,
    outputLocation: request.outputLocation,
    ...(request.sourcePath ? { sourcePath: request.sourcePath } : {}),
    ...(request.outputSubdirectory ? { outputSubdirectory: request.outputSubdirectory } : {}),
    ...(request.outputDirectory ? { outputDirectory: request.outputDirectory } : {}),
    overwriteExisting: request.overwriteExisting,
    ...(request.autoSequence ? { autoSequence: true } : {}),
    ...(request.replaceOriginal ? { replaceOriginal: true } : {}),
    ...(request.deleteSource ? { deleteSource: true } : {}),
    ...(request.outputFormat === "jpg" || (request.outputFormat === "webp" && !request.lossless) ? { jpegQuality: request.jpegQuality } : {}),
    ...(request.outputFormat === "jpg" && request.jpegBackground !== undefined ? { jpegBackground: request.jpegBackground } : {}),
    ...(request.webpMethod !== undefined ? { webpMethod: request.webpMethod } : {}),
    ...(request.outputFormat === "webp" && request.lossless && request.webpNearLossless !== undefined ? { webpNearLossless: request.webpNearLossless } : {}),
    lossless: request.lossless,
    skipIfLarger: request.skipIfLarger ?? true,
    pngOptimizationLevel: request.pngOptimizationLevel,
    ...(request.maxOutputBytes ? { maxOutputBytes: request.maxOutputBytes } : {}),
    ...(request.maxCandidates ? { maxCandidates: request.maxCandidates } : {}),
    metadataPolicy: "strip",
    ...(request.jobId ? { jobId: request.jobId } : {}),
  };
}

export function encodeCompressionEnvelope(request: CompressionEnvelopeRequest): Uint8Array {
  if (!request.inputData.byteLength) throw new Error("图片数据不能为空。");
  if (request.inputData.byteLength > MAX_COMPRESSION_INPUT_BYTES) throw new Error("图片数据超过 32 MiB 限制。");
  if (!Number.isInteger(request.jpegQuality) || request.jpegQuality < 1 || request.jpegQuality > 100) throw new Error("jpegQuality 必须在 1 到 100 之间。");
  if (!Number.isInteger(request.pngOptimizationLevel) || request.pngOptimizationLevel < 0 || request.pngOptimizationLevel > 6) throw new Error("pngOptimizationLevel 必须在 0 到 6 之间。");
  if (request.maxOutputBytes !== undefined && (!Number.isInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > 128 * 1024 * 1024)) throw new Error("maxOutputBytes 必须在 1 到 128 MiB 之间。");
  if (request.maxCandidates !== undefined && (!Number.isInteger(request.maxCandidates) || request.maxCandidates < 1 || request.maxCandidates > 12)) throw new Error("maxCandidates 必须在 1 到 12 之间。");
  if (request.webpMethod !== undefined && (!Number.isInteger(request.webpMethod) || request.webpMethod < 0 || request.webpMethod > 6)) throw new Error("webpMethod 必须在 0 到 6 之间。");
  if (request.webpMethod !== undefined && (request.outputFormat !== "webp" || request.lossless)) throw new Error("webpMethod 仅支持有损 WebP。");
  if (request.jpegBackground !== undefined && (!/^#[0-9a-f]{6}$/iu.test(request.jpegBackground.trim()) || request.outputFormat !== "jpg")) throw new Error("jpegBackground 必须是 JPEG 输出使用的 #RRGGBB 颜色。");
  if (request.webpNearLossless !== undefined && (!Number.isInteger(request.webpNearLossless) || request.webpNearLossless < 1 || request.webpNearLossless > 99)) throw new Error("webpNearLossless 必须在 1 到 99 之间。");
  if (request.webpNearLossless !== undefined && (request.outputFormat !== "webp" || !request.lossless)) throw new Error("webpNearLossless 仅支持无损 WebP。");
  if (request.autoSequence && request.overwriteExisting) throw new Error("自动序号不能与覆盖同名同时启用。");
  if (request.autoSequence && request.replaceOriginal) throw new Error("自动序号不能与覆盖原图同时启用。");
  if ((request.outputLocation === "source" || request.outputLocation === "subfolder") && !request.sourcePath) throw new Error("源文件夹输出需要源文件路径。");
  if (request.outputLocation === "subfolder" && !request.outputSubdirectory) throw new Error("源文件夹子目录不能为空。");
  if (request.outputLocation === "directory" && !request.outputDirectory) throw new Error("指定目录输出需要目录路径。");
  if (request.deleteSource && !request.sourcePath) throw new Error("删除源文件需要源文件路径。");
  if (request.deleteSource && request.replaceOriginal) throw new Error("删除源文件不能与覆盖原图同时启用。");
  const metadataBytes = new TextEncoder().encode(JSON.stringify(getCompressionMetadata(request)));
  const payload = new Uint8Array(8 + metadataBytes.byteLength + request.inputData.byteLength);
  payload.set(new Uint8Array([0x45, 0x47, 0x46, 0x31]));
  new DataView(payload.buffer).setUint32(4, metadataBytes.byteLength, true);
  payload.set(metadataBytes, 8);
  payload.set(request.inputData, 8 + metadataBytes.byteLength);
  return payload;
}

export function encodeCompressionEstimateEnvelope(request: CompressionEstimateRequest): Uint8Array {
  if (!request.inputData.byteLength) throw new Error("图片数据不能为空。");
  if (request.inputData.byteLength > MAX_COMPRESSION_INPUT_BYTES) throw new Error("图片数据超过 32 MiB 限制。");
  if (request.metadataPolicy !== "strip") throw new Error("第一阶段原生压缩仅支持移除元数据。");
  if (!Number.isInteger(request.pngOptimizationLevel) || request.pngOptimizationLevel < 0 || request.pngOptimizationLevel > 6) throw new Error("pngOptimizationLevel 必须在 0 到 6 之间。");
  if (!Number.isInteger(request.jpegQuality) || request.jpegQuality < 1 || request.jpegQuality > 100) throw new Error("jpegQuality 必须在 1 到 100 之间。");
  if (request.webpMethod !== undefined && (!Number.isInteger(request.webpMethod) || request.webpMethod < 0 || request.webpMethod > 6)) throw new Error("webpMethod 必须在 0 到 6 之间。");
  if (request.webpMethod !== undefined && (request.outputFormat !== "webp" || request.lossless)) throw new Error("webpMethod 仅支持有损 WebP。");
  if (request.jpegBackground !== undefined && (!/^#[0-9a-f]{6}$/iu.test(request.jpegBackground.trim()) || request.outputFormat !== "jpg")) throw new Error("jpegBackground 必须是 JPEG 输出使用的 #RRGGBB 颜色。");
  if (request.webpNearLossless !== undefined && (!Number.isInteger(request.webpNearLossless) || request.webpNearLossless < 1 || request.webpNearLossless > 99)) throw new Error("webpNearLossless 必须在 1 到 99 之间。");
  if (request.webpNearLossless !== undefined && (request.outputFormat !== "webp" || !request.lossless)) throw new Error("webpNearLossless 仅支持无损 WebP。");
  if (request.maxOutputBytes !== undefined && (!Number.isInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > 128 * 1024 * 1024)) throw new Error("maxOutputBytes 必须在 1 到 128 MiB 之间。");
  if (request.maxCandidates !== undefined && (!Number.isInteger(request.maxCandidates) || request.maxCandidates < 1 || request.maxCandidates > 12)) throw new Error("maxCandidates 必须在 1 到 12 之间。");
  const metadataBytes = new TextEncoder().encode(JSON.stringify({
    schemaVersion: COMPRESSION_SCHEMA_VERSION,
    fileName: request.fileName,
    outputFormat: request.outputFormat,
    ...(request.outputFormat === "jpg" || (request.outputFormat === "webp" && !request.lossless) ? { jpegQuality: request.jpegQuality } : {}),
    ...(request.outputFormat === "jpg" && request.jpegBackground !== undefined ? { jpegBackground: request.jpegBackground } : {}),
    ...(request.webpMethod !== undefined ? { webpMethod: request.webpMethod } : {}),
    ...(request.outputFormat === "webp" && request.lossless && request.webpNearLossless !== undefined ? { webpNearLossless: request.webpNearLossless } : {}),
    lossless: request.lossless,
    skipIfLarger: request.skipIfLarger ?? true,
    pngOptimizationLevel: request.pngOptimizationLevel,
    ...(request.maxOutputBytes !== undefined ? { maxOutputBytes: request.maxOutputBytes } : {}),
    ...(request.maxCandidates !== undefined ? { maxCandidates: request.maxCandidates } : {}),
    metadataPolicy: "strip",
  }));
  const payload = new Uint8Array(8 + metadataBytes.byteLength + request.inputData.byteLength);
  payload.set(new Uint8Array([0x45, 0x47, 0x46, 0x31]));
  new DataView(payload.buffer).setUint32(4, metadataBytes.byteLength, true);
  payload.set(metadataBytes, 8);
  payload.set(request.inputData, 8 + metadataBytes.byteLength);
  return payload;
}

export async function pickCompressionFiles(): Promise<NativeImageFile[]> {
  if (!isTauriEnvironment()) throw new Error("当前预览环境请使用浏览器文件选择器。");
  return pickImageFiles();
}

export async function pickCompressionDirectoryResult(): Promise<ImageDirectoryImportResult | null> {
  if (!isTauriEnvironment()) throw new Error("导入文件夹仅在桌面应用中可用。");
  return pickImageDirectory();
}

export async function pickCompressionDirectory(): Promise<NativeImageFile[]> {
  const result = await pickCompressionDirectoryResult();
  return result?.files ?? [];
}

export function createCompressionRequest(file: NativeImageFile, options: CompressionOptions, jobId?: string): CompressionEnvelopeRequest {
  return {
    fileName: file.fileName,
    outputFileName: options.outputFileName,
    inputData: new Uint8Array(file.data),
    outputFormat: options.format,
    outputLocation: options.outputLocation,
    sourcePath: file.path,
    outputSubdirectory: options.outputLocation === "subfolder" ? options.outputSubdirectory : undefined,
    outputDirectory: options.outputLocation === "directory" ? options.outputDirectory : undefined,
    overwriteExisting: options.overwrite,
    autoSequence: options.autoNumbering ?? false,
    replaceOriginal: options.replaceOriginal ?? false,
    deleteSource: options.deleteSource ?? false,
    jpegQuality: options.quality,
    jpegBackground: options.jpegBackground,
    webpMethod: options.webpMethod,
    webpNearLossless: options.webpNearLossless ?? undefined,
    lossless: options.format === "png" || (options.format === "webp" && options.lossless),
    skipIfLarger: options.skipIfLarger ?? true,
    pngOptimizationLevel: options.pngOptimizationLevel,
    maxOutputBytes: options.maxOutputBytes,
    maxCandidates: options.maxCandidates,
    metadataPolicy: options.metadataPolicy,
    jobId,
  };
}

export async function preflightCompression(request: CompressionEnvelopeRequest): Promise<CompressionPreflight> {
  if (!isTauriEnvironment()) throw new Error("压缩预检需要桌面原生命令，当前环境仅可编辑参数。");
  return invoke<CompressionPreflight>(PREFLIGHT_COMPRESSION_COMMAND, encodeCompressionEnvelope(request));
}

export async function previewCompression(request: CompressionEnvelopeRequest, signal?: AbortSignal): Promise<CompressionPreview> {
  if (!isTauriEnvironment()) throw new Error("真实压缩预览需要桌面原生命令，当前环境仅可查看原图。");
  if (signal?.aborted) throw new DOMException("压缩预览已取消。", "AbortError");
  const preview = await invoke<CompressionPreview>(PREVIEW_COMPRESSION_COMMAND, encodeCompressionEnvelope(request));
  if (signal?.aborted) throw new DOMException("压缩预览已取消。", "AbortError");
  return preview;
}

export async function estimateImageCompression(request: CompressionEstimateRequest): Promise<CompressionEstimate> {
  if (!isTauriEnvironment()) throw new Error("图片压缩预估需要桌面原生命令，当前环境仅可编辑参数。");
  return invoke<CompressionEstimate>(ESTIMATE_IMAGE_COMPRESSION_COMMAND, encodeCompressionEstimateEnvelope(request));
}

export async function compressImage(request: CompressionEnvelopeRequest): Promise<CompressionResult> {
  if (!isTauriEnvironment()) throw new Error("图片压缩需要桌面应用，请在 Tauri 中执行。");
  return invoke<CompressionResult>(COMPRESS_IMAGE_COMMAND, encodeCompressionEnvelope(request));
}

export async function getCompressionProgress(jobId: string): Promise<CompressionProgress> {
  if (!isTauriEnvironment()) throw new Error("当前预览环境无法读取原生压缩进度。");
  return invoke<CompressionProgress>(GET_COMPRESSION_PROGRESS_COMMAND, { jobId });
}

const COMPRESSION_ERROR_LABELS: Record<string, string> = {
  cancelled: "已取消",
  decode: "解码",
  encode: "编码",
  metadata_policy_unsupported: "元数据策略",
  publish: "发布/写入",
  skipped: "已跳过",
};

const COMPRESSION_STAGE_LABELS: Record<string, string> = {
  cancelling: "正在取消",
  cancelled: "已取消",
  completed: "已完成",
  decoding: "解码",
  encoding: "编码",
  failed: "失败",
  planning: "规划候选",
  preflight: "预检",
  publishing: "发布输出",
  queued: "排队等待",
  reading: "读取输入",
  skipped: "已跳过",
  validating: "校验输出",
};

export function formatCompressionProgressStage(stage: string): string {
  return COMPRESSION_STAGE_LABELS[stage] ?? stage;
}

export function formatCompressionProgressError(progress: Pick<CompressionProgress, "error" | "code">): string | null {
  if (!progress.error) return null;
  const label = progress.code ? COMPRESSION_ERROR_LABELS[progress.code] : undefined;
  return label ? `${label}（${progress.code}）：${progress.error}` : progress.code ? `[${progress.code}] ${progress.error}` : progress.error;
}

export async function cancelCompression(jobId: string): Promise<CompressionProgress> {
  if (!isTauriEnvironment()) throw new Error("当前预览环境无法取消原生压缩。");
  return invoke<CompressionProgress>(CANCEL_COMPRESSION_COMMAND, { jobId });
}
