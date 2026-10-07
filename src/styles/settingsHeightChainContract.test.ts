import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("输出设置高度链契约", () => {
  it("格式卡片利用空余高度，展开模块仍按内容撑开", () => {
    const styles = readFileSync(resolve(__dirname, "features/image-converter.css"), "utf8");
    expect(styles).toMatch(/\.settings-stack\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    expect(styles).toContain(".settings-stack > .format-group {");
    expect(styles).toContain(".settings-stack > .format-group .format-selector {");
    expect(styles).toContain(".settings-stack > .settings-module[open] {");
    expect(styles).toMatch(/\.settings-stack > \.format-group\s*\{\s*flex-grow:\s*1;/s);
    expect(styles).toMatch(/\.settings-stack > \.settings-module\s*\{[^}]*flex:\s*0 0 auto;/s);
    expect(styles).toContain(".settings-stack > .settings-module[open] > .settings-module-body {");
    expect(styles).toContain("container: settings-module / inline-size;");
    expect(styles).toContain("overflow-y: auto;");
  });
});
