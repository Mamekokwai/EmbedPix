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
});
