import { describe, expect, it } from "vitest";
import { getStripSafeInputError } from "./stripSafeInput";

function webp(...chunks: string[]): Uint8Array {
  const body: number[] = [];
  for (const name of chunks) body.push(...Array.from(name).map((char) => char.charCodeAt(0)), 0, 0, 0, 0);
  return new Uint8Array([82, 73, 70, 70, body.length + 4, 0, 0, 0, 87, 69, 66, 80, ...body]);
}

function png(...chunks: Array<[string, Uint8Array]>): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunks.flatMap(([type, chunk]) => [0, 0, 0, chunk.length, ...Array.from(type).map((char) => char.charCodeAt(0)), ...chunk, 0, 0, 0, 0])]);
}

function jpeg(...bytes: number[]): Uint8Array { return new Uint8Array([0xff, 0xd8, ...bytes]); }

describe("stripSafe input validation", () => {
  it("accepts static WebP only for WebP output", () => {
    expect(getStripSafeInputError(webp("VP8 "), "webp")).toBeNull();
    expect(getStripSafeInputError(webp("VP8 "), "png")).toContain("匹配");
  });

  it("rejects animated, malformed, and unknown inputs", () => {
    expect(getStripSafeInputError(webp("ANIM", "VP8 "), "webp")).toContain("动画");
    expect(getStripSafeInputError(new Uint8Array([1, 2, 3]), "webp")).toContain("匹配");
    expect(getStripSafeInputError(webp("VP8 ", "VP8L"), "webp")).toContain("只能包含一个");
  });

  it("requires PNG and JPEG signatures instead of trusting file names", () => {
    expect(getStripSafeInputError(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "png")).toContain("IEND");
    expect(getStripSafeInputError(new Uint8Array([0xff, 0xd8, 0xff]), "jpg")).toBeNull();
    expect(getStripSafeInputError(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "jpg")).toContain("匹配");
    expect(getStripSafeInputError(new Uint8Array([0xff, 0xd8, 0xff]), "png")).toContain("匹配");
  });

  it("rejects truncated or trailing PNG structure while accepting a minimal sample", () => {
    const ihdr = new Uint8Array(13);
    expect(getStripSafeInputError(png(["IHDR", ihdr], ["IEND", new Uint8Array()]), "png")).toBeNull();
    expect(getStripSafeInputError(png(["IHDR", ihdr], ["IEND", new Uint8Array([1])]), "png")).toContain("IEND");
    expect(getStripSafeInputError(new Uint8Array([...png(["IHDR", ihdr], ["IEND", new Uint8Array()]), 1]), "png")).toContain("尾随");
  });

  it("rejects truncated or trailing JPEG structure while accepting a minimal sample", () => {
    const sample = jpeg(0xff, 0xc0, 0x00, 0x02, 0xff, 0xda, 0x00, 0x02, 0x11, 0xff, 0xd9);
    expect(getStripSafeInputError(sample, "jpg")).toBeNull();
    expect(getStripSafeInputError(sample.slice(0, -1), "jpg")).toContain("完整");
    expect(getStripSafeInputError(jpeg(0xff, 0xc0, 0x00, 0x05, 0x01), "jpg")).toContain("segment");
    expect(getStripSafeInputError(new Uint8Array([...sample, 1]), "jpg")).toContain("尾随");
  });

  it("disables a mixed-format queue for safe cleanup", () => {
    const queue = [webp("VP8 "), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
    expect(queue.every((input) => getStripSafeInputError(input, "webp") === null)).toBe(false);
  });
});
