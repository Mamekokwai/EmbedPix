import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("主题选择器 tooltip 契约", () => {
  it("不为已显示的当前选项重复生成浏览器 tooltip", () => {
    const source = readFileSync(resolve(__dirname, "ThemeSelect.tsx"), "utf8");
    expect(source).not.toContain("title={selectedLabel}");
    expect(source).toContain("aria-label={ariaLabel}");
  });
});
