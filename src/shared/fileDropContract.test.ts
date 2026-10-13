import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n?/g, "\n");
const dropHook = read("./useFileDrop.ts");
const converter = read("../features/image-converter/ImageConverter.tsx");
const compression = read("../features/image-compression/ImageCompressionView.tsx");
const gif = read("../features/gif-maker/GifMakerView.tsx");

describe("shared file drop boundary", () => {
  it("accepts file drags including folders and multiple files without accepting internal drags", () => {
    expect(dropHook).toContain('types).includes("Files")');
    expect(dropHook).toContain('dropEffect = "copy"');
    expect(dropHook).toContain("Array.from(event.dataTransfer.files)");
    expect(dropHook).toContain("event.stopPropagation()");
  });

  it("uses the same drop contract on converter, compression, and GIF pages", () => {
    for (const source of [converter, compression, gif]) {
      expect(source).toContain('from "../../shared/useFileDrop"');
      expect(source).toContain("fileDrop.onDragEnter");
      expect(source).toContain("fileDrop.onDragOver");
      expect(source).toContain("fileDrop.onDragLeave");
      expect(source).toContain("fileDrop.onDrop");
    }
  });

  it("keeps converter preview images and compression preview images from becoming drop sources", () => {
    expect(converter).toContain("onDrop={fileDrop.onDrop}");
    expect(compression).toContain("onDragStart={(event) => event.preventDefault()}");
    expect(compression).toContain("draggable={false}");
  });
});
