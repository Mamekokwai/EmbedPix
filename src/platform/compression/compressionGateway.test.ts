import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CANCEL_COMPRESSION_COMMAND, COMPRESS_IMAGE_COMMAND, GET_COMPRESSION_PROGRESS_COMMAND, PREFLIGHT_COMPRESSION_COMMAND, cancelCompression, compressImage, encodeCompressionEnvelope, getCompressionProgress, preflightCompression } from "./compressionGateway";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const request = {
  fileName: "icon.png",
  inputData: new Uint8Array([1, 2, 3]),
  outputFormat: "webp" as const,
  sourcePath: "C:/icon.png",
  overwriteExisting: false,
  jpegQuality: 82,
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

  it("uses preflight and single-image compression command contracts", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ outputPath: "C:/icon.webp", overwritesExisting: false }).mockResolvedValueOnce({ jobId: "compression-test", outputPath: "C:/icon.webp" });
    await preflightCompression(request);
    await compressImage(request);
    expect(invoke).toHaveBeenNthCalledWith(1, PREFLIGHT_COMPRESSION_COMMAND, expect.any(Uint8Array));
    expect(invoke).toHaveBeenNthCalledWith(2, COMPRESS_IMAGE_COMMAND, expect.any(Uint8Array));
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
