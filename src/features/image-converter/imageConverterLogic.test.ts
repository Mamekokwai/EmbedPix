import { describe, expect, it } from "vitest";
import {
  BMP_BIT_DEPTHS,
  MAX_DIMENSION,
  MAX_IMAGE_PIXELS,
  OUTPUT_FORMATS,
  PNG_BIT_DEPTHS,
  SUPPORTED_IMAGE_ACCEPT,
  SUPPORTED_IMAGE_FORMAT_LABEL,
  constrainAspectDimensions,
  constrainDimensions,
  formatFileSize,
  getBackgroundNote,
  getBitDepthNote,
  getBitDepths,
  getDimensionError,
  getEffectiveBitDepth,
  getPixelError,
  isImageFile,
  normalizeDimension,
  parseDimension,
} from "./imageConverterLogic";

describe("image converter dimensions", () => {
  it("accepts only positive integer dimensions within the UI limit", () => {
    expect(parseDimension("1")).toBe(1);
    expect(parseDimension(String(MAX_DIMENSION))).toBe(MAX_DIMENSION);

    for (const value of ["", "0", "-1", "+1", "1.5", " 10", "10 ", "8193", "99999999999999999999"]) {
      expect(parseDimension(value)).toBeNull();
    }
  });

  it("distinguishes empty and invalid dimension messages", () => {
    expect(getDimensionError("", "宽度")).toBe("宽度不能为空。");
    expect(getDimensionError("8193", "高度")).toContain("高度需为 1–8,192");
    expect(getDimensionError("8192", "高度")).toBeNull();
  });

  it("enforces the inclusive total pixel limit", () => {
    expect(getPixelError("4096", "4096")).toBeNull();
    expect(getPixelError("4097", "4096")).toBe(`输出尺寸不能超过 ${MAX_IMAGE_PIXELS.toLocaleString("zh-CN")} 像素。`);
    expect(getPixelError("8193", "1")).toBeNull();
    expect(getPixelError("", "4096")).toBeNull();
  });

  it("normalizes malformed values without exceeding dimension limits", () => {
    expect(normalizeDimension("", 320)).toBe(320);
    expect(normalizeDimension("abc", 320)).toBe(320);
    expect(normalizeDimension("0", 320)).toBe(1);
    expect(normalizeDimension("9000", 320)).toBe(MAX_DIMENSION);
  });

  it("constrains both dimensions and total pixels while preserving proportions", () => {
    expect(constrainDimensions({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
    expect(constrainDimensions({ width: 10000, height: 10000 })).toEqual({ width: 4096, height: 4096 });
    expect(constrainDimensions({ width: 100000, height: 1 })).toEqual({ width: MAX_DIMENSION, height: 1 });
  });

  it("updates the constrained axis and keeps the source aspect ratio", () => {
    expect(constrainAspectDimensions("width", 1920, { width: 16, height: 9 })).toEqual({ width: 1920, height: 1080 });
    expect(constrainAspectDimensions("height", 1080, { width: 16, height: 9 })).toEqual({ width: 1920, height: 1080 });
    expect(constrainAspectDimensions("width", 8192, { width: 4, height: 3 })).toEqual({ width: 4729, height: 3547 });
  });
});

describe("image converter output rules", () => {
  it("exposes the exact supported bit-depth choices", () => {
    expect(getBitDepths("bmp")).toEqual(BMP_BIT_DEPTHS);
    expect(getBitDepths("png")).toEqual(PNG_BIT_DEPTHS);
    expect(getBitDepths("jpg")).toEqual([24]);
    expect(getEffectiveBitDepth("jpg", 32)).toBe(24);
    expect(getEffectiveBitDepth("bmp", 16)).toBe(16);
  });

  it("keeps format descriptions tied to every selectable format", () => {
    expect(OUTPUT_FORMATS.map(({ value }) => value)).toEqual(["bmp", "png", "jpg"]);
    expect(OUTPUT_FORMATS.every(({ description }) => description.length > 0)).toBe(true);
    expect(OUTPUT_FORMATS.find(({ value }) => value === "jpg")?.description).toContain("固定 24 位");
  });

  it("explains transparency and background behavior at the bit-depth boundary", () => {
    expect(getBackgroundNote("bmp", 32)).toContain("源图透明度保留");
    expect(getBackgroundNote("png", 32)).toContain("源图透明度保留");
    expect(getBackgroundNote("bmp", 24)).toBe("透明区域使用此颜色");
    expect(getBackgroundNote("png", 24)).toBe("透明区域使用此颜色");
    expect(getBackgroundNote("jpg", 24)).toBe("透明区域使用此颜色");
    expect(getBitDepthNote("jpg", 32)).toBe("JPG 始终输出 24 位。");
    expect(getBitDepthNote("png", 32)).toBe("32 位输出保留透明度。");
    expect(getBitDepthNote("bmp", 4)).toContain("4 位输出不含透明度");
  });
});

describe("image file and display helpers", () => {
  it("accepts image MIME types and supported filename extensions", () => {
    expect(isImageFile({ type: "image/png", name: "asset.png" })).toBe(true);
    expect(isImageFile({ type: "IMAGE/JPEG", name: "asset.JPG" })).toBe(true);
    expect(isImageFile({ type: "", name: "asset.BMP" })).toBe(true);
    expect(isImageFile({ type: "image/svg+xml", name: "asset.png" })).toBe(false);
    expect(isImageFile({ type: "image/png", name: "asset.bin" })).toBe(false);
    expect(isImageFile({ type: "", name: "asset.tiff" })).toBe(false);
    expect(isImageFile({ type: "text/plain", name: "asset.txt" })).toBe(false);
  });

  it("keeps the picker contract limited to formats the decoder supports", () => {
    expect(SUPPORTED_IMAGE_ACCEPT).toBe(".png,.jpg,.jpeg,.bmp,.gif,.webp,image/png,image/jpeg,image/bmp,image/gif,image/webp");
    expect(SUPPORTED_IMAGE_FORMAT_LABEL).toBe("PNG、JPEG/JPG、BMP、GIF、WEBP");
  });

  it("formats file sizes at byte, kibibyte, and mebibyte boundaries", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
  });
});
