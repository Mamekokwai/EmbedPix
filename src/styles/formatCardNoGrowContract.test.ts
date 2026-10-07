import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("输出格式卡片剩余空间契约", () => {
  it("以自然高度为下限，只占用卡片栈的剩余空间", () => {
    const styles = readFileSync(resolve(__dirname, "features/image-converter.css"), "utf8");
    expect(styles).toMatch(/\.settings-stack > \.format-group\s*\{[^}]*flex:\s*0 0 auto;/s);
    expect(styles).toMatch(/\.settings-stack > \.format-group \.format-selector\s*\{[^}]*flex:\s*0 0 auto;/s);
    expect(styles).toMatch(/\.settings-stack > \.format-group\s*\{\s*flex-grow:\s*1;/s);
    expect(styles).toMatch(/\.settings-stack > \.format-group \.format-selector\s*\{[^}]*max-height:\s*240px;/s);
  });
});
