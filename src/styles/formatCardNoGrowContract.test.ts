import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("输出格式卡片不抢占契约", () => {
  it("收起状态按内容高度排列，不参与剩余空间挤占", () => {
    const styles = readFileSync(resolve(__dirname, "features/image-converter.css"), "utf8");
    expect(styles).toMatch(/\.settings-stack > \.format-group\s*\{[^}]*flex:\s*0 0 auto;/s);
    expect(styles).toMatch(/\.settings-stack > \.format-group \.format-selector\s*\{[^}]*flex:\s*0 0 auto;/s);
  });
});
