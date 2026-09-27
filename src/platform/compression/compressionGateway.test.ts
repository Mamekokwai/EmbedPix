import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CANCEL_COMPRESSION_COMMAND, COMPRESS_IMAGE_COMMAND, GET_COMPRESSION_PROGRESS_COMMAND, PREFLIGHT_COMPRESSION_COMMAND, PREVIEW_COMPRESSION_COMMAND, cancelCompression, compressImage, encodeCompressionEnvelope, getCompressionProgress, preflightCompression, previewCompression } from "./compressionGateway";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const request = {
  fileName: "icon.png",
  inputData: new Uint8Array([1, 2, 3]),
  outputFormat: "webp" as const,
  outputLocation: "source" as const,
  sourcePath: "C:/icon.png",
  overwriteExisting: false,
  jpegQuality: 82,
  lossless: true,
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
    expect(metadata).toMatchObject({ fileName: "icon.png", outputFormat: "webp", outputLocation: "source", sourcePath: "C:/icon.png", metadataPolicy: "strip" });
  });

  it("passes JPEG target-size candidates through raw metadata", () => {
    const encoded = encodeCompressionEnvelope({ ...request, maxOutputBytes: 64 * 1024, maxCandidates: 8 });
    const metadataLength = new DataView(encoded.buffer).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(encoded.slice(8, 8 + metadataLength))) as Record<string, unknown>;
    expect(metadata).toMatchObject({ maxOutputBytes: 64 * 1024, maxCandidates: 8 });
  });

  it("uses preflight and single-image compression command contracts", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ outputPath: "C:/icon.webp", overwritesExisting: false }).mockResolvedValueOnce({ jobId: "compression-test", outputPath: "C:/icon.webp", status: "completed", skippedReason: null, inputBytes: 3, outputBytes: 2, savedBytes: 1, savingsPercent: 33.3, width: 1, height: 1, format: "webp", lossless: true, targetBytes: null, targetMet: false, selectedQuality: null });
    await preflightCompression(request);
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

  it("does not surface a stale preview after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(previewCompression(request, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps skipped results distinct from completed output", async () => {
    vi.mocked(invoke).mockResolvedValue({ jobId: "compression-test", outputPath: "C:/icon.webp", status: "skipped", skippedReason: "compressed output is larger than the source; output was not published", inputBytes: 3, outputBytes: 5, savedBytes: -2, savingsPercent: -66.7, width: 1, height: 1, format: "webp", lossless: true, targetBytes: null, targetMet: false, selectedQuality: null });
    const result = await compressImage(request);
    expect(result.status).toBe("skipped");
    expect(result.skippedReason).toContain("not published");
    expect(result.outputBytes).toBe(5);
    expect(result.savedBytes).toBe(-2);
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

  it("exposes native progress and cancellation commands", async () => {
    vi.mocked(invoke).mockResolvedValue({ jobId: "compression-test", status: "running", stage: "encoding", outputPath: null, error: null });
    await getCompressionProgress("compression-test");
    await cancelCompression("compression-test");
    expect(invoke).toHaveBeenNthCalledWith(1, GET_COMPRESSION_PROGRESS_COMMAND, { jobId: "compression-test" });
    expect(invoke).toHaveBeenNthCalledWith(2, CANCEL_COMPRESSION_COMMAND, { jobId: "compression-test" });
  });

  it("explains why preview mode cannot execute native compression", async () => {
    setTauriEnvironment(false);
    await expect(compressImage(request)).rejects.toThrow("图片压缩需要桌面应用");
  });
});
