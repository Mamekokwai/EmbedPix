import { invoke } from "@tauri-apps/api/core";

export interface GifExportFrame {
  data: Uint8Array;
  durationMs: number;
}

export interface GifExportRequest {
  outputPath: string;
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

function isTauriEnvironment(): boolean {
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

export async function exportGif(request: GifExportRequest): Promise<string> {
  if (!isTauriEnvironment()) {
    throw new Error("当前预览环境不支持 GIF 导出，请在桌面应用中执行导出。");
  }
  try {
    return await invoke<string>("export_gif", {
      request: {
        ...request,
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
