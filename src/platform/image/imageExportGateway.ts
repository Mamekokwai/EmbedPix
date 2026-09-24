import { invoke } from "@tauri-apps/api/core";
import type {
  ExportImageRequest,
  ExportImageResponse,
  ImagePreviewResponse,
} from "../../features/image-converter/types";

export const EXPORT_IMAGE_COMMAND = "export_image" as const;
export const PREVIEW_IMAGE_EXPORT_COMMAND = "preview_image_export" as const;
export const PICK_OUTPUT_DIRECTORY_COMMAND = "pick_gif_sequence_output" as const;
export const PREFLIGHT_IMAGE_EXPORTS_COMMAND = "preflight_image_exports" as const;
export const MAX_METADATA_BYTES = 64 * 1024;
export const MAX_RAW_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_SOURCE_FILE_NAME_BYTES = 1024;

export interface NativeImageFile {
  path: string;
  fileName: string;
  data: number[];
}

export interface ImageExportPreflightResult {
  supported: boolean;
  diskSpaceChecked: boolean;
  availableBytes: number | null;
  diskSpaceSufficient: boolean | null;
  items: Array<{
    targetPath: string;
    targetExists: boolean;
    parentExists: boolean;
    parentWritable: boolean;
    reason: string | null;
  }>;
}

const EXPORT_ENVELOPE_MAGIC = new Uint8Array([0x45, 0x47, 0x46, 0x31]);

function getExportMetadata(request: ExportImageRequest) {
  return {
    fileName: request.fileName,
    outputFormat: request.outputFormat,
    width: request.width,
    height: request.height,
    keepAspectRatio: request.keepAspectRatio,
    backgroundColor: request.backgroundColor,
    bitDepth: request.bitDepth,
    jpegQuality: request.jpegQuality,
    byteOrder: request.byteOrder,
    channelOrder: request.channelOrder,
    rowOrder: request.rowOrder,
    rowAlignment: request.rowAlignment,
    cArrayName: request.cArrayName,
    ...(request.outputLocation ? { outputLocation: request.outputLocation } : {}),
    ...(request.sourcePath ? { sourcePath: request.sourcePath } : {}),
    ...(request.outputSubdirectory ? { outputSubdirectory: request.outputSubdirectory } : {}),
    ...(request.outputDirectory ? { outputDirectory: request.outputDirectory } : {}),
    ...(request.overwriteSameName ? { overwriteSameName: true } : {}),
    ...(request.watermarkText?.trim() ? {
      watermarkText: request.watermarkText.trim(),
      watermarkPosition: request.watermarkPosition ?? "bottom-right",
      watermarkOpacity: request.watermarkOpacity ?? 60,
      watermarkFontSize: request.watermarkFontSize ?? 16,
    } : {}),
    ...(request.deleteSource ? { deleteSource: true } : {}),
    ...(request.transform ? { transform: request.transform } : {}),
    ...(request.metadataPolicy ? { metadataPolicy: request.metadataPolicy } : {}),
  };
}

export function encodeExportEnvelope(request: ExportImageRequest) {
  validateExportEnvelopeInput(request.inputData.byteLength, request.fileName);
  const metadataBytes = new TextEncoder().encode(JSON.stringify(getExportMetadata(request)));
  if (metadataBytes.byteLength > MAX_METADATA_BYTES) {
    throw new Error(`导出元数据不能超过 ${MAX_METADATA_BYTES} 字节。`);
  }

  const payload = new Uint8Array(8 + metadataBytes.byteLength + request.inputData.byteLength);
  payload.set(EXPORT_ENVELOPE_MAGIC);
  new DataView(payload.buffer).setUint32(4, metadataBytes.byteLength, true);
  payload.set(metadataBytes, 8);
  payload.set(request.inputData, 8 + metadataBytes.byteLength);
  return payload;
}

export function validateExportEnvelopeInput(inputLength: number, fileName: string) {
  if (inputLength === 0) {
    throw new Error("图片数据不能为空。");
  }
  if (inputLength > MAX_RAW_IMAGE_BYTES) {
    throw new Error(`图片数据不能超过 ${MAX_RAW_IMAGE_BYTES / (1024 * 1024)} MiB。`);
  }
  if (!fileName) {
    throw new Error("源文件名不能为空。");
  }
  if (new TextEncoder().encode(fileName).byteLength > MAX_SOURCE_FILE_NAME_BYTES) {
    throw new Error(`源文件名不能超过 ${MAX_SOURCE_FILE_NAME_BYTES} 个 UTF-8 字节。`);
  }
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(fileName)) {
    throw new Error("源文件名不能包含控制字符。");
  }
}

function getErrorMessage(error: unknown) {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "导出失败，请检查图片和转换参数后重试。";
}

export function isTauriEnvironment() {
  return typeof window !== "undefined" &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export async function pickImageFile(): Promise<NativeImageFile | null> {
  return invoke<NativeImageFile | null>("pick_image");
}

export async function preflightImageExports(targetPaths: ReadonlyArray<string>, estimatedBytes = 0): Promise<ImageExportPreflightResult> {
  if (!isTauriEnvironment()) {
    return {
      supported: false,
      diskSpaceChecked: false,
      availableBytes: null,
      diskSpaceSufficient: null,
      items: targetPaths.map((targetPath) => ({ targetPath, targetExists: false, parentExists: false, parentWritable: false, reason: "当前预览环境不支持文件系统预检。" })),
    };
  }
  try {
    return await invoke<ImageExportPreflightResult>(PREFLIGHT_IMAGE_EXPORTS_COMMAND, { request: { targetPaths, estimatedBytes } });
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function pickImageFiles(): Promise<NativeImageFile[]> {
  return invoke<NativeImageFile[]>("pick_images");
}

export async function readImageFile(path: string): Promise<NativeImageFile> {
  return invoke<NativeImageFile>("read_image_file", { path });
}

export async function pickOutputDirectory(): Promise<string | null> {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持选择输出目录，请在桌面应用中执行。" );
  }

  try {
    return await invoke<string | null>(PICK_OUTPUT_DIRECTORY_COMMAND);
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function exportImage(request: ExportImageRequest) {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持导出，请在桌面应用中执行导出。");
  }

  try {
    const envelope = encodeExportEnvelope(request);
    const response = await invoke<ExportImageResponse | string | null>(
      EXPORT_IMAGE_COMMAND,
      envelope,
    );

    if (typeof response === "string") {
      return { outputPath: response };
    }

    return response;
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}

export async function previewImageExport(request: ExportImageRequest): Promise<ImagePreviewResponse> {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持编码预览，请在桌面应用中执行。");
  }
  try {
    return await invoke<ImagePreviewResponse>(PREVIEW_IMAGE_EXPORT_COMMAND, encodeExportEnvelope(request));
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}
