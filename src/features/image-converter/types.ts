export type OutputFormat = "bmp" | "png" | "jpg" | "rgb565" | "c-array";

export type ByteOrder = "little" | "big";
export type ChannelOrder = "rgb" | "bgr";
export type RowOrder = "top-down" | "bottom-up";
export type RowAlignment = 1 | 2 | 4;

export type BmpBitDepth = 1 | 4 | 8 | 16 | 24 | 32;

export interface ExportImageRequest {
  fileName: string;
  inputData: Uint8Array;
  outputFormat: OutputFormat;
  width: number;
  height: number;
  keepAspectRatio: boolean;
  bitDepth: BmpBitDepth | null;
  backgroundColor: string;
  jpegQuality: number;
  byteOrder: ByteOrder;
  channelOrder: ChannelOrder;
  rowOrder: RowOrder;
  rowAlignment: RowAlignment;
  cArrayName: string;
}

export interface ExportImageResponse {
  outputPath?: string;
}

export interface ImageDimensions {
  width: number;
  height: number;
}
