import { Laptop, Moon, RotateCcw, Settings2, Sun } from "lucide-react";
import { OUTPUT_FORMATS } from "../image-converter/imageConverterLogic";
import type { AppPreferences, ThemeMode } from "../../platform/preferences/appPreferences";

interface SettingsViewProps {
  preferences: AppPreferences;
  onChange: (next: Partial<AppPreferences>) => void;
  onReset: () => void;
}

const THEME_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string; hint: string }> = [
  { value: "system", label: "跟随系统", hint: "自动匹配系统明暗色" },
  { value: "light", label: "浅色", hint: "适合明亮环境" },
  { value: "dark", label: "深色", hint: "适合暗光环境" },
];

function ThemeModeIcon({ mode }: { mode: ThemeMode }) {
  if (mode === "light") return <Sun size={16} aria-hidden="true" />;
  if (mode === "dark") return <Moon size={16} aria-hidden="true" />;
  return <Laptop size={16} aria-hidden="true" />;
}

export default function SettingsView({ preferences, onChange, onReset }: SettingsViewProps) {
  return (
    <div className="settings-view page-view">
      <header className="page-header">
        <div className="page-header-icon"><Settings2 size={19} aria-hidden="true" /></div>
        <div>
          <p className="page-eyebrow">PREFERENCES</p>
          <h1>设置</h1>
          <p>调整工作区外观与常用导出参数。</p>
        </div>
      </header>

      <div className="page-content settings-content">
        <section className="settings-card" aria-labelledby="appearance-title">
          <div className="settings-card-header">
            <div>
              <h2 id="appearance-title">外观</h2>
              <p>主题设置只影响本机界面，不会修改图片内容。</p>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <h3>界面主题</h3>
              <p>选择 EmbedPix 的显示方式。</p>
            </div>
            <div className="theme-options" role="radiogroup" aria-label="界面主题">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={preferences.themeMode === option.value}
                  className={`theme-option${preferences.themeMode === option.value ? " theme-option-active" : ""}`}
                  onClick={() => onChange({ themeMode: option.value })}
                  title={option.hint}
                >
                  <ThemeModeIcon mode={option.value} />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="settings-card" aria-labelledby="export-defaults-title">
          <div className="settings-card-header">
            <div>
              <h2 id="export-defaults-title">导出默认值</h2>
              <p>新打开转换页时使用这些参数，单次调整不会覆盖默认值。</p>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <h3>默认输出格式</h3>
              <p>适合嵌入式资源的常用格式也可以直接设为默认。</p>
            </div>
            <select
              className="settings-select"
              value={preferences.defaultOutputFormat}
              aria-label="默认输出格式"
              onChange={(event) => onChange({ defaultOutputFormat: event.target.value as AppPreferences["defaultOutputFormat"] })}
            >
              {OUTPUT_FORMATS.map((format) => <option key={format.value} value={format.value}>{format.label} · {format.hint}</option>)}
            </select>
          </div>
          <div className="settings-row">
            <div>
              <h3>JPEG 默认质量</h3>
              <p>仅在选择 JPG 时生效，范围为 1–100。</p>
            </div>
            <div className="settings-range-control">
              <input
                type="range"
                min="1"
                max="100"
                value={preferences.defaultJpegQuality}
                aria-label="JPEG 默认质量"
                onChange={(event) => onChange({ defaultJpegQuality: Number(event.target.value) })}
              />
              <output>{preferences.defaultJpegQuality}</output>
            </div>
          </div>
          <label className="settings-check-row">
            <input
              type="checkbox"
              checked={preferences.keepAspectRatio}
              onChange={(event) => onChange({ keepAspectRatio: event.target.checked })}
            />
            <span>
              <strong>默认锁定比例</strong>
              <small>调整输出尺寸时保持原图宽高比。</small>
            </span>
          </label>
        </section>

        <div className="settings-actions">
          <button className="quiet-button" type="button" onClick={onReset}>
            <RotateCcw size={15} aria-hidden="true" />恢复默认设置
          </button>
          <span>设置自动保存在本机</span>
        </div>
      </div>
    </div>
  );
}
