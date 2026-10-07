import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("输出格式卡片同级流契约", () => {
  it("格式卡片保留自然高度，剩余空间只增大自身", () => {
    const styles = readFileSync(resolve(__dirname, "features/image-converter.css"), "utf8");
    expect(styles).toMatch(/\.settings-stack > \.format-group\s*\{[^}]*flex:\s*0 0 auto;[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(styles).toMatch(/\.settings-stack > \.format-group\s*\{\s*flex-grow:\s*1;/s);
    expect(styles).toMatch(/\.settings-stack > \.format-group \.format-selector\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s);
    expect(styles).toContain("container: format-options / inline-size;");
  });
});
