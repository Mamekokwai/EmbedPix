export const IMAGE_DIMENSIONS_TIMEOUT_MS = 15_000;

export interface ImageDimensionImage {
  naturalWidth: number;
  naturalHeight: number;
  onload: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  src: string;
}

export interface ImageDimensionDependencies {
  createImage?: () => ImageDimensionImage;
  createObjectURL?: (file: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  signal?: AbortSignal;
}

export function readImageDimensions(
  file: Blob,
  dependencies: ImageDimensionDependencies = {},
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const createImage = dependencies.createImage ?? (() => new Image());
    const createObjectURL = dependencies.createObjectURL ?? ((value: Blob) => URL.createObjectURL(value));
    const revokeObjectURL = dependencies.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
    const image = createImage();
    const objectUrl = createObjectURL(file);
    let released = false;
    let settled = false;
    const release = () => {
      if (!released) {
        released = true;
        revokeObjectURL(objectUrl);
      }
    };
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
      dependencies.signal?.removeEventListener("abort", abort);
      release();
    };
    const finish = (error: Error | null, dimensions?: { width: number; height: number }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(dimensions!);
    };
    const timeout = globalThis.setTimeout(() => finish(new Error("读取图片尺寸超时，请检查文件或更换图片。")), IMAGE_DIMENSIONS_TIMEOUT_MS);
    const abort = () => {
      const error = new Error("图片尺寸读取已取消。");
      error.name = "AbortError";
      finish(error);
    };
    image.onload = () => {
      try {
        finish(null, { width: image.naturalWidth, height: image.naturalHeight });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    image.onerror = () => finish(new Error("无法读取这张图片，请选择有效的图片文件。"));
    if (dependencies.signal?.aborted) {
      abort();
      return;
    }
    dependencies.signal?.addEventListener("abort", abort, { once: true });
    try {
      image.src = objectUrl;
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
