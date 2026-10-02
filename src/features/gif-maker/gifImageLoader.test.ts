import { describe, expect, it, vi } from "vitest";
import { GIF_IMAGE_LOAD_TIMEOUT_MS, loadGifImage } from "./gifImageLoader";

interface FakeImage {
  naturalWidth: number;
  naturalHeight: number;
  onload: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  src: string;
}

function createImage(): FakeImage {
  return { naturalWidth: 320, naturalHeight: 240, onload: null, onerror: null, src: "" };
}

describe("gif image loader", () => {
  it("cleans handlers after a successful image load", async () => {
    const image = createImage();
    const pending = loadGifImage("blob:image", { createImage: () => image as unknown as HTMLImageElement });
    image.onload?.(new Event("load"));
    await expect(pending).resolves.toBe(image);
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
  });

  it("rejects invalid dimensions and source assignment failures", async () => {
    const invalid = createImage();
    invalid.naturalWidth = 0;
    const invalidPending = loadGifImage("blob:invalid", { createImage: () => invalid as unknown as HTMLImageElement });
    invalid.onload?.(new Event("load"));
    await expect(invalidPending).rejects.toThrow("无法读取");

    const failed = createImage();
    Object.defineProperty(failed, "src", { set: () => { throw new Error("assign failed"); } });
    await expect(loadGifImage("blob:failed", { createImage: () => failed as unknown as HTMLImageElement })).rejects.toThrow("assign failed");
  });

  it("times out and clears handlers when decoding never settles", async () => {
    vi.useFakeTimers();
    const image = createImage();
    const pending = loadGifImage("blob:timeout", { createImage: () => image as unknown as HTMLImageElement });
    vi.advanceTimersByTime(GIF_IMAGE_LOAD_TIMEOUT_MS);
    await expect(pending).rejects.toThrow("读取图片超时");
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
    vi.useRealTimers();
  });

  it("aborts immediately and removes the abort listener", async () => {
    const controller = new AbortController();
    const image = createImage();
    const pending = loadGifImage("blob:abort", { createImage: () => image as unknown as HTMLImageElement, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(image.onload).toBeNull();
    expect(image.onerror).toBeNull();
  });
});
