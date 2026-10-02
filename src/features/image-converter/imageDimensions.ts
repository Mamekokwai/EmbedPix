export const IMAGE_DIMENSIONS_TIMEOUT_MS = 15_000;

export interface ImageDimensionImage {
  naturalWidth: number;
  naturalHeight: number;
  onload: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  src: string;
}

export interface ImageDimensionDependencies {
  createImage: () => ImageDimensionImage;
  createObjectURL: (file: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

const DEFAULT_DEPENDENCIES: ImageDimensionDependencies = {
  createImage: () => new Image(),
  createObjectURL: (file) => URL.createObjectURL(file),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};

export function readImageDimensions(
  file: Blob,
  dependencies: ImageDimensionDependencies = DEFAULT_DEPENDENCIES,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = dependencies.createImage();
    const objectUrl = dependencies.createObjectURL(file);
    let released = false;
    let settled = false;
    const release = () => {
      if (!released) {
        released = true;
        dependencies.revokeObjectURL(objectUrl);
      }
    };
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      image.onload = null;
      image.onerror = null;
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
    image.onload = () => {
      try {
        finish(null, { width: image.naturalWidth, height: image.naturalHeight });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    image.onerror = () => finish(new Error("无法读取这张图片，请选择有效的图片文件。"));
    try {
      image.src = objectUrl;
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
