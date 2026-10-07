import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("输出格式选项网格契约", () => {
  it("宽窗口使用四列，窄窗口逐级降列且不横向溢出", () => {
    const styles = readFileSync(resolve(__dirname, "features/image-converter.css"), "utf8");
    expect(styles).toMatch(/\.format-selector\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/s);
    expect(styles).toContain("grid-auto-rows: minmax(49px, 1fr);");
    expect(styles).toContain("height: 100%;");
    expect(styles).toContain(".format-selector { grid-template-columns: repeat(3, minmax(0, 1fr)); }");
    expect(styles).toContain(".format-selector { grid-template-columns: repeat(2, minmax(0, 1fr)); }");
    expect(styles).toContain("@media (min-height: 800px) and (min-width: 961px)");
    expect(styles).toMatch(/\.format-option\s*\{\s*display:\s*flex;/);
  });
});
