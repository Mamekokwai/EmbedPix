export type OutputFormat = "bmp" | "png" | "jpg" | "rgb565" | "c-array";

export type ByteOrder = "little" | "big";
export type ChannelOrder = "rgb" | "bgr";
export type RowOrder = "top-down" | "bottom-up";
export type RowAlignment = 1 | 2 | 4;
export type OutputLocation = "source" | "subfolder" | "directory";

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
  outputLocation?: OutputLocation;
  sourcePath?: string | null;
  outputSubdirectory?: string;
  outputDirectory?: string;
  overwriteExisting?: boolean;
  deleteSource?: boolean;
}

export interface ExportImageResponse {
  outputPath?: string;
}

export interface ImageDimensions {
  width: number;
  height: number;
}
