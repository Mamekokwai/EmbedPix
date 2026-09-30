import { describe, expect, it } from "vitest";
import { getStripSafeInputError } from "./stripSafeInput";

function webp(...chunks: string[]): Uint8Array {
  const body: number[] = [];
  for (const name of chunks) body.push(...Array.from(name).map((char) => char.charCodeAt(0)), 0, 0, 0, 0);
  return new Uint8Array([82, 73, 70, 70, body.length + 4, 0, 0, 0, 87, 69, 66, 80, ...body]);
}

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
    expect(getStripSafeInputError(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "png")).toBeNull();
    expect(getStripSafeInputError(new Uint8Array([0xff, 0xd8, 0xff]), "jpg")).toBeNull();
    expect(getStripSafeInputError(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "jpg")).toContain("匹配");
    expect(getStripSafeInputError(new Uint8Array([0xff, 0xd8, 0xff]), "png")).toContain("匹配");
  });


  it("disables a mixed-format queue for safe cleanup", () => {
    const queue = [webp("VP8 "), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
    expect(queue.every((input) => getStripSafeInputError(input, "webp") === null)).toBe(false);
  });
});
