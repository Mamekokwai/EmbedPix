import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("输出格式选项网格契约", () => {
  it("格式组根据自身宽度收窄按钮与列数", () => {
    const styles = readFileSync(resolve(__dirname, "features/image-converter.css"), "utf8");
    expect(styles).toMatch(/\.format-selector\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/s);
    expect(styles).toContain("grid-auto-rows: auto;");
    expect(styles).toContain("container: format-options / inline-size;");
    expect(styles).toContain("@container format-options (max-width: 520px)");
    expect(styles).toContain("@container format-options (max-width: 360px)");
    expect(styles).toContain("container: format-option / inline-size;");
    expect(styles).toContain("@container format-option (max-width: 78px)");
    expect(styles).toContain("@container format-options (max-width: 270px)");
    expect(styles).toContain("@container format-options (max-width: 210px)");
    expect(styles).not.toContain("@media (min-height: 800px) and (min-width: 961px)");
    expect(styles).toMatch(/\.format-option\s*\{\s*display:\s*flex;/);
    expect(styles).toContain(".format-option-content { display: flex;");
  });
});
