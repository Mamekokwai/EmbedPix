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

function pngError(data: Uint8Array): string | null {
  if (data.length < 8 || !hasPrefix(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "stripSafe PNG 输入缺少有效签名。";
  let offset = 8; let chunks = 0;
  while (offset < data.length) {
    if (data.length - offset < 12) return "stripSafe PNG chunk 不完整。";
    const size = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false);
    if (size > data.length - offset - 12) return "stripSafe PNG chunk 长度无效。";
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    if (chunks === 0 && (type !== "IHDR" || size !== 13)) return "stripSafe PNG 必须以完整 IHDR 开始。";
    offset += 12 + size;
    if (type === "IEND") {
      if (size !== 0 || offset !== data.length) return "stripSafe PNG 必须以完整 IEND 结束且不能有尾随数据。";
      return null;
    }
    chunks += 1;
  }
  return "stripSafe PNG 必须以完整 IEND 结束且不能有尾随数据。";
}

function jpegError(data: Uint8Array): string | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return "stripSafe JPEG 输入缺少有效 SOI。";
  let offset = 2; let scan = false;
  while (offset < data.length) {
    if (!scan) {
      if (data[offset++] !== 0xff) return "stripSafe JPEG marker 边界无效。";
      while (offset < data.length && data[offset] === 0xff) offset += 1;
      if (offset >= data.length) return "stripSafe JPEG marker 不完整。";
      const marker = data[offset++];
      if (marker === 0xda) {
        if (offset + 2 > data.length) return "stripSafe JPEG SOS 长度不完整。";
        const length = (data[offset] << 8) | data[offset + 1];
        if (length < 2 || length > data.length - offset) return "stripSafe JPEG SOS 长度无效。";
        offset += length;
        scan = true;
        continue;
      }
      if (marker === 0xd9) return "stripSafe JPEG 缺少有效扫描数据。";
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return "stripSafe JPEG marker 顺序无效。";
      if (offset + 2 > data.length) return "stripSafe JPEG segment 长度不完整。";
      const length = (data[offset] << 8) | data[offset + 1];
      if (length < 2 || length > data.length - offset) return "stripSafe JPEG segment 长度无效。";
      offset += length;
    } else {
      if (data[offset++] !== 0xff) continue;
      if (offset >= data.length) return "stripSafe JPEG 扫描数据不完整。";
      const marker = data[offset++];
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0xd9) return offset === data.length ? null : "stripSafe JPEG EOI 后存在尾随数据。";
      if (marker === 0xff) { offset -= 1; continue; }
      return "stripSafe JPEG 扫描数据 marker 无效。";
    }
  }
  return scan ? "stripSafe JPEG 缺少 EOI。" : "stripSafe JPEG 缺少 SOS 扫描数据。";
}

export function getStripSafeInputError(inputData: Uint8Array, outputFormat: CompressionFormat): string | null {
  const isPng = hasPrefix(inputData, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const isJpeg = hasPrefix(inputData, [0xff, 0xd8]);
  const isWebp = inputData.length >= 12 && hasPrefix(inputData, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(inputData.subarray(8), [0x57, 0x45, 0x42, 0x50]);
  if (outputFormat === "png" && isPng) return pngError(inputData);
  if (outputFormat === "jpg" && isJpeg) return jpegError(inputData);
  if (outputFormat === "webp" && isWebp) return staticWebpError(inputData);
  return "stripSafe 仅支持输入与输出格式匹配的静态 PNG、JPEG 或 WebP。";
}
