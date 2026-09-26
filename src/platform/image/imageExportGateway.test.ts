import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  encodeExportEnvelope,
  exportImage,
  MAX_RAW_IMAGE_BYTES,
  MAX_SOURCE_FILE_NAME_BYTES,
  pickOutputDirectory,
  previewImageExport,
  PREVIEW_IMAGE_EXPORT_COMMAND,
  PICK_OUTPUT_DIRECTORY_COMMAND,
  PICK_IMAGE_DIRECTORY_COMMAND,
  PREFLIGHT_IMAGE_EXPORTS_COMMAND,
  preflightImageExports,
  pickImageDirectory,
  revealImageOutput,
  validateExportEnvelopeInput,
} from "./imageExportGateway";
import type { ExportImageRequest } from "../../features/image-converter/types";

function createRequest(inputData: Uint8Array, overrides: Partial<ExportImageRequest> = {}): ExportImageRequest {
  return {
    fileName: "icon.png",
    inputData,
    outputFormat: "bmp",
    width: 320,
    height: 240,
    keepAspectRatio: true,
    backgroundColor: "#FFFFFF",
    bitDepth: 24,
    jpegQuality: 85,
    byteOrder: "little",
    channelOrder: "rgb",
    rowOrder: "top-down",
    rowAlignment: 1,
    cArrayName: "image_data",
    ...overrides,
  };
}

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
});

afterEach(() => vi.unstubAllGlobals());

