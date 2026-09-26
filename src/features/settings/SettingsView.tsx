import { Laptop, Moon, RotateCcw, Settings2, Sun } from "lucide-react";
import { useState } from "react";
import { getBitDepths, OUTPUT_FORMATS } from "../image-converter/imageConverterLogic";
import type { BmpBitDepth, ByteOrder, ChannelOrder, RowAlignment, RowOrder } from "../image-converter/types";
import {
  IMAGE_PRESETS,
  IMAGE_PRESET_OPTIONS,
  type AppPreferences,
  type ImagePresetId,
  type ThemeMode,
} from "../../platform/preferences/appPreferences";
import ThemeSelect from "../../shared/components/ThemeSelect";
import { createImageCustomPreset, loadImageCustomPresets, saveImageCustomPresets, type ImageCustomPreset } from "../image-converter/imagePresets";

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

const BYTE_ORDER_OPTIONS: ReadonlyArray<{ value: ByteOrder; label: string }> = [
  { value: "little", label: "小端" },
  { value: "big", label: "大端" },
];

const CHANNEL_ORDER_OPTIONS: ReadonlyArray<{ value: ChannelOrder; label: string }> = [
  { value: "rgb", label: "RGB" },
  { value: "bgr", label: "BGR" },
];

const ROW_ORDER_OPTIONS: ReadonlyArray<{ value: RowOrder; label: string }> = [
  { value: "top-down", label: "从上到下" },
  { value: "bottom-up", label: "从下到上" },
];

const ROW_ALIGNMENT_OPTIONS: ReadonlyArray<{ value: RowAlignment; label: string }> = [
  { value: 1, label: "1 字节" },
  { value: 2, label: "2 字节" },
  { value: 4, label: "4 字节" },
];

function presetLabel(preset: ImagePresetId): string {
  return IMAGE_PRESET_OPTIONS.find((option) => option.value === preset)?.label ?? "自定义";
}

