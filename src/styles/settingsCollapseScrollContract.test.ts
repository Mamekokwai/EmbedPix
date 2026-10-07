import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("设置卡片收起滚动闸门契约", () => {
  it("收起卡片先保持自然高度，溢出时才由父级滚动兜底", () => {
    const styles = readFileSync(resolve(__dirname, "features/image-converter.css"), "utf8");
    expect(styles).toMatch(/\.settings-stack\s*\{[^}]*overflow-y:\s*auto;/s);
    expect(styles).toMatch(/\.settings-stack > \.settings-module\s*\{[^}]*flex:\s*0 0 auto;/s);
    expect(styles).toMatch(/\.settings-stack > \.settings-module\[open\]\s*\{\s*display:\s*block;/s);
    expect(styles).toMatch(/\.settings-stack > \.settings-module\[open\] > \.settings-module-body\s*\{[^}]*width:\s*100%;/s);
  });
});
