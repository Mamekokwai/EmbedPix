import type { BmpBitDepth, ByteOrder, ChannelOrder, OutputFormat, RowAlignment, RowOrder } from "./types";

export interface EmbeddedOutputInspectionRequest {
  outputFormat: OutputFormat;
  width: number;
  height: number;
  bitDepth: BmpBitDepth;
  byteOrder: ByteOrder;
  channelOrder: ChannelOrder;
  rowOrder: RowOrder;
  rowAlignment: RowAlignment;
}

export interface EmbeddedOutputInspection {
  format: OutputFormat;
  width: number;
  height: number;
  bitDepth: number;
  pixelBytes: number;
  rowPayloadBytes: number;
  rowStrideBytes: number;
  totalBufferBytes: number;
  channelOrder: ChannelOrder;
  byteOrder: ByteOrder;
  rowOrder: RowOrder;
  rowAlignment: RowAlignment;
  summary: string;
  crc32: string;
}

function checkedInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function checkedProduct(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the safe integer limit`);
  return result;
}

function align(value: number, alignment: RowAlignment): number {
  const remainder = value % alignment;
  return remainder === 0 ? value : checkedProduct(Math.ceil(value / alignment), alignment, "row stride");
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function crc32Hex(value: string): string {
  const encoded = new TextEncoder().encode(value);
  return crc32(encoded).toString(16).padStart(8, "0").toUpperCase();
}

export function inspectEmbeddedOutput(request: EmbeddedOutputInspectionRequest): EmbeddedOutputInspection {
  const width = checkedInteger(request.width, "width");
  const height = checkedInteger(request.height, "height");
  const bitDepth = checkedInteger(request.bitDepth, "bitDepth");
  const rowAlignment = request.rowAlignment;
  if (![1, 2, 4].includes(rowAlignment)) throw new Error("rowAlignment must be 1, 2, or 4");

  const effectiveBitDepth = request.outputFormat === "rgb565" || request.outputFormat === "c-array" ? 16 : bitDepth;
  const rowPayloadBytes = effectiveBitDepth < 8
    ? Math.ceil(width * effectiveBitDepth / 8)
    : checkedProduct(width, effectiveBitDepth / 8, "row payload");
  const rowStrideBytes = align(rowPayloadBytes, rowAlignment);
  const totalBufferBytes = checkedProduct(rowStrideBytes, height, "total buffer");
  const pixels = checkedProduct(width, height, "pixel count");
  const pixelBytes = effectiveBitDepth < 8
    ? Math.ceil(pixels * effectiveBitDepth / 8)
    : checkedProduct(pixels, effectiveBitDepth / 8, "pixel bytes");
  const summary = `${request.outputFormat}:${width}x${height}:${effectiveBitDepth}b:${request.channelOrder}:${request.byteOrder}:${request.rowOrder}:align${rowAlignment}:stride${rowStrideBytes}:total${totalBufferBytes}`;

  return {
    format: request.outputFormat,
    width,
    height,
    bitDepth: effectiveBitDepth,
    pixelBytes,
    rowPayloadBytes,
    rowStrideBytes,
    totalBufferBytes,
    channelOrder: request.channelOrder,
    byteOrder: request.byteOrder,
    rowOrder: request.rowOrder,
    rowAlignment,
    summary,
    crc32: crc32Hex(summary),
  };
}
