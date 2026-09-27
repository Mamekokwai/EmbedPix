import { invoke } from "@tauri-apps/api/core";
import { isTauriEnvironment, pickImageDirectory, pickImageFiles, type ImageDirectoryImportResult, type NativeImageFile } from "../image/imageExportGateway";
import type { CompressionFormat, CompressionOptions, MetadataPolicy } from "../../features/image-compression/types";

export const PREFLIGHT_COMPRESSION_COMMAND = "preflight_compression" as const;
export const COMPRESS_IMAGE_COMMAND = "compress_image" as const;
export const CANCEL_COMPRESSION_COMMAND = "cancel_compression" as const;
export const GET_COMPRESSION_PROGRESS_COMMAND = "get_compression_progress" as const;

export interface CompressionEnvelopeRequest {
  fileName: string;
  inputData: Uint8Array;
  outputFormat: Exclude<CompressionFormat, "original">;
  sourcePath?: string;
  outputDirectory?: string;
  overwriteExisting: boolean;
  jpegQuality: number;
  metadataPolicy: MetadataPolicy;
  jobId?: string;
}

export interface CompressionPreflight { format: string; width: number; height: number; inputBytes: number; outputPath: string; overwritesExisting: boolean; }
export interface CompressionResult { jobId: string; outputPath: string; outputBytes: number; width: number; height: number; format: string; }
export interface CompressionProgress { jobId: string; status: string; stage: string; outputPath: string | null; error: string | null; }

function getCompressionMetadata(request: CompressionEnvelopeRequest) {
  if (request.metadataPolicy !== "strip") throw new Error("第一阶段原生压缩仅支持移除元数据。");
  return {
    fileName: request.fileName,
    outputFormat: request.outputFormat,
    outputLocation: request.outputDirectory ? "directory" : "source",
    ...(request.sourcePath ? { sourcePath: request.sourcePath } : {}),
    ...(request.outputDirectory ? { outputDirectory: request.outputDirectory } : {}),
    overwriteExisting: request.overwriteExisting,
    jpegQuality: request.jpegQuality,
    metadataPolicy: "strip",
    ...(request.jobId ? { jobId: request.jobId } : {}),
  };
}

export function encodeCompressionEnvelope(request: CompressionEnvelopeRequest): Uint8Array {
  if (!request.inputData.byteLength) throw new Error("图片数据不能为空。");
  if (!request.sourcePath && !request.outputDirectory) throw new Error("压缩需要源文件路径或输出目录。");
  const metadataBytes = new TextEncoder().encode(JSON.stringify(getCompressionMetadata(request)));
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

export async function pickCompressionDirectory(): Promise<NativeImageFile[]> {
  if (!isTauriEnvironment()) throw new Error("导入文件夹仅在桌面应用中可用。");
  const result: ImageDirectoryImportResult | null = await pickImageDirectory();
  return result?.files ?? [];
}

export function createCompressionRequest(file: NativeImageFile, options: CompressionOptions, jobId?: string): CompressionEnvelopeRequest {
  return {
    fileName: file.fileName,
    inputData: new Uint8Array(file.data),
    outputFormat: options.format,
    sourcePath: file.path,
    outputDirectory: options.outputDirectory,
    overwriteExisting: options.overwrite,
    jpegQuality: options.quality,
    metadataPolicy: options.metadataPolicy,
    jobId,
  };
}

export async function preflightCompression(request: CompressionEnvelopeRequest): Promise<CompressionPreflight> {
  if (!isTauriEnvironment()) throw new Error("压缩预检需要桌面原生命令，当前环境仅可编辑参数。");
  return invoke<CompressionPreflight>(PREFLIGHT_COMPRESSION_COMMAND, encodeCompressionEnvelope(request));
}

export async function compressImage(request: CompressionEnvelopeRequest): Promise<CompressionResult> {
  if (!isTauriEnvironment()) throw new Error("图片压缩需要桌面应用，请在 Tauri 中执行。");
  return invoke<CompressionResult>(COMPRESS_IMAGE_COMMAND, encodeCompressionEnvelope(request));
}

export async function getCompressionProgress(jobId: string): Promise<CompressionProgress> {
  if (!isTauriEnvironment()) throw new Error("当前预览环境无法读取原生压缩进度。");
  return invoke<CompressionProgress>(GET_COMPRESSION_PROGRESS_COMMAND, { jobId });
}

export async function cancelCompression(jobId: string): Promise<CompressionProgress> {
  if (!isTauriEnvironment()) throw new Error("当前预览环境无法取消原生压缩。");
  return invoke<CompressionProgress>(CANCEL_COMPRESSION_COMMAND, { jobId });
}
