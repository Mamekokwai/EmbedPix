import { describe, expect, it } from "vitest";
import { inspectEmbeddedOutput } from "./embeddedOutputInspector";

const base = {
  outputFormat: "rgb565" as const,
  width: 3,
  height: 2,
  bitDepth: 16 as const,
  byteOrder: "little" as const,
  channelOrder: "rgb" as const,
  rowOrder: "top-down" as const,
  rowAlignment: 4 as const,
};

describe("embedded output inspector", () => {
  it("calculates RGB565 stride, buffer size and stable checksum", () => {
    const result = inspectEmbeddedOutput(base);
    expect(result.pixelBytes).toBe(12);
    expect(result.rowPayloadBytes).toBe(6);
    expect(result.rowStrideBytes).toBe(8);
    expect(result.totalBufferBytes).toBe(16);
    expect(result.crc32).toMatch(/^[0-9A-F]{8}$/);
    expect(result.summary).toContain("rgb565:3x2:16b");
  });

  it("uses C-array as RGB565 while retaining ordering metadata", () => {
    const result = inspectEmbeddedOutput({ ...base, outputFormat: "c-array", width: 5, height: 1, channelOrder: "bgr", byteOrder: "big", rowOrder: "bottom-up", rowAlignment: 2 });
    expect(result.bitDepth).toBe(16);
    expect(result.rowPayloadBytes).toBe(10);
    expect(result.rowStrideBytes).toBe(10);
    expect(result.channelOrder).toBe("bgr");
    expect(result.summary).toContain("bgr:big:bottom-up:align2");
  });

  it("handles packed low-bit rows and aligned rows", () => {
    const result = inspectEmbeddedOutput({ ...base, outputFormat: "bmp", width: 17, height: 3, bitDepth: 1, rowAlignment: 4 });
    expect(result.rowPayloadBytes).toBe(3);
    expect(result.rowStrideBytes).toBe(4);
    expect(result.totalBufferBytes).toBe(12);
  });

  it("rejects invalid and overflowing dimensions", () => {
    expect(() => inspectEmbeddedOutput({ ...base, width: 0 })).toThrow("width");
    expect(() => inspectEmbeddedOutput({ ...base, width: Number.MAX_SAFE_INTEGER, height: 2 })).toThrow("safe integer");
    expect(() => inspectEmbeddedOutput({ ...base, rowAlignment: 3 as never })).toThrow("rowAlignment");
  });
});
