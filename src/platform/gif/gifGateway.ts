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

export interface GifExportRequest extends GifOutputLocationRequest {
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

export interface AnimationSizeEstimateResult {
  bytes: number;
}

export interface PngSequenceExportRequest {
  outputDir: string;
  baseName: string;
  frames: GifExportFrame[];
  overwriteExisting?: boolean;
}

export interface AnimationExportRequest extends GifOutputLocationRequest {
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

function serializeGifFrames(frames: GifExportFrame[]) {
  return frames.map((frame) => ({
    data: Array.from(frame.data),
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
  try {
    return await invoke<string>("export_gif", {
      request: {
        ...serializeOutputLocation(request),
        width: request.width,
        height: request.height,
        loopMode: request.loopMode,
        loopCount: request.loopCount,
        overwriteExisting: request.overwriteExisting ?? false,
        encodingSpeed: request.encodingSpeed ?? 1,
        colorCount: request.colorCount ?? 256,
        ditherMode: request.ditherMode ?? "none",
        frames: serializeGifFrames(request.frames),
      },
    });
  } catch (error) {
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
        outputDir: request.outputDir,
        baseName: request.baseName,
        overwriteExisting: request.overwriteExisting ?? false,
        frames: serializeGifFrames(request.frames),
      },
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
