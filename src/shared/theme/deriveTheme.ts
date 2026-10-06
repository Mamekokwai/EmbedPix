// 派生逻辑移植自 patina（`src/shared/theme/deriveTheme.ts`），只保留 EmbedPix tokens.css 里存在的颜色 token：
// 明暗底色、边框、四档文字、主色三态与语义色。patina 的 participation / chart / scrollbar 等 token 本项目没有，不派生。
import { effectiveThemeContrast, getThemePreset, type ColorScheme, type ThemeVariant } from "./themePresets";

type RGB = [number, number, number];
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const parse = (hex: string): RGB => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as RGB;
const mix = (from: RGB, to: RGB, amount: number): RGB => from.map((channel, index) => Math.round(channel + (to[index] - channel) * clamp(amount))) as RGB;
const hex = (rgb: RGB) => `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

function contrastWithWhite(rgb: RGB): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] + 0.05);
}

// 文字压在主色按钮上：主色够暗就用白字，够亮（matrix 那种荧光绿）就翻成黑字。
function accentContrast(accent: string): string {
  return contrastWithWhite(parse(accent)) >= 4.5 ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)";
}

// 对比度是形状参数，不夹取；只有通道混合与 alpha 才夹取。
function shapeContrast(value: number, dark: boolean): number {
  const baseline = dark ? 60 : 45;
  const shaped = value / 100 + (value - baseline) / 60 * 0.7;
  return value <= baseline ? shaped : baseline / 100 + (shaped - baseline / 100) * 2;
}

/** 按方案与明暗派生整套颜色 token；写进根元素即可覆盖 tokens.css 的静态值。 */
export function deriveTheme(variant: ThemeVariant, scheme: ColorScheme, override: number | null = null): Record<string, string> {
  const preset = getThemePreset(variant, scheme);
  const dark = variant === "dark";
  const value = effectiveThemeContrast(variant, scheme, override);
  const contrast = shapeContrast(value, dark);
  const surface = parse(preset.surface);
  const ink = parse(preset.ink);
  const under = hex(mix(surface, dark ? BLACK : ink, dark ? 0.16 + (value - 60) * 0.0015 : 0.04 + (value - 45) * 0.0012));
  const panel = hex(mix(surface, dark ? ink : WHITE, dark ? 0.03 + contrast * 0.03 : 0.18 + contrast * 0.008));

  return {
    "--qp-bg-app": under,
    "--qp-bg-canvas": preset.surface,
    "--qp-bg-panel": panel,
    // 嵌套卡片落在面板之下，浅混一点让层次看得出来。
    "--qp-bg-elevated": hex(mix(dark ? surface : parse(under), parse(panel), dark ? 0.25 : 0.3)),
    "--qp-border-subtle": preset.borderSubtle,
    "--qp-border-strong": preset.borderStrong,
    "--qp-text-primary": preset.ink,
    "--qp-text-secondary": `color-mix(in srgb, ${preset.ink} ${dark ? 78 : 76}%, ${preset.surface})`,
    "--qp-text-tertiary": `color-mix(in srgb, ${preset.ink} 56%, ${preset.surface})`,
    "--qp-text-disabled": `color-mix(in srgb, ${preset.ink} ${dark ? 34 : 38}%, ${preset.surface})`,
    "--qp-control-off": `color-mix(in srgb, ${preset.surface} ${dark ? 62 : 88}%, ${preset.ink})`,
    "--qp-accent-default": preset.accent,
    "--qp-accent-muted": `color-mix(in srgb, ${preset.accent} ${dark ? 20 : 12}%, ${preset.surface})`,
    "--qp-accent-contrast": accentContrast(preset.accent),
    "--qp-success": preset.semanticColors.diffAdded,
    "--qp-warning": dark
      ? `color-mix(in srgb, ${preset.accent} 52%, #d29922)`
      : `color-mix(in srgb, ${preset.accent} 64%, #b58900)`,
    "--qp-danger": preset.semanticColors.diffRemoved,
  };
}

/** 把派生结果写到根元素；只动颜色 token，圆角/动效/字体仍由 tokens.css 决定。 */
export function applyThemeColors(
  variant: ThemeVariant,
  scheme: ColorScheme,
  root: HTMLElement | null = typeof document === "undefined" ? null : document.documentElement,
): void {
  if (!root) return;
  const colors = deriveTheme(variant, scheme);
  for (const [token, value] of Object.entries(colors)) {
    root.style.setProperty(token, value);
  }
}
