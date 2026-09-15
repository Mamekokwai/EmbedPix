import { describe, expect, it } from "vitest";
import {
  encodeExportEnvelope,
  MAX_RAW_IMAGE_BYTES,
  MAX_SOURCE_FILE_NAME_BYTES,
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

describe("image export raw IPC envelope", () => {
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
