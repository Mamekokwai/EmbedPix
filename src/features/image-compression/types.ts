export type CompressionFormat = "jpg" | "webp" | "png";
export type CompressionPreset = "high-quality" | "balanced" | "small-size" | "custom";
export type CompressionOutputLocation = "source" | "subfolder" | "directory";
export type MetadataPolicy = "preserve" | "strip";
export interface CompressionItem { id: string; file: File; sourcePath?: string; size: number; dimensions?: { width: number; height: number }; }
export type CompressionItemResultStatus = "completed" | "skipped" | "failed";
export interface CompressionItemResult { fileName: string; status: CompressionItemResultStatus; outputPath?: string; reason?: string; }
export interface CompressionOptions { format: CompressionFormat; quality: number; webpMethod?: number; lossless: boolean; pngOptimizationLevel: number; metadataPolicy: MetadataPolicy; outputLocation: CompressionOutputLocation; outputFileName?: string; outputSubdirectory?: string; outputDirectory?: string; overwrite: boolean; autoNumbering?: boolean; replaceOriginal?: boolean; skipIfLarger?: boolean; maxOutputBytes?: number; maxCandidates?: number; }
export interface CompressionEstimate { inputBytes: number; estimatedBytes: number; savingsPercent: number; }
