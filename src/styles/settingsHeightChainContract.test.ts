import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("输出设置高度链契约", () => {
  it("为展开模块和格式网格提供可分配的父级高度", () => {
    const styles = readFileSync(resolve(__dirname, "features/image-converter.css"), "utf8");
    expect(styles).toMatch(/\.settings-stack\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
    expect(styles).toContain(".settings-stack > .format-group {");
    expect(styles).toContain(".settings-stack > .format-group .format-selector {");
    expect(styles).toContain(".settings-stack > .settings-module[open] {");
    expect(styles).toContain(".settings-stack > .settings-module[open] > .settings-module-body {");
  });
});
