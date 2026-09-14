import { invoke } from "@tauri-apps/api/core";
import type {
  ExportImageRequest,
  ExportImageResponse,
} from "../../features/image-converter/types";

export const EXPORT_IMAGE_COMMAND = "export_image" as const;

function getErrorMessage(error: unknown) {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "导出失败，请检查图片和转换参数后重试。";
}

function isTauriEnvironment() {
  return typeof window !== "undefined" &&
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export async function exportImage(request: ExportImageRequest) {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持导出，请在 EngiFormat 桌面应用中执行导出。");
  }

  try {
    const response = await invoke<ExportImageResponse | string | null>(
      EXPORT_IMAGE_COMMAND,
      { ...request },
    );

    if (typeof response === "string") {
      return response;
    }

    return response?.outputPath ?? null;
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}
