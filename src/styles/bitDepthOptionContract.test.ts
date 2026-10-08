import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("位深选项提示布局契约", () => {
  it("将位深说明放在输出卡片外并允许窄屏换行", () => {
    const view = readFileSync(resolve(__dirname, "../features/image-converter/ImageConverter.tsx"), "utf8");
    const styles = readFileSync(resolve(__dirname, "features/image-converter.css"), "utf8");
    expect(view).toContain("className=\"bit-depth-select-row\"");
    expect(view).toContain("className=\"field-help bit-depth-description-outside\"");
    expect(styles).toMatch(/\.bit-depth-select-row\s*\{\s*display:\s*flex;/);
    expect(styles).toContain("@media (max-width: 620px)");
    expect(styles).toContain(".bit-depth-select-row { flex-wrap: wrap; }");
    expect(styles).toContain(".bit-depth-description-outside { min-width: 0; flex: 1 1 220px;");
  });
});
