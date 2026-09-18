export const VIDEO_METADATA_TIMEOUT_MS = 15_000;

function createAbortError(): DOMException {
  return new DOMException("视频元数据读取已取消", "AbortError");
}

export function loadVideoMetadata(
  url: string,
  signal?: AbortSignal,
  createVideo: () => HTMLVideoElement = () => document.createElement("video"),
): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const video = createVideo();
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      finish(new Error("读取视频元数据超时，请检查文件或更换视频。"));
    }, VIDEO_METADATA_TIMEOUT_MS);
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", handleMetadata);
      video.removeEventListener("error", handleError);
      signal?.removeEventListener("abort", handleAbort);
      video.removeAttribute("src");
      video.load();
    };
    const finish = (error: Error | DOMException | null, metadata?: { width: number; height: number; duration: number }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(metadata!);
    };
    const handleMetadata = () => {
      const duration = video.duration;
      if (!Number.isFinite(duration) || duration <= 0 || video.videoWidth <= 0 || video.videoHeight <= 0) {
        finish(new Error("无法读取视频时长或尺寸，请选择有效的视频文件。"));
        return;
      }
      finish(null, { width: video.videoWidth, height: video.videoHeight, duration });
    };
    const handleError = () => finish(new Error("当前环境无法读取该视频格式，请尝试 MP4 或 WebM。"));
    const handleAbort = () => finish(createAbortError());

    if (signal?.aborted) {
      handleAbort();
      return;
    }
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.addEventListener("loadedmetadata", handleMetadata, { once: true });
    video.addEventListener("error", handleError, { once: true });
    signal?.addEventListener("abort", handleAbort, { once: true });
    video.src = url;
  });
}
