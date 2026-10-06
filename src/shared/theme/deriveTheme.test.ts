import { describe, expect, it } from "vitest";
import { applyThemeColors, deriveTheme } from "./deriveTheme";
import { DARK_COLOR_SCHEMES, LIGHT_COLOR_SCHEMES, getSchemeLabel, getThemePreset, themeSwatches } from "./themePresets";
import type { ColorScheme } from "./themePresets";

const COLOR_TOKENS = [
  "--qp-bg-app", "--qp-bg-canvas", "--qp-bg-panel", "--qp-bg-elevated",
  "--qp-border-subtle", "--qp-border-strong",
  "--qp-text-primary", "--qp-text-secondary", "--qp-text-tertiary", "--qp-text-disabled",
  "--qp-control-off", "--qp-accent-default", "--qp-accent-muted", "--qp-accent-contrast",
  "--qp-success", "--qp-warning", "--qp-danger",
] as const;

describe("theme derivation", () => {
  it("derives the default scheme exactly like patina's defaultControls", () => {
    const light = deriveTheme("light", "default");
    expect(light["--qp-bg-app"]).toBe("#f4f4f4");
    expect(light["--qp-bg-canvas"]).toBe("#fbfbfb");
    expect(light["--qp-text-primary"]).toBe("#171717");
    expect(light["--qp-text-secondary"]).toBe("#434343");
    expect(light["--qp-accent-default"]).toBe("#315f9f");
    expect(light["--qp-accent-muted"]).toBe("#e8eef6");
    expect(light["--qp-text-on-accent"]).toBe("rgb(255, 255, 255)");
    expect(light["--qp-accent-contrast"]).toBe("rgb(255, 255, 255)");
    // 主色已达 4.5:1，按钮底色不再压暗
    expect(light["--qp-button-primary-bg"]).toBe("#315f9f");

    const dark = deriveTheme("dark", "default");
    expect(dark["--qp-bg-app"]).toBe("#212121");
    expect(dark["--qp-bg-canvas"]).toBe("#262626");
    expect(dark["--qp-text-primary"]).toBe("#d1d5dc");
    expect(dark["--qp-accent-default"]).toBe("#8ba1c0");
    // 深色默认主色对白字不达标（≈2.3:1），patina 会把按钮底色压暗到 4.5:1
    expect(dark["--qp-button-primary-bg"]).toMatch(/^#[0-9a-f]{6}$/u);
    expect(dark["--qp-button-primary-bg"]).not.toBe("#8ba1c0");
  });

  it("keeps each preset's own accent and surface", () => {
    expect(deriveTheme("light", "catppuccin")["--qp-accent-default"]).toBe("#8839ef");
    expect(deriveTheme("dark", "catppuccin")["--qp-bg-canvas"]).toBe("#1e1e2e");
    expect(deriveTheme("dark", "nord")["--qp-accent-default"]).toBe("#88c0d0");
    // matrix 的主色太亮，patina 的做法是把按钮底色压暗，文字始终白
    expect(deriveTheme("dark", "matrix")["--qp-button-primary-bg"]).not.toBe("#1eff5a");
    expect(deriveTheme("dark", "matrix")["--qp-accent-contrast"]).toBe("rgb(255, 255, 255)");
  });

  it("covers every selectable scheme with the full color token set", () => {
    for (const variant of ["light", "dark"] as const) {
      const schemes = variant === "dark" ? DARK_COLOR_SCHEMES : LIGHT_COLOR_SCHEMES;
      for (const scheme of schemes) {
        const colors = deriveTheme(variant, scheme);
        for (const token of COLOR_TOKENS) {
          expect(colors[token], `${variant}/${scheme} 缺少 ${token}`).toBeTruthy();
        }
        // 纯色 token 必须是合法色值，派生用的 color-mix 不能混进来
        expect(colors["--qp-bg-canvas"]).toMatch(/^#[0-9a-f]{6}$/u);
        expect(colors["--qp-accent-default"]).toMatch(/^(#[0-9a-f]{6}|rgb\(0, 0, 0\)|rgb\(255, 255, 255\))$/u);
      }
    }
  });

  it("exposes presets, labels and swatches for the picker", () => {
    expect(getThemePreset("light", "default").contrast).toBe(45);
    expect(getThemePreset("dark", "default").contrast).toBe(60);
    expect(LIGHT_COLOR_SCHEMES).toContain("github");
    expect(DARK_COLOR_SCHEMES).toContain("tokyo-night");
    expect(getSchemeLabel("tokyo-night")).toBe("Tokyo Night");
    expect(getSchemeLabel("vscode-plus")).toBe("VS Code Plus");
    expect(getSchemeLabel("default")).toBe("默认");
    expect(getSchemeLabel("gruvbox")).toBe("Gruvbox");
    expect(themeSwatches("light", "github")).toHaveLength(6);
  });

  it("writes the derived tokens onto the theme root", () => {
    const written: Record<string, string> = {};
    const root = { style: { setProperty: (token: string, value: string) => { written[token] = value; } } } as unknown as HTMLElement;
    applyThemeColors("dark", "nord" as ColorScheme, root);
    expect(written["--qp-bg-canvas"]).toBe("#2e3440");
    expect(Object.keys(written)).toEqual(expect.arrayContaining([...COLOR_TOKENS]));
    expect(written["--qp-button-primary-bg"]).toBeTruthy();
    // 圆角 / 动效 / 字体不属于派生范围
    expect(written["--qp-radius-panel"]).toBeUndefined();
  });
});