describe("image export raw IPC envelope", () => {
  it("sends preview requests through the native command without an output path", async () => {
    vi.mocked(invoke).mockResolvedValue({ data: [1, 2], width: 1, height: 1, format: "bmp", bitDepth: 24, outputBytes: 2 });
    await expect(previewImageExport(createRequest(new Uint8Array([1])))).resolves.toMatchObject({ outputBytes: 2 });
    expect(invoke).toHaveBeenCalledWith(PREVIEW_IMAGE_EXPORT_COMMAND, expect.any(Uint8Array));
  });

  it("keeps native dimensions and bit depth for the post-export comparison", async () => {
    vi.mocked(invoke).mockResolvedValue({ outputPath: "E:\\out\\icon.bmp", outputBytes: 4096, width: 128, height: 64, format: "bmp", bitDepth: 24 });
    await expect(exportImage(createRequest(new Uint8Array([1])))).resolves.toMatchObject({ outputPath: "E:\\out\\icon.bmp", outputBytes: 4096, width: 128, height: 64, bitDepth: 24 });
  });

  it("does not turn a native export error into a successful result", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("输出目录不可写"));
    await expect(exportImage(createRequest(new Uint8Array([1])))).rejects.toThrow("输出目录不可写");
  });

  it("reveals a completed image export in its containing folder", async () => {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    vi.mocked(revealItemInDir).mockResolvedValueOnce(undefined);
    await expect(revealImageOutput("E:\\out\\icon.bmp")).resolves.toBeUndefined();
    expect(revealItemInDir).toHaveBeenCalledWith("E:\\out\\icon.bmp");
  });

  it("uses the native preflight command in desktop mode", async () => {
    vi.mocked(invoke).mockResolvedValue({ supported: true, diskSpaceChecked: false, availableBytes: null, diskSpaceSufficient: null, items: [] });
    await preflightImageExports(["E:\\out\\one.png"], 128);
    expect(invoke).toHaveBeenCalledWith(PREFLIGHT_IMAGE_EXPORTS_COMMAND, {
      request: { targetPaths: ["E:\\out\\one.png"], estimatedBytes: 128 },
    });
  });

  it("reports unsupported preflight explicitly outside Tauri", async () => {
    vi.stubGlobal("window", {});
    const result = await preflightImageExports(["/tmp/one.png"]);
    expect(result.supported).toBe(false);
    expect(result.items[0].reason).toContain("不支持文件系统预检");
  });

  it("picks an image directory through the native command", async () => {
    vi.mocked(invoke).mockResolvedValue({ root: "E:\\images", files: [], skipped: ["x.txt：跳过"], totalBytes: 0 });
    await expect(pickImageDirectory()).resolves.toMatchObject({ root: "E:\\images", skipped: ["x.txt：跳过"] });
    expect(invoke).toHaveBeenCalledWith(PICK_IMAGE_DIRECTORY_COMMAND);
  });

  it("reports directory picking as unsupported outside Tauri", async () => {
    vi.stubGlobal("window", {});
    await expect(pickImageDirectory()).rejects.toThrow("不支持选择图片文件夹");
  });

  it("encodes Unicode metadata, a little-endian length, and unchanged image bytes", () => {
    const inputData = new Uint8Array([0, 1, 127, 128, 254, 255]);
    const request = createRequest(inputData, { fileName: "屏幕图标 🚀.png" });
    const payload = encodeExportEnvelope(request);
    const metadataLength = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(4, true);
    const metadataStart = 8;
    const metadataEnd = metadataStart + metadataLength;
    const metadata = JSON.parse(new TextDecoder().decode(payload.subarray(metadataStart, metadataEnd)));

    expect(Array.from(payload.subarray(0, 4))).toEqual([0x45, 0x47, 0x46, 0x31]);
    expect(metadataLength).toBe(new TextEncoder().encode(JSON.stringify(metadata)).byteLength);
    expect(metadata).toEqual({
      fileName: "屏幕图标 🚀.png",
      outputFormat: "bmp",
      width: 320,
      height: 240,
      keepAspectRatio: true,
      backgroundColor: "#FFFFFF",
      bitDepth: 24,
      jpegQuality: 85,
      byteOrder: "little",
      channelOrder: "rgb",
      rowOrder: "top-down",
      rowAlignment: 1,
      cArrayName: "image_data",
    });
    expect(Array.from(payload.subarray(metadataEnd))).toEqual(Array.from(inputData));
    expect(Array.from(inputData)).toEqual([0, 1, 127, 128, 254, 255]);
  });

  it("serializes the embedded display parameters in metadata", () => {
    const payload = encodeExportEnvelope(createRequest(new Uint8Array([9]), {
      outputFormat: "c-array",
      jpegQuality: 67,
      byteOrder: "big",
      channelOrder: "bgr",
      rowOrder: "bottom-up",
      rowAlignment: 4,
      cArrayName: "screen_logo",
    }));
    const metadataLength = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(payload.subarray(8, 8 + metadataLength)));

    expect(metadata).toMatchObject({
      outputFormat: "c-array",
      jpegQuality: 67,
      byteOrder: "big",
      channelOrder: "bgr",
      rowOrder: "bottom-up",
      rowAlignment: 4,
      cArrayName: "screen_logo",
    });
  });

  it("serializes overwriteSameName only when direct same-name replacement is enabled", () => {
    const enabledPayload = encodeExportEnvelope(createRequest(new Uint8Array([9]), {
      overwriteSameName: true,
    }));
    const enabledLength = new DataView(enabledPayload.buffer, enabledPayload.byteOffset, enabledPayload.byteLength).getUint32(4, true);
    const enabledMetadata = JSON.parse(new TextDecoder().decode(enabledPayload.subarray(8, 8 + enabledLength)));
    expect(enabledMetadata.overwriteSameName).toBe(true);

    const disabledPayload = encodeExportEnvelope(createRequest(new Uint8Array([9]), {
      overwriteSameName: false,
    }));
    const disabledLength = new DataView(disabledPayload.buffer, disabledPayload.byteOffset, disabledPayload.byteLength).getUint32(4, true);
    const disabledMetadata = JSON.parse(new TextDecoder().decode(disabledPayload.subarray(8, 8 + disabledLength)));
    expect(disabledMetadata).not.toHaveProperty("overwriteSameName");
    expect(disabledMetadata).not.toHaveProperty("overwriteExisting");
  });

  it("serializes author watermark settings only when text is enabled", () => {
    const enabledPayload = encodeExportEnvelope(createRequest(new Uint8Array([9]), {
      watermarkText: "XUNCHANG WANG · EmbedPix",
      watermarkPosition: "top-left",
      watermarkOpacity: 65,
      watermarkFontSize: 18,
    }));
    const enabledLength = new DataView(enabledPayload.buffer, enabledPayload.byteOffset, enabledPayload.byteLength).getUint32(4, true);
    const enabledMetadata = JSON.parse(new TextDecoder().decode(enabledPayload.subarray(8, 8 + enabledLength)));
    expect(enabledMetadata).toMatchObject({
      watermarkText: "XUNCHANG WANG · EmbedPix",
      watermarkPosition: "top-left",
      watermarkOpacity: 65,
      watermarkFontSize: 18,
    });

    const disabledPayload = encodeExportEnvelope(createRequest(new Uint8Array([9]), {
      watermarkText: "   ",
      watermarkPosition: "top-left",
    }));
    const disabledLength = new DataView(disabledPayload.buffer, disabledPayload.byteOffset, disabledPayload.byteLength).getUint32(4, true);
    const disabledMetadata = JSON.parse(new TextDecoder().decode(disabledPayload.subarray(8, 8 + disabledLength)));
    expect(disabledMetadata).not.toHaveProperty("watermarkText");
    expect(disabledMetadata).not.toHaveProperty("watermarkPosition");
  });

  it("serializes image transform settings for native export", () => {
    const payload = encodeExportEnvelope(createRequest(new Uint8Array([9]), {
      transform: {
        rotation: 90,
        flipHorizontal: true,
        flipVertical: false,
        crop: { x: 2, y: 3, width: 100, height: 80 },
      },
    }));
    const metadataLength = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(4, true);
    const metadata = JSON.parse(new TextDecoder().decode(payload.subarray(8, 8 + metadataLength)));
    expect(metadata.transform).toEqual({
      rotation: 90,
      flipHorizontal: true,
      flipVertical: false,
      crop: { x: 2, y: 3, width: 100, height: 80 },
    });
  });

  it("defaults metadata handling to omission, and serializes explicit cleanup policy", () => {
    const readMetadata = (payload: Uint8Array) => {
      const length = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(4, true);
      return JSON.parse(new TextDecoder().decode(payload.subarray(8, 8 + length)));
    };
    const stripped = readMetadata(encodeExportEnvelope(createRequest(new Uint8Array([1]))));
    const explicit = readMetadata(encodeExportEnvelope(createRequest(new Uint8Array([1]), { metadataPolicy: "strip" })));
    expect(stripped).not.toHaveProperty("metadataPolicy");
    expect(explicit.metadataPolicy).toBe("strip");
  });

  it("rejects empty and oversized image data before allocating an envelope", () => {
    expect(() => validateExportEnvelopeInput(0, "icon.png")).toThrow("图片数据不能为空");
    expect(() => validateExportEnvelopeInput(MAX_RAW_IMAGE_BYTES, "icon.png")).not.toThrow();
    expect(() => validateExportEnvelopeInput(MAX_RAW_IMAGE_BYTES + 1, "icon.png")).toThrow("32 MiB");
  });

  it("validates source file names by UTF-8 bytes and control characters", () => {
    expect(() => validateExportEnvelopeInput(1, "界面图标.png")).not.toThrow();
    expect(() => validateExportEnvelopeInput(1, "x".repeat(MAX_SOURCE_FILE_NAME_BYTES))).not.toThrow();
    expect(() => validateExportEnvelopeInput(1, "界".repeat(MAX_SOURCE_FILE_NAME_BYTES))).toThrow("UTF-8 字节");
    expect(() => validateExportEnvelopeInput(1, "bad\0name.png")).toThrow("控制字符");
  });
});

describe("image output directory picker", () => {
  it("uses the existing desktop directory picker command", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("E:\\导出");

    await expect(pickOutputDirectory()).resolves.toBe("E:\\导出");
    expect(invoke).toHaveBeenCalledWith(PICK_OUTPUT_DIRECTORY_COMMAND);
  });

  it("preserves cancellation as a null result", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);

    await expect(pickOutputDirectory()).resolves.toBeNull();
  });

  it("reports picker failures without changing the caller's existing path", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("权限不足"));

    await expect(pickOutputDirectory()).rejects.toThrow("权限不足");
  });
});
