import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("下拉按钮高度契约", () => {
  it("固定触发按钮的 Y 轴尺寸并保持箭头居中", () => {
    const styles = readFileSync(resolve(__dirname, "theme-select.css"), "utf8");
    expect(styles).toMatch(/\.theme-select-trigger\s*\{[^}]*flex:\s*0 0 36px;[^}]*height:\s*36px;[^}]*min-height:\s*36px;[^}]*max-height:\s*36px;[^}]*box-sizing:\s*border-box;/s);
    expect(styles).toMatch(/\.theme-select-chevron\s*\{[^}]*display:\s*block;[^}]*flex:\s*0 0 auto;/s);
  });
});
