import { describe, expect, it } from "vitest";
import { FORMAT_METADATA, getFormatMetadata, IMAGE_OUTPUT_FORMAT_IDS } from "./formatMetadata";

describe("shared format metadata", () => {
  it("keeps every supported output represented exactly once", () => {
    expect(FORMAT_METADATA.map((format) => format.id)).toEqual([
      "bmp", "png", "jpg", "rgb565", "c-array", "gif", "webp", "tiff", "apng", "png-sequence",
    ]);
    expect(new Set(FORMAT_METADATA.map((format) => format.id)).size).toBe(FORMAT_METADATA.length);
    expect(FORMAT_METADATA.every((format) => format.label && format.description && format.category)).toBe(true);
  });

  it("keeps image converter formats and animation formats distinguishable", () => {
    expect(IMAGE_OUTPUT_FORMAT_IDS).toEqual(["bmp", "png", "jpg", "webp", "tiff", "rgb565", "c-array"]);
    expect(getFormatMetadata("png-sequence").label).toBe("PNG 帧序列");
    expect(getFormatMetadata("webp").category).toBe("动画输出");
  });
});
