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
    const release = () => {
      if (!released) {
        released = true;
        dependencies.revokeObjectURL(objectUrl);
      }
    };
    image.onload = () => {
      try {
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      } catch (error) {
        reject(error);
      } finally {
        release();
      }
    };
    image.onerror = () => {
      release();
      reject(new Error("无法读取这张图片，请选择有效的图片文件。"));
    };
    try {
      image.src = objectUrl;
    } catch (error) {
      release();
      reject(error);
    }
  });
}
