import type { CompressionFormat } from "./types";

function hasPrefix(data: Uint8Array, prefix: ReadonlyArray<number>): boolean {
  return prefix.every((value, index) => data[index] === value);
}

function staticWebpError(data: Uint8Array): string | null {
  if (data.length < 12 || !hasPrefix(data, [0x52, 0x49, 0x46, 0x46]) || !hasPrefix(data.subarray(8), [0x57, 0x45, 0x42, 0x50])) return "stripSafe WebP 输入缺少有效 RIFF/WEBP 头。";
  const riffSize = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, true);
  if (riffSize < 4 || riffSize + 8 !== data.length) return "stripSafe WebP RIFF 长度无效。";
  let offset = 12;
  let imageChunks = 0;
  let animated = false;
  let vp8xChunks = 0;
  while (offset < data.length) {
    if (data.length - offset < 8) return "stripSafe WebP chunk 头不完整。";
    const size = new DataView(data.buffer, data.byteOffset + offset + 4, 4).getUint32(0, true);
    const paddedSize = size + (size & 1);
    if (paddedSize < size || offset + 8 > data.length || paddedSize > data.length - offset - 8) return "stripSafe WebP chunk 长度无效。";
    const fourcc = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
    if ((size & 1) !== 0 && data[offset + 8 + size] !== 0) return "stripSafe WebP chunk padding 无效。";
    if (fourcc === "ANIM" || fourcc === "ANMF") animated = true;
    if (fourcc === "VP8 " || fourcc === "VP8L") imageChunks += 1;
    if (fourcc === "VP8X") { vp8xChunks += 1; if (size > 0 && (data[offset + 8] & 0x02) !== 0) animated = true; }
    offset += 8 + paddedSize;
  }
  if (offset !== data.length) return "stripSafe WebP chunk 边界无效。";
  if (animated) return "stripSafe 不支持动画 WebP，请使用静态 WebP。";
  if (vp8xChunks > 1) return "stripSafe WebP 不允许重复 VP8X chunk。";
  if (imageChunks !== 1) return "stripSafe WebP 必须包含且只能包含一个图像 chunk。";
  return null;
}

export function getStripSafeInputError(inputData: Uint8Array, outputFormat: CompressionFormat): string | null {
  const isPng = hasPrefix(inputData, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const isJpeg = hasPrefix(inputData, [0xff, 0xd8]);
  const isWebp = inputData.length >= 12 && hasPrefix(inputData, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(inputData.subarray(8), [0x57, 0x45, 0x42, 0x50]);
  if (outputFormat === "png" && isPng) return null;
  if (outputFormat === "jpg" && isJpeg) return null;
  if (outputFormat === "webp" && isWebp) return staticWebpError(inputData);
  return "stripSafe 仅支持输入与输出格式匹配的静态 PNG、JPEG 或 WebP。";
}
