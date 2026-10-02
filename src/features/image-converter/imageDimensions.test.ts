import { describe, expect, it, vi } from "vitest";
import { readImageDimensions, type ImageDimensionImage } from "./imageDimensions";

function setup() {
  let image: ImageDimensionImage = { naturalWidth: 320, naturalHeight: 240, onload: null, onerror: null, src: "" };
  const revokeObjectURL = vi.fn();
  const dependencies = {
    createImage: () => image,
    createObjectURL: () => "blob:image",
    revokeObjectURL,
  };
  return { dependencies, revokeObjectURL, get image() { return image; }, set image(value: ImageDimensionImage) { image = value; } };
}

describe("image dimension lifecycle", () => {
  it("reads dimensions and revokes the object URL after load", async () => {
    const state = setup();
    const pending = readImageDimensions(new Blob(["image"]), state.dependencies);
    state.image.onload?.(new Event("load"));

    await expect(pending).resolves.toEqual({ width: 320, height: 240 });
    expect(state.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("revokes the object URL after decode failure", async () => {
    const state = setup();
    const pending = readImageDimensions(new Blob(["image"]), state.dependencies);
    state.image.onerror?.(new Event("error"));

    await expect(pending).rejects.toThrow("无法读取这张图片");
    expect(state.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("revokes the object URL when source assignment fails", async () => {
    const state = setup();
    Object.defineProperty(state.image, "src", { set: () => { throw new Error("source assignment failed"); } });

    await expect(readImageDimensions(new Blob(["image"]), state.dependencies)).rejects.toThrow("source assignment failed");
    expect(state.revokeObjectURL).toHaveBeenCalledOnce();
  });
});
