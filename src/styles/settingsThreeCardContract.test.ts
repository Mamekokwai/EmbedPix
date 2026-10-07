import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("输出设置三卡片挤占契约", () => {
  it("格式、画面参数、输出处理三张卡片共享可收缩轨道", () => {
    const styles = readFileSync(resolve(__dirname, "features/image-converter.css"), "utf8");
    expect(styles).toMatch(/\.settings-stack > \.format-group\s*\{[^}]*flex:\s*1 1 0;[^}]*min-width:\s*0;[^}]*min-height:\s*0;/s);
    expect(styles).toMatch(/\.settings-stack > \.settings-module\s*\{[^}]*flex:\s*0 1 auto;[^}]*min-width:\s*0;[^}]*min-height:\s*0;/s);
    expect(styles).toMatch(/\.settings-stack > \.settings-module\[open\]\s*\{[^}]*flex:\s*1 1 0;/s);
    expect(styles).toMatch(/\.settings-stack > \.settings-module\[open\] > \.settings-module-body\s*\{[^}]*min-height:\s*0;[^}]*min-width:\s*0;[^}]*overflow-y:\s*auto;[^}]*overflow-x:\s*hidden;/s);
    expect(styles).toContain("container: settings-module / size;");
  });
});
