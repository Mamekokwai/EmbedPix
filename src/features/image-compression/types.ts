export type CompressionFormat = "jpg" | "webp" | "png";
export type CompressionOutputLocation = "source" | "subfolder" | "directory";
export type MetadataPolicy = "preserve" | "strip";
export interface CompressionItem { id: string; file: File; sourcePath?: string; size: number; }
export interface CompressionOptions { format: CompressionFormat; quality: number; lossless: boolean; metadataPolicy: MetadataPolicy; outputLocation: CompressionOutputLocation; outputSubdirectory?: string; outputDirectory?: string; overwrite: boolean; maxOutputBytes?: number; maxCandidates?: number; }
export interface CompressionEstimate { inputBytes: number; estimatedBytes: number; savingsPercent: number; }
