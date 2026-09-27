export type CompressionFormat = "jpg" | "webp" | "png";
export type MetadataPolicy = "preserve" | "strip";
export interface CompressionItem { id: string; file: File; sourcePath?: string; size: number; }
export interface CompressionOptions { format: CompressionFormat; quality: number; lossless: boolean; metadataPolicy: MetadataPolicy; outputDirectory?: string; overwrite: boolean; }
export interface CompressionEstimate { inputBytes: number; estimatedBytes: number; savingsPercent: number; }
