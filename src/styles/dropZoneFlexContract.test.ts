import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("图片转换拖拽区布局契约", () => {
  it("在源图片卡片内占用剩余高度而不使用固定撑高", () => {
    const styles = readFileSync(resolve(__dirname, "features/image-converter.css"), "utf8");
    expect(styles).toMatch(/\.drop-zone\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1 1 auto;/s);
    expect(styles).toContain("width: 100%;");
    expect(styles).toContain("box-sizing: border-box;");
    expect(styles).toContain(".drop-zone { min-height: 0; margin-top: 12px; }");
  });
});
