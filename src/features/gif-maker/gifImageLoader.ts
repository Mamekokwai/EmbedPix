export const GIF_IMAGE_LOAD_TIMEOUT_MS = 15_000;

export interface GifImageLoaderDependencies {
  createImage?: () => HTMLImageElement;
  signal?: AbortSignal;
}

type GifImageLoaderImage = HTMLImageElement;

export function loadGifImage(
  url: string,
  dependencies: GifImageLoaderDependencies = {},
): Promise<GifImageLoaderImage> {
  return new Promise((resolve, reject) => {
    const createImage = dependencies.createImage ?? (() => new Image());
    const image = createImage();
    let settled = false;
    let timeout: ReturnType<typeof globalThis.setTimeout>;
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      dependencies.signal?.removeEventListener("abort", abort);
    };
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(image);
    };
    timeout = globalThis.setTimeout(() => finish(new Error("读取图片超时，请检查文件或更换图片。")), GIF_IMAGE_LOAD_TIMEOUT_MS);
    const abort = () => {
      const error = new Error("图片读取已取消。");
      error.name = "AbortError";
      finish(error);
    };
    image.onload = () => {
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        finish(new Error("无法读取这张图片，请选择有效的图片文件。"));
        return;
      }
      finish(null);
    };
    image.onerror = () => finish(new Error("无法读取这张图片，请选择有效的图片文件。"));
    if (dependencies.signal?.aborted) {
      abort();
      return;
    }
    dependencies.signal?.addEventListener("abort", abort, { once: true });
    try {
      image.src = url;
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