export default function SettingsView({ preferences, onChange, onReset }: SettingsViewProps) {
  const [customPresets, setCustomPresets] = useState<ImageCustomPreset[]>(() => loadImageCustomPresets());
  const [customPresetId, setCustomPresetId] = useState("");
  const [customPresetName, setCustomPresetName] = useState("");
  const updateConverterDefaults = (next: Partial<AppPreferences>) => {
    onChange({ ...next, imagePreset: "custom" });
  };

  const applyPreset = (value: ImagePresetId) => {
    if (value === "custom") {
      onChange({ imagePreset: value });
      return;
    }
    if (value === preferences.imagePreset) return;
    const preset = IMAGE_PRESETS[value];
    if (!window.confirm(`切换到“${presetLabel(value)}”会覆盖图片转换默认格式、JPEG 质量、位深、RAW 参数、背景色和比例设置。是否继续？`)) {
      return;
    }
    onChange({ ...preset, imagePreset: value });
  };

  const handleDefaultOutputFormat = (value: string | number) => {
    const nextFormat = value as AppPreferences["defaultOutputFormat"];
    const availableBitDepths = getBitDepths(nextFormat);
    const nextBitDepth = availableBitDepths.includes(preferences.defaultBitDepth)
      ? preferences.defaultBitDepth
      : availableBitDepths[0] ?? 24;
    updateConverterDefaults({ defaultOutputFormat: nextFormat, defaultBitDepth: nextBitDepth });
  };

  const saveCustomPreset = () => {
    const name = customPresetName.trim();
    if (!name) return;
    const next = [...customPresets, createImageCustomPreset(name, preferences)];
    setCustomPresets(next);
    saveImageCustomPresets(next);
    setCustomPresetName("");
  };

  const applyCustomPreset = (id: string) => {
    setCustomPresetId(id);
    const preset = customPresets.find((item) => item.id === id);
    if (preset) onChange({ ...preset.values, imagePreset: "custom" });
  };

  const deleteCustomPreset = () => {
    const next = customPresets.filter((item) => item.id !== customPresetId);
    setCustomPresets(next);
    saveImageCustomPresets(next);
    setCustomPresetId("");
  };

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
            <ThemeSelect
              id="default-output-format"
              className="settings-select"
              value={preferences.defaultOutputFormat}
              options={OUTPUT_FORMATS.map((format) => ({ value: format.value, label: `${format.label} · ${format.hint}` }))}
              aria-label="默认输出格式"
              onChange={handleDefaultOutputFormat}
            />
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
                onChange={(event) => updateConverterDefaults({ defaultJpegQuality: Number(event.target.value) })}
              />
              <output>{preferences.defaultJpegQuality}</output>
            </div>
          </div>
          <label className="settings-check-row">
            <input
              type="checkbox"
              checked={preferences.keepAspectRatio}
              onChange={(event) => updateConverterDefaults({ keepAspectRatio: event.target.checked })}
            />
            <span>
              <strong>默认锁定比例</strong>
              <small>调整输出尺寸时保持原图宽高比。</small>
            </span>
          </label>
        </section>

        <section className="settings-card" aria-labelledby="converter-preset-title">
          <div className="settings-card-header">
            <div>
              <h2 id="converter-preset-title">图片转换预设</h2>
              <p>预设会覆盖图片转换的默认格式、质量、位深、RAW 参数、背景色和比例设置；单独修改任一项后会变为自定义。</p>
            </div>
          </div>
          <div className="settings-row settings-preset-row">
            <div>
              <h3>当前预设：{presetLabel(preferences.imagePreset)}</h3>
              <p>{IMAGE_PRESET_OPTIONS.find((option) => option.value === preferences.imagePreset)?.description}</p>
            </div>
            <ThemeSelect
              id="image-converter-preset"
              className="settings-select"
              value={preferences.imagePreset}
              options={IMAGE_PRESET_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              aria-label="图片转换预设"
              onChange={(value) => applyPreset(value as ImagePresetId)}
            />
          </div>
          <div className="settings-row settings-preset-row">
            <div><h3>自定义图片预设</h3><p>只保存在本机，可保存当前图片转换默认参数。</p></div>
            <div className="settings-custom-preset-controls">
              <ThemeSelect id="custom-image-preset" className="settings-select" value={customPresetId} options={[{ value: "", label: "选择本地预设" }, ...customPresets.map((preset) => ({ value: preset.id, label: preset.name }))]} aria-label="自定义图片预设" onChange={(value) => applyCustomPreset(String(value))} />
              <input className="settings-text-input" value={customPresetName} placeholder="预设名称" aria-label="新预设名称" onChange={(event) => setCustomPresetName(event.target.value)} />
              <button className="quiet-button" type="button" disabled={!customPresetName.trim()} onClick={saveCustomPreset}>保存</button>
              <button className="quiet-button" type="button" disabled={!customPresetId} onClick={deleteCustomPreset}>删除</button>
            </div>
          </div>
        </section>

        <section className="settings-card" aria-labelledby="raw-defaults-title">
          <div className="settings-card-header">
            <div>
              <h2 id="raw-defaults-title">RAW 与像素默认参数</h2>
              <p>用于 BMP、RGB565 BIN 和 C 数组等嵌入式资源输出；切换预设会覆盖这些值。</p>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <h3>默认位深</h3>
              <p>具体格式可能固定或限制可用位深。</p>
            </div>
            <ThemeSelect
              id="default-bit-depth"
              className="settings-select"
              value={preferences.defaultBitDepth}
              options={getBitDepths(preferences.defaultOutputFormat).map((depth) => ({ value: depth, label: `${depth} 位` }))}
              aria-label="默认位深"
              onChange={(value) => updateConverterDefaults({ defaultBitDepth: value as BmpBitDepth })}
            />
          </div>
          <div className="settings-row">
            <div>
              <h3>默认字节序</h3>
              <p>RGB565 BIN 与 C 数组的字节排列方式。</p>
            </div>
            <ThemeSelect id="default-byte-order" className="settings-select" value={preferences.defaultByteOrder} options={BYTE_ORDER_OPTIONS} aria-label="默认字节序" onChange={(value) => updateConverterDefaults({ defaultByteOrder: value as ByteOrder })} />
          </div>
          <div className="settings-row">
            <div>
              <h3>默认通道顺序</h3>
              <p>适配 RGB/BGR 屏幕控制器。</p>
            </div>
            <ThemeSelect id="default-channel-order" className="settings-select" value={preferences.defaultChannelOrder} options={CHANNEL_ORDER_OPTIONS} aria-label="默认通道顺序" onChange={(value) => updateConverterDefaults({ defaultChannelOrder: value as ChannelOrder })} />
          </div>
          <div className="settings-row">
            <div>
              <h3>默认行顺序</h3>
              <p>适配从上到下或从下到上的帧缓冲。</p>
            </div>
            <ThemeSelect id="default-row-order" className="settings-select" value={preferences.defaultRowOrder} options={ROW_ORDER_OPTIONS} aria-label="默认行顺序" onChange={(value) => updateConverterDefaults({ defaultRowOrder: value as RowOrder })} />
          </div>
          <div className="settings-row">
            <div>
              <h3>默认行对齐</h3>
              <p>原始像素数据的每行补齐字节数。</p>
            </div>
            <ThemeSelect id="default-row-alignment" className="settings-select" value={preferences.defaultRowAlignment} options={ROW_ALIGNMENT_OPTIONS} aria-label="默认行对齐" onChange={(value) => updateConverterDefaults({ defaultRowAlignment: value as RowAlignment })} />
          </div>
          <div className="settings-row">
            <div>
              <h3>默认 C 数组变量名</h3>
              <p>生成 C 数组源码时使用的标识符。</p>
            </div>
            <input className="settings-text-input" value={preferences.defaultCArrayName} aria-label="默认 C 数组变量名" spellCheck={false} onChange={(event) => updateConverterDefaults({ defaultCArrayName: event.target.value })} />
          </div>
          <div className="settings-row">
            <div>
              <h3>默认背景色</h3>
              <p>非透明输出或留白区域使用的颜色。</p>
            </div>
            <label className="settings-color-control" htmlFor="default-background-color">
              <input id="default-background-color" type="color" value={preferences.defaultBackgroundColor} aria-label="默认背景色" onChange={(event) => updateConverterDefaults({ defaultBackgroundColor: event.target.value.toUpperCase() })} />
              <span>{preferences.defaultBackgroundColor}</span>
            </label>
          </div>
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
