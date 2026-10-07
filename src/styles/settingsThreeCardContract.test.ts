import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("输出设置三卡片挤占契约", () => {
  it("格式与展开的参数卡片保持自然高度，由设置体统一滚动", () => {
    const styles = readFileSync(resolve(__dirname, "features/image-converter.css"), "utf8");
    const view = readFileSync(resolve(__dirname, "../features/image-converter/ImageConverter.tsx"), "utf8");
    // 外层 fieldset 与 size containment 曾把内容压成零高，展开后控件覆盖下一张卡片。
    expect(view).toContain('<div className="settings-stack"');
    expect(view).not.toContain('<fieldset className="settings-stack"');
    expect(styles).toMatch(/\.settings-stack > \.format-group\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-width:\s*0;[^}]*min-height:\s*0;/s);
    expect(styles).toMatch(/\.settings-stack > \.settings-module\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-width:\s*0;[^}]*min-height:\s*0;/s);
    expect(styles).toMatch(/\.settings-stack > \.settings-module\[open\]\s*\{\s*display:\s*block;/s);
    expect(styles).toMatch(/\.settings-stack\s*\{[^}]*overflow-y:\s*auto;/s);
    expect(styles).toContain("container: settings-module / inline-size;");
    expect(styles).toContain("container: format-options / inline-size;");
  });
});
