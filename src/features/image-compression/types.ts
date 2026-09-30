export type CompressionFormat = "jpg" | "webp" | "png";
export type CompressionPreset = "high-quality" | "balanced" | "small-size" | "custom";
export type CompressionOutputLocation = "source" | "subfolder" | "directory";
export type MetadataPolicy = "preserve" | "strip" | "stripAll" | "stripSafe";
export interface CompressionItem { id: string; file: File; sourcePath?: string; size: number; dimensions?: { width: number; height: number }; }
export type CompressionItemResultStatus = "completed" | "skipped" | "failed";
export interface CompressionQualityMetrics { rgbMae: number; psnrDb: number | null; alphaMismatchPixels: number; }
export interface CompressionItemResult { itemId?: string; fileName: string; status: CompressionItemResultStatus; outputPath?: string; reason?: string; sourceDeleted?: boolean; inputBytes?: number; outputBytes?: number; savedBytes?: number; savingsPercent?: number; candidateSearchMs?: number; candidateCount?: number; qualityMetrics?: CompressionQualityMetrics; }
export interface CompressionOptions { format: CompressionFormat; quality: number; webpMethod?: number; webpAlphaQuality?: number; webpPass?: number; webpNearLossless?: number | null; jpegBackground?: string; lossless: boolean; pngOptimizationLevel: number; metadataPolicy: MetadataPolicy; outputLocation: CompressionOutputLocation; outputFileName?: string; outputSubdirectory?: string; outputDirectory?: string; overwrite: boolean; autoNumbering?: boolean; replaceOriginal?: boolean; deleteSource?: boolean; skipIfLarger?: boolean; maxOutputBytes?: number; maxCandidates?: number; maxInputBytes?: number; }
export interface CompressionEstimate { inputBytes: number; estimatedBytes: number; savingsPercent: number; metadataPolicy?: MetadataPolicy; compressionMode?: "lossless" | "lossy"; compressionEngine?: "oxipng" | "image-jpeg" | "libwebp"; qualityMetrics?: CompressionQualityMetrics; candidateSearchMs?: number; candidateCount?: number; }
