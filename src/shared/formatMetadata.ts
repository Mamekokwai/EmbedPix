export type SharedFormatId =
  | "bmp"
  | "png"
  | "jpg"
  | "rgb565"
  | "c-array"
  | "gif"
  | "webp"
  | "apng"
  | "png-sequence";

export type SharedFormatCategory = "静态图片" | "嵌入式像素" | "动画输出";

export interface SharedFormatMetadata {
  id: SharedFormatId;
  label: string;
  hint: string;
  description: string;
  category: SharedFormatCategory;
}

export const FORMAT_METADATA: ReadonlyArray<SharedFormatMetadata> = [
  { id: "bmp", label: "BMP", hint: "1–32 位", description: "支持 1、4、8、16、24、32 位；仅 32 位保留透明度。", category: "静态图片" },
  { id: "png", label: "PNG", hint: "24 / 32 位", description: "24 位不含透明度；32 位保留透明度，适合无损资源。", category: "静态图片" },
  { id: "jpg", label: "JPG", hint: "24 位 · 有损", description: "固定 24 位，不支持透明度；透明区域使用背景色。", category: "静态图片" },
  { id: "rgb565", label: "RGB565 BIN", hint: "16 位 · 原始", description: "输出适合 MCU 屏幕的 RGB565 原始二进制数据。", category: "嵌入式像素" },
  { id: "c-array", label: "C 数组", hint: "RGB565 · 源码", description: "输出可直接加入固件工程的 RGB565 C 数组源码。", category: "嵌入式像素" },
  { id: "gif", label: "GIF 动图", hint: "动画 · 兼容", description: "适合通用预览的 GIF 动画输出。", category: "动画输出" },
  { id: "webp", label: "WebP 动图", hint: "动画 · 高压缩", description: "体积较小的 WebP 动画输出。", category: "动画输出" },
  { id: "apng", label: "APNG 动图", hint: "动画 · 无损", description: "保留透明度的无损 APNG 动画输出。", category: "动画输出" },
  { id: "png-sequence", label: "PNG 帧序列", hint: "逐帧 · 无损", description: "按帧输出 PNG 文件序列。", category: "动画输出" },
];

export const IMAGE_OUTPUT_FORMAT_IDS: ReadonlyArray<SharedFormatId> = ["bmp", "png", "jpg", "rgb565", "c-array"];
export const GIF_OUTPUT_FORMAT_IDS: ReadonlyArray<SharedFormatId> = ["gif", "webp", "apng", "png-sequence"];

export function getFormatMetadata(id: SharedFormatId): SharedFormatMetadata {
  return FORMAT_METADATA.find((format) => format.id === id) ?? FORMAT_METADATA[0];
}
