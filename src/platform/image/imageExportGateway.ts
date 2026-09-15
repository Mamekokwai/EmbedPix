import { invoke } from "@tauri-apps/api/core";
import type {
  ExportImageRequest,
  ExportImageResponse,
} from "../../features/image-converter/types";

export const EXPORT_IMAGE_COMMAND = "export_image" as const;
export const MAX_METADATA_BYTES = 64 * 1024;
export const MAX_RAW_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_SOURCE_FILE_NAME_BYTES = 1024;

export interface NativeImageFile {
  path: string;
  fileName: string;
  data: number[];
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
    ...(request.overwriteExisting ? { overwriteExisting: true } : {}),
    ...(request.deleteSource ? { deleteSource: true } : {}),
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

export async function readImageFile(path: string): Promise<NativeImageFile> {
  return invoke<NativeImageFile>("read_image_file", { path });
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
      return response;
    }

    return response?.outputPath ?? null;
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}
