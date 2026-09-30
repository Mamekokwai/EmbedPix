import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CANCEL_COMPRESSION_COMMAND, COMPRESS_IMAGE_COMMAND, ESTIMATE_IMAGE_COMPRESSION_COMMAND, GET_COMPRESSION_PROGRESS_COMMAND, PREFLIGHT_COMPRESSION_COMMAND, PREVIEW_COMPRESSION_COMMAND, cancelCompression, compressImage, createCompressionRequest, encodeCompressionEnvelope, encodeCompressionEstimateEnvelope, estimateImageCompression, formatCompressionProgressError, formatCompressionProgressStage, getCompressionProgress, pickCompressionDirectoryResult, preflightCompression, previewCompression } from "./compressionGateway";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const request = {
  fileName: "icon.png",
  outputFileName: "旅行照片",
  inputData: new Uint8Array([1, 2, 3]),
  outputFormat: "webp" as const,
  outputLocation: "source" as const,
  sourcePath: "C:/icon.png",
  overwriteExisting: false,
  jpegQuality: 82,
  lossless: true,
  skipIfLarger: false,
  pngOptimizationLevel: 2,
  metadataPolicy: "strip" as const,
  jobId: "compression-test",
};

describe("compression gateway", () => {
  const setTauriEnvironment = (enabled: boolean) => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: enabled ? { __TAURI_INTERNALS__: {} } : {} });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setTauriEnvironment(true);
  });

  it("encodes the raw EGF1 envelope expected by native compression commands", () => {
    const encoded = encodeCompressionEnvelope(request);
    expect(Array.from(encoded.slice(0, 4))).toEqual([0x45, 0x47, 0x46, 0x31]);
    const metadataLength = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + metadataLength))) as Record<string, unknown>;
    expect(metadata).toMatchObject({ schemaVersion: 1, fileName: "icon.png", outputFileName: "旅行照片", outputFormat: "webp", outputLocation: "source", sourcePath: "C:/icon.png", metadataPolicy: "strip", pngOptimizationLevel: 2, skipIfLarger: false });
    expect(metadata).not.toHaveProperty("jpegQuality");
  });

  it("passes the shared quality field for lossy WebP without leaking it into lossless WebP", () => {
    const encoded = encodeCompressionEnvelope({ ...request, lossless: false, jpegQuality: 64, webpMethod: 4 });
    const metadataLength = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + metadataLength))) as Record<string, unknown>;
    expect(metadata).toMatchObject({ schemaVersion: 1, outputFormat: "webp", lossless: false, jpegQuality: 64, webpMethod: 4 });
  });

  it("defaults the larger-output guard on when creating a request", () => {
    const file = { path: "C:/icon.png", fileName: "icon.png", data: [1, 2, 3] };
    expect(createCompressionRequest(file, { format: "webp", quality: 82, lossless: true, pngOptimizationLevel: 2, metadataPolicy: "strip", outputLocation: "source", overwrite: false }).skipIfLarger).toBe(true);
    expect(createCompressionRequest(file, { format: "webp", quality: 82, lossless: true, pngOptimizationLevel: 2, metadataPolicy: "strip", outputLocation: "source", overwrite: false, skipIfLarger: false }).skipIfLarger).toBe(false);
  });

  it("validates the optional WebP method at the IPC boundary", () => {
    expect(() => encodeCompressionEnvelope({ ...request, lossless: false, webpMethod: 7 })).toThrow("webpMethod");
    expect(() => encodeCompressionEnvelope({ ...request, webpMethod: 4 })).toThrow("仅支持有损 WebP");
    expect(() => encodeCompressionEnvelope({ ...request, outputFormat: "png", webpMethod: 4 })).toThrow("仅支持有损 WebP");
    expect(() => encodeCompressionEnvelope({ ...request, lossless: false, webpMethod: 0 })).not.toThrow();
    expect(() => encodeCompressionEnvelope({ ...request, lossless: false, webpMethod: 6 })).not.toThrow();
  });

  it("validates and serializes the optional WebP near-lossless level", () => {
    const encoded = encodeCompressionEnvelope({ ...request, webpNearLossless: 90 });
    const metadataLength = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + metadataLength))) as Record<string, unknown>;
    expect(metadata.webpNearLossless).toBe(90);
    expect(() => encodeCompressionEnvelope({ ...request, webpNearLossless: 0 })).toThrow("webpNearLossless");
    expect(() => encodeCompressionEnvelope({ ...request, webpNearLossless: 100 })).toThrow("webpNearLossless");
    expect(() => encodeCompressionEnvelope({ ...request, lossless: false, webpNearLossless: 90 })).toThrow("仅支持无损 WebP");
    expect(() => encodeCompressionEnvelope({ ...request, outputFormat: "png", webpNearLossless: 90 })).toThrow("仅支持无损 WebP");
  });

  it("passes the JPEG transparency background only to JPEG output", () => {
    const encoded = encodeCompressionEnvelope({ ...request, outputFormat: "jpg", lossless: false, jpegBackground: "#123456" });
    const metadataLength = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + metadataLength))) as Record<string, unknown>;
    expect(metadata.jpegBackground).toBe("#123456");
    expect(() => encodeCompressionEnvelope({ ...request, jpegBackground: "white" })).toThrow("jpegBackground");
    expect(() => encodeCompressionEnvelope({ ...request, jpegBackground: "#123456" })).toThrow("JPEG 输出");
  });

  it("normalizes lossless mode by output format when creating requests", () => {
    const file = { path: "C:/icon.png", fileName: "icon.png", data: [1, 2, 3] };
    const base = { quality: 64, pngOptimizationLevel: 2, metadataPolicy: "strip" as const, outputLocation: "source" as const, overwrite: false };
    expect(createCompressionRequest(file, { ...base, format: "webp", lossless: false }).lossless).toBe(false);
    expect(createCompressionRequest(file, { ...base, format: "png", lossless: false }).lossless).toBe(true);
    expect(createCompressionRequest(file, { ...base, format: "jpg", lossless: true }).lossless).toBe(false);
  });

  it("passes an optional custom output filename through the native request", () => {
    const file = { path: "C:/icon.png", fileName: "icon.png", data: [1, 2, 3] };
    const requestWithName = createCompressionRequest(file, { format: "webp", quality: 82, lossless: true, pngOptimizationLevel: 2, metadataPolicy: "strip", outputLocation: "source", outputFileName: "旅行照片.webp", overwrite: false, autoNumbering: true });
    expect(requestWithName.outputFileName).toBe("旅行照片.webp");
    expect(requestWithName.autoSequence).toBe(true);
  });

  it("serializes replaceOriginal only when explicitly enabled", () => {
    const file = { path: "C:/icon.png", fileName: "icon.png", data: [1, 2, 3] };
    const encoded = encodeCompressionEnvelope(createCompressionRequest(file, { format: "webp", quality: 82, lossless: true, pngOptimizationLevel: 2, metadataPolicy: "strip", outputLocation: "source", overwrite: false, replaceOriginal: true }));
    const metadataLength = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + metadataLength))) as Record<string, unknown>;
    expect(metadata.replaceOriginal).toBe(true);
  });

  it("serializes source deletion only when explicitly enabled and rejects unsafe combinations", () => {
    const file = { path: "C:/icon.png", fileName: "icon.png", data: [1, 2, 3] };
    const encoded = encodeCompressionEnvelope(createCompressionRequest(file, { format: "webp", quality: 82, lossless: true, pngOptimizationLevel: 2, metadataPolicy: "strip", outputLocation: "directory", outputDirectory: "C:/export", overwrite: false, deleteSource: true }));
    const metadataLength = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + metadataLength))) as Record<string, unknown>;
    expect(metadata.deleteSource).toBe(true);
    expect(() => encodeCompressionEnvelope({ ...request, deleteSource: true, replaceOriginal: true })).toThrow("删除源文件不能与覆盖原图同时启用");
    expect(() => encodeCompressionEnvelope({ ...request, sourcePath: undefined, outputLocation: "directory", outputDirectory: "C:/export", deleteSource: true })).toThrow("删除源文件需要源文件路径");
  });

  it("serializes auto numbering and rejects conflicting output modes", () => {
    const file = { path: "C:/icon.png", fileName: "icon.png", data: [1, 2, 3] };
    const autoRequest = createCompressionRequest(file, { format: "webp", quality: 82, lossless: true, pngOptimizationLevel: 2, metadataPolicy: "strip", outputLocation: "source", overwrite: false, autoNumbering: true });
    const encoded = encodeCompressionEnvelope(autoRequest);
    const metadataLength = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + metadataLength))) as Record<string, unknown>;
    expect(metadata.autoSequence).toBe(true);
    expect(() => encodeCompressionEnvelope({ ...request, autoSequence: true, overwriteExisting: true })).toThrow("自动序号不能与覆盖同名同时启用");
    expect(() => encodeCompressionEnvelope({ ...request, autoSequence: true, replaceOriginal: true })).toThrow("自动序号不能与覆盖原图同时启用");
  });

  it("keeps WebP lossy target candidates bounded like JPEG", () => {
    const file = { path: "C:/icon.png", fileName: "icon.png", data: [1, 2, 3] };
    const request = createCompressionRequest(file, { format: "webp", quality: 64, lossless: false, pngOptimizationLevel: 2, metadataPolicy: "strip", outputLocation: "source", overwrite: false, maxOutputBytes: 64 * 1024, maxCandidates: 8 });
    expect(request.maxOutputBytes).toBe(64 * 1024);
    expect(request.maxCandidates).toBe(8);
    expect(() => encodeCompressionEnvelope({ ...request, maxCandidates: 0 })).toThrow("maxCandidates");
    expect(() => encodeCompressionEnvelope({ ...request, maxCandidates: 13 })).toThrow("maxCandidates");
  });

  it("serializes and validates lossy WebP alpha quality", () => {
    const encoded = encodeCompressionEnvelope({ ...request, lossless: false, webpAlphaQuality: 64 });
    const metadataLength = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + metadataLength))) as Record<string, unknown>;
    expect(metadata.webpAlphaQuality).toBe(64);
    expect(() => encodeCompressionEnvelope({ ...request, lossless: false, webpAlphaQuality: -1 })).toThrow("webpAlphaQuality");
    expect(() => encodeCompressionEnvelope({ ...request, lossless: false, webpAlphaQuality: 101 })).toThrow("webpAlphaQuality");
    expect(() => encodeCompressionEnvelope({ ...request, webpAlphaQuality: 64 })).toThrow("仅支持有损 WebP");
    expect(() => encodeCompressionEnvelope({ ...request, outputFormat: "png", webpAlphaQuality: 64 })).toThrow("仅支持有损 WebP");
  });

  it("serializes and validates WebP analysis passes", () => {
    const encoded = encodeCompressionEnvelope({ ...request, lossless: false, webpPass: 10 });
    const length = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + length))) as Record<string, unknown>;
    expect(metadata.webpPass).toBe(10);
    expect(() => encodeCompressionEnvelope({ ...request, lossless: false, webpPass: 0 })).toThrow("webpPass");
    expect(() => encodeCompressionEnvelope({ ...request, lossless: false, webpPass: 11 })).toThrow("webpPass");
    expect(() => encodeCompressionEnvelope({ ...request, webpPass: 2 })).toThrow("仅支持有损 WebP");
  });

  it("rejects PNG optimization levels outside the native contract", () => {
    expect(() => encodeCompressionEnvelope({ ...request, pngOptimizationLevel: 7 })).toThrow("pngOptimizationLevel");
  });

  it("rejects invalid JPEG quality and target size before IPC", () => {
    expect(() => encodeCompressionEnvelope({ ...request, jpegQuality: 0 })).toThrow("jpegQuality");
    expect(() => encodeCompressionEnvelope({ ...request, jpegQuality: 101 })).toThrow("jpegQuality");
    expect(() => encodeCompressionEnvelope({ ...request, maxOutputBytes: 0 })).toThrow("maxOutputBytes");
    expect(() => encodeCompressionEnvelope({ ...request, maxOutputBytes: 128 * 1024 * 1024 + 1 })).toThrow("maxOutputBytes");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects oversized input before compression IPC", () => {
    const oversizedInput = new Uint8Array(32 * 1024 * 1024 + 1);
    expect(() => encodeCompressionEnvelope({ ...request, inputData: oversizedInput })).toThrow("32 MiB");
    expect(() => encodeCompressionEstimateEnvelope({
      fileName: "icon.png",
      inputData: oversizedInput,
      outputFormat: "webp",
      jpegQuality: 82,
      lossless: true,
      metadataPolicy: "strip",
      pngOptimizationLevel: 2,
    })).toThrow("32 MiB");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("enforces the configurable single-file input limit for raw and estimate envelopes", () => {
    expect(() => encodeCompressionEnvelope({ ...request, maxInputBytes: 0 })).toThrow("maxInputBytes");
    expect(() => encodeCompressionEnvelope({ ...request, maxInputBytes: 1024 * 1024 - 1 })).toThrow("maxInputBytes");
    expect(() => encodeCompressionEnvelope({ ...request, maxInputBytes: 33 * 1024 * 1024 })).toThrow("maxInputBytes");
    expect(() => encodeCompressionEnvelope({ ...request, maxInputBytes: 32 * 1024 * 1024 + 1 })).toThrow("maxInputBytes");
    expect(() => encodeCompressionEnvelope({ ...request, maxInputBytes: 1024 * 1024 })).not.toThrow();
    expect(() => encodeCompressionEstimateEnvelope({ fileName: "icon.png", inputData: request.inputData, outputFormat: "webp", jpegQuality: 82, lossless: true, metadataPolicy: "strip", pngOptimizationLevel: 2, maxInputBytes: 1024 * 1024 - 1 })).toThrow("maxInputBytes");
    const encoded = encodeCompressionEstimateEnvelope({ fileName: "icon.png", inputData: request.inputData, outputFormat: "webp", jpegQuality: 82, lossless: true, metadataPolicy: "strip", pngOptimizationLevel: 2, maxInputBytes: 32 * 1024 * 1024 });
    const length = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + length))) as Record<string, unknown>;
    expect(metadata.maxInputBytes).toBe(32 * 1024 * 1024);
  });

  it("rejects metadata preservation with a stable user-facing explanation before IPC", () => {
    expect(() => encodeCompressionEnvelope({ ...request, metadataPolicy: "preserve" })).toThrow("第一阶段原生压缩仅支持移除元数据");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("serializes the full metadata cleanup policy while keeping legacy strip compatible", () => {
    const encoded = encodeCompressionEnvelope({ ...request, metadataPolicy: "stripAll" });
    const length = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + length))) as Record<string, unknown>;
    expect(metadata.metadataPolicy).toBe("stripAll");
    expect(() => encodeCompressionEnvelope({ ...request, metadataPolicy: "stripSafe" })).not.toThrow();
  });

  it("serializes PNG alpha optimization only for PNG output", () => {
    const readMetadata = (encoded: Uint8Array) => {
      const length = new DataView(encoded.buffer).getUint32(4, true);
      return JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + length))) as Record<string, unknown>;
    };
    expect(readMetadata(encodeCompressionEnvelope({ ...request, outputFormat: "png", pngOptimizeAlpha: true })).pngOptimizeAlpha).toBe(true);
    expect(readMetadata(encodeCompressionEnvelope({ ...request, outputFormat: "webp", pngOptimizeAlpha: true }))).not.toHaveProperty("pngOptimizeAlpha");
    const estimate = encodeCompressionEstimateEnvelope({ fileName: "icon.png", inputData: request.inputData, outputFormat: "png", jpegQuality: 82, lossless: true, metadataPolicy: "strip", pngOptimizationLevel: 2, pngOptimizeAlpha: true });
    expect(readMetadata(estimate).pngOptimizeAlpha).toBe(true);
  });

  it("allows PNG, JPEG, and WebP stripSafe metadata cleanup", () => {
    const encoded = encodeCompressionEnvelope({ ...request, outputFormat: "png", metadataPolicy: "stripSafe" });
    const length = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + length))) as Record<string, unknown>;
    expect(metadata.metadataPolicy).toBe("stripSafe");
    const webp = encodeCompressionEnvelope({ ...request, outputFormat: "webp", metadataPolicy: "stripSafe" });
    const webpLength = new DataView(webp.buffer).getUint32(4, true);
    expect(JSON.parse(new TextDecoder().decode(webp.slice(8, 8 + webpLength))).metadataPolicy).toBe("stripSafe");
    const jpeg = encodeCompressionEnvelope({ ...request, outputFormat: "jpg", metadataPolicy: "stripSafe" });
    const jpegLength = new DataView(jpeg.buffer).getUint32(4, true);
    expect(JSON.parse(new TextDecoder().decode(jpeg.slice(8, 8 + jpegLength))).metadataPolicy).toBe("stripSafe");
    const estimate = encodeCompressionEstimateEnvelope({ fileName: "icon.png", inputData: request.inputData, outputFormat: "png", jpegQuality: 82, lossless: true, metadataPolicy: "stripSafe", pngOptimizationLevel: 2 });
    const estimateLength = new DataView(estimate.buffer).getUint32(4, true);
    expect(JSON.parse(new TextDecoder().decode(estimate.slice(8, 8 + estimateLength))).metadataPolicy).toBe("stripSafe");
  });

  it("rejects metadata preservation for publish-free estimates before IPC", () => {
    expect(() => encodeCompressionEstimateEnvelope({
      fileName: "icon.png",
      inputData: new Uint8Array([1, 2, 3]),
      outputFormat: "webp",
      jpegQuality: 82,
      lossless: true,
      metadataPolicy: "preserve",
      pngOptimizationLevel: 2,
    })).toThrow("第一阶段原生压缩仅支持移除元数据");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes JPEG target-size candidates through raw metadata", () => {
    const encoded = encodeCompressionEnvelope({ ...request, maxOutputBytes: 64 * 1024, maxCandidates: 8 });
    const metadataLength = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + metadataLength))) as Record<string, unknown>;
    expect(metadata).toMatchObject({ maxOutputBytes: 64 * 1024, maxCandidates: 8 });
  });

  it("does not invent target-size metadata when the UI leaves the control off", () => {
    const encoded = encodeCompressionEnvelope(request);
    const metadataLength = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + metadataLength))) as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("maxOutputBytes");
    expect(metadata).not.toHaveProperty("maxCandidates");
  });

  it("uses preflight and single-image compression command contracts", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ outputPath: "C:/icon.webp", overwritesExisting: false, requiredSpaceBytes: 4096 }).mockResolvedValueOnce({ jobId: "compression-test", outputPath: "C:/icon.webp", status: "completed", skippedReason: null, inputBytes: 3, outputBytes: 2, savedBytes: 1, savingsPercent: 33.3, width: 1, height: 1, format: "webp", lossless: true, compressionMode: "lossless", compressionEngine: "libwebp", targetBytes: null, targetMet: false, selectedQuality: null });
    await expect(preflightCompression(request)).resolves.toMatchObject({ requiredSpaceBytes: 4096 });
    await compressImage(request);
    expect(invoke).toHaveBeenNthCalledWith(1, PREFLIGHT_COMPRESSION_COMMAND, expect.any(Uint8Array));
    expect(invoke).toHaveBeenNthCalledWith(2, COMPRESS_IMAGE_COMMAND, expect.any(Uint8Array));
  });

  it("uses the preview command without changing the raw envelope", async () => {
    vi.mocked(invoke).mockResolvedValue({ data: [1, 2, 3], width: 2, height: 2, format: "webp", outputBytes: 3, lossless: true, status: "completed", skippedReason: null, targetBytes: 65536, targetMet: true, selectedQuality: 74 });
    const controller = new AbortController();
    await expect(previewCompression(request, controller.signal)).resolves.toMatchObject({ format: "webp", outputBytes: 3 });
    expect(invoke).toHaveBeenCalledWith(PREVIEW_COMPRESSION_COMMAND, expect.any(Uint8Array));
  });

  it("encodes a publish-free estimate envelope without output fields", () => {
    const encoded = encodeCompressionEstimateEnvelope({
      fileName: "icon.png",
      inputData: new Uint8Array([1, 2, 3]),
      outputFormat: "webp",
      jpegQuality: 82,
      webpMethod: 6,
      lossless: false,
      metadataPolicy: "strip",
      pngOptimizationLevel: 3,
      maxOutputBytes: 64 * 1024,
      maxCandidates: 4,
    });
    const metadataLength = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + metadataLength))) as Record<string, unknown>;
    expect(metadata).toMatchObject({ schemaVersion: 1, fileName: "icon.png", outputFormat: "webp", lossless: false, pngOptimizationLevel: 3, maxOutputBytes: 64 * 1024, maxCandidates: 4, webpMethod: 6, metadataPolicy: "strip" });
    expect(metadata).not.toHaveProperty("outputPath");
    expect(metadata).not.toHaveProperty("overwriteExisting");
    expect(metadata).not.toHaveProperty("replaceOriginal");
  });

  it("serializes WebP analysis passes once in both raw and estimate metadata", () => {
    const readMetadata = (encoded: Uint8Array) => {
      const metadataLength = new DataView(encoded.buffer).getUint32(4, true);
      return JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + metadataLength))) as Record<string, unknown>;
    };
    const rawMetadata = readMetadata(encodeCompressionEnvelope({ ...request, lossless: false, webpPass: 10 }));
    const estimateMetadata = readMetadata(encodeCompressionEstimateEnvelope({
      fileName: "icon.png",
      inputData: new Uint8Array([1, 2, 3]),
      outputFormat: "webp",
      jpegQuality: 82,
      lossless: false,
      webpPass: 10,
      metadataPolicy: "strip",
      pngOptimizationLevel: 2,
    }));
    expect(rawMetadata.webpPass).toBe(10);
    expect(estimateMetadata.webpPass).toBe(10);
    expect(JSON.stringify(estimateMetadata).match(/"webpPass"/g)).toHaveLength(1);
  });

  it("uses the publish-free image estimate command", async () => {
    vi.mocked(invoke).mockResolvedValue({ inputBytes: 3, outputBytes: 2, savedBytes: 1, savingsPercent: 33.3, width: 1, height: 1, format: "webp", lossless: true, status: "completed", skippedReason: null, targetBytes: null, targetMet: false, selectedQuality: null });
    await expect(estimateImageCompression({ fileName: "icon.png", inputData: new Uint8Array([1, 2, 3]), outputFormat: "webp", jpegQuality: 82, lossless: true, metadataPolicy: "strip", pngOptimizationLevel: 2 })).resolves.toMatchObject({ format: "webp", outputBytes: 2 });
    expect(invoke).toHaveBeenCalledWith(ESTIMATE_IMAGE_COMPRESSION_COMMAND, expect.any(Uint8Array));
  });

  it("does not surface a stale preview after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(previewCompression(request, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cancels an in-flight native preview through its job protocol", async () => {
    let resolvePreview!: (value: unknown) => void;
    const pendingPreview = new Promise<unknown>((resolve) => { resolvePreview = resolve; });
    vi.mocked(invoke).mockImplementation((command) => command === PREVIEW_COMPRESSION_COMMAND
      ? pendingPreview
      : Promise.resolve({ jobId: "compression-preview-test", status: "cancelled", stage: "cancelled", outputPath: null, error: "compression cancelled", code: "cancelled" }));
    const controller = new AbortController();
    const preview = previewCompression({ ...request, jobId: "compression-preview-test" }, controller.signal);
    controller.abort();
    resolvePreview({ data: [1, 2, 3], width: 2, height: 2, format: "webp", outputBytes: 3, lossless: true, status: "completed", skippedReason: null, targetBytes: null, targetMet: false, selectedQuality: null });
    await expect(preview).rejects.toMatchObject({ name: "AbortError" });
    const cancelCall = vi.mocked(invoke).mock.calls.find(([command]) => command === CANCEL_COMPRESSION_COMMAND);
    expect(cancelCall?.[1]).toMatchObject({ jobId: expect.stringMatching(/^compression-preview-test-native-/) });
  });

  it("stops preview cancellation retries after the old preview settles", async () => {
    let resolvePreview!: (value: unknown) => void;
    let cancelAttempts = 0;
    const pendingPreview = new Promise<unknown>((resolve) => { resolvePreview = resolve; });
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === PREVIEW_COMPRESSION_COMMAND) return pendingPreview;
      cancelAttempts += 1;
      return cancelAttempts === 1
        ? Promise.reject(new Error("compression job not found"))
        : Promise.resolve({ jobId: "compression-preview-test", status: "cancelling", stage: "cancelling", outputPath: null, error: null, code: null });
    });
    const controller = new AbortController();
    const preview = previewCompression({ ...request, jobId: "compression-preview-test" }, controller.signal);
    controller.abort();
    resolvePreview({ data: [1, 2, 3], width: 2, height: 2, format: "webp", outputBytes: 3, lossless: true, status: "completed", skippedReason: null, targetBytes: null, targetMet: false, selectedQuality: null });
    await expect(preview).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 30));
    expect(cancelAttempts).toBe(1);
  });

  it("assigns unique native IDs when preview requests reuse an external job ID", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    vi.mocked(invoke).mockImplementation((command) => command === PREVIEW_COMPRESSION_COMMAND
      ? new Promise((resolve) => { resolvers.push(resolve); })
      : Promise.resolve({ jobId: "native", status: "cancelled", stage: "cancelled", outputPath: null, error: null, code: null }));
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = previewCompression({ ...request, jobId: "shared-preview" }, firstController.signal);
    const second = previewCompression({ ...request, jobId: "shared-preview" }, secondController.signal);
    firstController.abort();
    secondController.abort();
    resolvers[0]?.({ data: [1], width: 1, height: 1, format: "webp", outputBytes: 1, lossless: true, status: "completed", skippedReason: null, targetBytes: null, targetMet: false, selectedQuality: null });
    resolvers[1]?.({ data: [1], width: 1, height: 1, format: "webp", outputBytes: 1, lossless: true, status: "completed", skippedReason: null, targetBytes: null, targetMet: false, selectedQuality: null });
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    const previewCalls = vi.mocked(invoke).mock.calls.filter(([command]) => command === PREVIEW_COMPRESSION_COMMAND);
    const nativeIds = previewCalls.map(([, payload]) => {
      const bytes = payload as Uint8Array;
      const length = new DataView(bytes.buffer).getUint32(4, true);
      return (JSON.parse(new TextDecoder().decode(bytes.slice(8, 8 + length))) as { jobId: string }).jobId;
    });
    expect(nativeIds).toHaveLength(2);
    expect(nativeIds[0]).not.toBe(nativeIds[1]);
    const cancelIds = vi.mocked(invoke).mock.calls
      .filter(([command]) => command === CANCEL_COMPRESSION_COMMAND)
      .map(([, args]) => (args as { jobId: string }).jobId);
    expect(cancelIds).toEqual(expect.arrayContaining(nativeIds));
  });

  it("keeps skipped results distinct from completed output", async () => {
    vi.mocked(invoke).mockResolvedValue({ jobId: "compression-test", outputPath: "C:/icon.webp", status: "skipped", skippedReason: "compressed output is larger than the source; output was not published", inputBytes: 3, outputBytes: 5, savedBytes: -2, savingsPercent: -66.7, width: 1, height: 1, format: "webp", lossless: true, targetBytes: null, targetMet: false, selectedQuality: null });
    const result = await compressImage(request);
    expect(result.status).toBe("skipped");
    expect(result.skippedReason).toContain("not published");
    expect(result.outputBytes).toBe(5);
    expect(result.savedBytes).toBe(-2);
  });

  it("keeps optional quality metrics compatible with old and new native results", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ jobId: "compression-test", outputPath: "C:/icon.webp", status: "completed", inputBytes: 3, outputBytes: 2, savedBytes: 1, savingsPercent: 33.3, width: 1, height: 1, format: "webp", lossless: false, targetBytes: null, targetMet: false, selectedQuality: null });
    await expect(compressImage(request)).resolves.toMatchObject({ format: "webp" });
    vi.mocked(invoke).mockResolvedValueOnce({ jobId: "compression-test", outputPath: "C:/icon.webp", status: "completed", inputBytes: 3, outputBytes: 2, savedBytes: 1, savingsPercent: 33.3, width: 1, height: 1, format: "webp", lossless: false, targetBytes: null, targetMet: false, selectedQuality: 82, qualityMetrics: { rgbMae: 0.25, psnrDb: 48.5, alphaMismatchPixels: 3 } });
    await expect(compressImage(request)).resolves.toMatchObject({ qualityMetrics: { rgbMae: 0.25, psnrDb: 48.5, alphaMismatchPixels: 3 } });
  });

  it("retains optional quality metrics on estimate responses", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ inputBytes: 3, outputBytes: 2, savedBytes: 1, savingsPercent: 33.3, width: 1, height: 1, format: "webp", lossless: false, targetBytes: null, targetMet: false, selectedQuality: 82 });
    await expect(estimateImageCompression({ fileName: "icon.png", inputData: new Uint8Array([1, 2, 3]), outputFormat: "webp", jpegQuality: 82, lossless: false, metadataPolicy: "strip", pngOptimizationLevel: 2 })).resolves.toMatchObject({ format: "webp" });
    vi.mocked(invoke).mockResolvedValueOnce({ inputBytes: 3, outputBytes: 2, savedBytes: 1, savingsPercent: 33.3, width: 1, height: 1, format: "webp", lossless: false, targetBytes: null, targetMet: false, selectedQuality: 82, qualityMetrics: { rgbMae: 0.25, psnrDb: null, alphaMismatchPixels: 0 } });
    await expect(estimateImageCompression({ fileName: "icon.png", inputData: new Uint8Array([1, 2, 3]), outputFormat: "webp", jpegQuality: 82, lossless: false, metadataPolicy: "strip", pngOptimizationLevel: 2 })).resolves.toMatchObject({ qualityMetrics: { rgbMae: 0.25, psnrDb: null, alphaMismatchPixels: 0 } });
  });

  it("serializes source subfolder and directory output locations without unsupported fields", () => {
    const subfolder = encodeCompressionEnvelope({ ...request, outputLocation: "subfolder", outputSubdirectory: "compressed" });
    const metadataLength = new DataView(subfolder.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(subfolder.slice(8, 8 + metadataLength))) as Record<string, unknown>;
    expect(metadata).toMatchObject({ outputLocation: "subfolder", outputSubdirectory: "compressed" });
    const directory = encodeCompressionEnvelope({ ...request, outputLocation: "directory", outputDirectory: "C:/export" });
    const directoryLength = new DataView(directory.buffer).getUint32(4, true);
    const directoryMetadata = JSON.parse(new TextDecoder().decode(directory.slice(8, 8 + directoryLength))) as Record<string, unknown>;
    expect(directoryMetadata).toMatchObject({ outputLocation: "directory", outputDirectory: "C:/export" });
  });

  it("keeps per-file directory import skips available to the compression UI", async () => {
    vi.mocked(invoke).mockResolvedValue({ root: "C:/images", files: [], skipped: ["bad.txt：格式不支持"], totalBytes: 0 });
    await expect(pickCompressionDirectoryResult()).resolves.toMatchObject({ skipped: ["bad.txt：格式不支持"] });
  });

  it("exposes native progress and cancellation commands", async () => {
    vi.mocked(invoke).mockResolvedValue({ jobId: "compression-test", status: "running", stage: "encoding", outputPath: null, error: null, code: null, inputBytes: 4096, outputBytes: 1536 });
    await expect(getCompressionProgress("compression-test")).resolves.toMatchObject({ inputBytes: 4096, outputBytes: 1536 });
    await cancelCompression("compression-test");
    expect(invoke).toHaveBeenNthCalledWith(1, GET_COMPRESSION_PROGRESS_COMMAND, { jobId: "compression-test" });
    expect(invoke).toHaveBeenNthCalledWith(2, CANCEL_COMPRESSION_COMMAND, { jobId: "compression-test" });
  });

  it("keeps native progress error codes visible without inventing missing codes", () => {
    expect(formatCompressionProgressError({ error: "failed to decode input image", code: "decode" })).toBe("解码（decode）：failed to decode input image");
    expect(formatCompressionProgressError({ error: "failed to write output", code: "publish" })).toBe("发布/写入（publish）：failed to write output");
    expect(formatCompressionProgressError({ error: "unsupported policy", code: "metadata_policy_unsupported" })).toBe("元数据策略（metadata_policy_unsupported）：unsupported policy");
    expect(formatCompressionProgressError({ error: "failed to encode", code: null })).toBe("failed to encode");
    expect(formatCompressionProgressError({ error: "unknown failure", code: "future_code" })).toBe("[future_code] unknown failure");
    expect(formatCompressionProgressError({ error: null, code: "encode" })).toBeNull();
  });

  it("localizes known progress stages while preserving future stages", () => {
    expect(formatCompressionProgressStage("preflight")).toBe("预检");
    expect(formatCompressionProgressStage("reading")).toBe("读取输入");
    expect(formatCompressionProgressStage("decoding")).toBe("解码");
    expect(formatCompressionProgressStage("planning")).toBe("规划候选");
    expect(formatCompressionProgressStage("validating")).toBe("校验输出");
    expect(formatCompressionProgressStage("publishing")).toBe("发布输出");
    expect(formatCompressionProgressStage("future-stage")).toBe("future-stage");
  });

  it("explains why preview mode cannot execute native compression", async () => {
    setTauriEnvironment(false);
    await expect(compressImage(request)).rejects.toThrow("图片压缩需要桌面应用");
  });
});
