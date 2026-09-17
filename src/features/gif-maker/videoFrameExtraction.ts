import { MAX_VIDEO_FRAMES } from "./videoGifLogic";
import type { VideoCropRect, VideoFramePlan } from "./videoGifLogic";
import type { GifMakerVideoRotation as VideoRotation } from "./gifMakerPreferences";
import type { GifCanvasSize } from "./gifMakerLogic";

export interface VideoFrameExtractionSource {
  previewUrl: string;
  name: string;
}

export interface ExtractedVideoFrame {
  blob: Blob;
  previewUrl: string;
  durationMs: number;
}

export interface VideoFrameExtractionDependencies {
  createVideo: () => HTMLVideoElement;
  createCanvas: () => HTMLCanvasElement;
  drawFrame: (
    context: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    crop: VideoCropRect,
    rotation: VideoRotation,
    outputSize: GifCanvasSize,
  ) => void;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

function createAbortError(): DOMException {
  return new DOMException("抽帧已取消", "AbortError");
}

function waitForVideoMetadata(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", handleMetadata);
      video.removeEventListener("error", handleError);
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleMetadata = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("无法解码视频，请尝试 MP4 或 WebM。"));
    };
    const handleAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    if (video.readyState >= 1) {
      resolve();
      return;
    }
    video.addEventListener("loadedmetadata", handleMetadata, { once: true });
    video.addEventListener("error", handleError, { once: true });
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

function seekVideo(video: HTMLVideoElement, time: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error("视频帧读取超时，请尝试缩短时间范围或更换视频。"));
    }, 10_000);
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("error", handleError);
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleSeeked = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("视频帧读取失败，请尝试更换视频。"));
    };
    const handleAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    video.addEventListener("seeked", handleSeeked, { once: true });
    video.addEventListener("error", handleError, { once: true });
    signal?.addEventListener("abort", handleAbort, { once: true });
    try {
      video.currentTime = time;
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", handleAbort);
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createAbortError());
    };
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener("abort", handleAbort, { once: true });
    try {
      canvas.toBlob((blob) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!blob) reject(new Error("无法生成视频帧，请重试。"));
        else resolve(blob);
      }, "image/png");
    } catch (error) {
      settled = true;
      cleanup();
      reject(error);
    }
  });
}

export async function extractVideoFrameBlobs(
  source: VideoFrameExtractionSource,
  plan: VideoFramePlan,
  crop: VideoCropRect,
  rotation: VideoRotation,
  outputSize: GifCanvasSize,
  onProgress: (current: number, total: number) => void,
  dependencies: VideoFrameExtractionDependencies,
  signal?: AbortSignal,
): Promise<ExtractedVideoFrame[]> {
  if (signal?.aborted) throw createAbortError();
  if (!plan.times.length || plan.times.length > MAX_VIDEO_FRAMES) {
    throw new Error(`视频帧数必须在 1 到 ${MAX_VIDEO_FRAMES} 之间。`);
  }
  const video = dependencies.createVideo();
  let canvas: HTMLCanvasElement | null = null;
  const frames: ExtractedVideoFrame[] = [];
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = source.previewUrl;
  try {
    await waitForVideoMetadata(video, signal);
    if (signal?.aborted) throw createAbortError();
    canvas = dependencies.createCanvas();
    canvas.width = outputSize.width;
    canvas.height = outputSize.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法创建视频帧画布。");
    for (const [index, time] of plan.times.entries()) {
      if (signal?.aborted) throw createAbortError();
      await seekVideo(video, time, signal);
      if (signal?.aborted) throw createAbortError();
      dependencies.drawFrame(context, video, crop, rotation, outputSize);
      const blob = await canvasToBlob(canvas, signal);
      frames.push({
        blob,
        previewUrl: dependencies.createObjectURL(blob),
        durationMs: plan.durationMs,
      });
      onProgress(index + 1, plan.times.length);
    }
    return frames;
  } catch (error) {
    frames.forEach((frame) => dependencies.revokeObjectURL(frame.previewUrl));
    throw error;
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}
