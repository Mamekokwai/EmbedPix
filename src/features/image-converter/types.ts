export type OutputFormat = "bmp" | "png" | "jpg";

export type BmpBitDepth = 1 | 4 | 8 | 16 | 24 | 32;

export interface ExportImageRequest {
  fileName: string;
  inputDataBase64: string;
  outputFormat: OutputFormat;
  width: number;
  height: number;
  keepAspectRatio: boolean;
  bitDepth: BmpBitDepth | null;
  backgroundColor: string;
}

export interface ExportImageResponse {
  outputPath?: string;
}

export interface ImageDimensions {
  width: number;
  height: number;
}
