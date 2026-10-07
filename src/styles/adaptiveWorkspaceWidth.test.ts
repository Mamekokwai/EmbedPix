import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesRoot = resolve(__dirname);

describe("自适应工作区宽度契约", () => {
  it("让三个工作台铺满主区，同时保留窄窗口最小宽度", () => {
    const shell = readFileSync(resolve(stylesRoot, "app-shell.css"), "utf8");
    const converter = readFileSync(resolve(stylesRoot, "features/image-converter.css"), "utf8");
    const compression = readFileSync(resolve(stylesRoot, "features/image-compression.css"), "utf8");
    const gif = readFileSync(resolve(stylesRoot, "features/gif-maker.css"), "utf8");

    expect(shell).toContain("width: 100%; max-width: none; min-width: 720px;");
    for (const source of [converter, compression, gif]) {
      expect(source).toContain("width: 100%;");
      expect(source).toContain("max-width: none;");
    }
  });
});
