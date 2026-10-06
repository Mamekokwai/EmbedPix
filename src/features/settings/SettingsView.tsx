import { Check, Info, Laptop, Moon, RefreshCw, RotateCcw, Settings2, Sun, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
import {
  getSchemeLabel,
  schemesForVariant,
  themeSwatches,
  type ColorScheme,
} from "../../shared/theme/themePresets";
import { exportPresetBundle, formatPresetTransferError, importPresetBundle, mergeImportedPresets } from "../../shared/presetTransfer";
import { downloadBlob } from "../../shared/downloadBlob";
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

// 草稿与当前配置逐字段比较：偏好项都是原始类型、键固定，浅比较足以判定“脏”，不引入新依赖。
function arePreferencesEqual(a: AppPreferences, b: AppPreferences): boolean {
  const keys = Object.keys(a) as Array<keyof AppPreferences>;
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

// onChange 落盘是同步的：给「正在保存...」一段可见的停留时间，否则状态会被同一批更新合并、用户根本看不到反馈。
const SAVE_FEEDBACK_MS = 240;

function SettingsRow({ title, hint, stacked, className, children }: { title: string; hint: string; stacked?: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={`settings-row${stacked ? " settings-row-stacked" : ""}${className ? ` ${className}` : ""}`}>
      <div className="settings-row-copy">
        <div className="settings-row-title">
          <h3>{title}</h3>
          <button type="button" className="settings-help-icon" aria-label={hint} title={hint}>
            <Info size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function SchemeSwatches({ variant, scheme }: { variant: "light" | "dark"; scheme: ColorScheme }) {
  return (
    <span className="settings-color-scheme-swatches" aria-hidden="true">
      {themeSwatches(variant, scheme).map((color, index) => (
        <span key={`${color}-${index}`} className="settings-color-scheme-swatch" style={{ backgroundColor: color }} />
      ))}
    </span>
  );
}

// patina 的配色方案是「当前方案一行 + 色卡网格弹窗」，不是下拉。
function SchemePicker({ variant, label, value, onChange }: {
  variant: "light" | "dark";
  label: string;
  value: ColorScheme;
  onChange: (scheme: ColorScheme) => void;
}) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const schemes = schemesForVariant(variant);

  // 键盘用户点开弹窗后应能立即 Esc 关闭、Tab 进选项，不必先手动聚焦。
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <>
      <div className="scheme-picker-row">
        <span className="scheme-picker-label">{label}</span>
        <span className="scheme-picker-current">
          <SchemeSwatches variant={variant} scheme={value} />
          <span>{getSchemeLabel(value)}</span>
        </span>
        <button type="button" className="scheme-picker-change" onClick={() => setOpen(true)}>
          更改
        </button>
      </div>
      {open ? (
        <div
          className="settings-scheme-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className="settings-scheme-dialog" role="dialog" aria-modal="true" aria-label={label} ref={dialogRef} tabIndex={-1}>
            <header className="settings-scheme-header">
              <h4>{label}</h4>
              <button type="button" className="settings-scheme-close" aria-label="关闭" onClick={() => setOpen(false)}>
                <X size={14} aria-hidden="true" />
              </button>
            </header>
            <div className="settings-color-scheme-list" role="group" aria-label={label}>
              {schemes.map((scheme) => {
                const selected = scheme === value;
                return (
                  <button
                    key={scheme}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      onChange(scheme);
                      setOpen(false);
                    }}
                    className={`settings-color-scheme-option${selected ? " settings-color-scheme-option-selected" : ""}`}
                  >
                    <SchemeSwatches variant={variant} scheme={scheme} />
                    <span>{getSchemeLabel(scheme)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export default function SettingsView({ preferences, onChange, onReset }: SettingsViewProps) {
  const [customPresets, setCustomPresets] = useState<ImageCustomPreset[]>(() => loadImageCustomPresets());
  const [customPresetId, setCustomPresetId] = useState("");
  const [customPresetName, setCustomPresetName] = useState("");
  const [presetMessage, setPresetMessage] = useState<string | null>(null);
  const presetInputRef = useRef<HTMLInputElement>(null);
  // 草稿态：所有设置控件读写这份 draft，只有点「保存」才通过 onChange 一次性提交给外部。
  const [draft, setDraft] = useState<AppPreferences>(preferences);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving">("idle");

  // 外部（如「恢复默认设置」）改动 props 后草稿要跟上，否则表单会停在上一次的旧值上。
  useEffect(() => { setDraft(preferences); }, [preferences]);

  const hasUnsavedChanges = !arePreferencesEqual(draft, preferences);
  const activeImagePresetDescription = IMAGE_PRESET_OPTIONS.find((option) => option.value === draft.imagePreset)?.description;

  const patchDraft = (next: Partial<AppPreferences>) => setDraft((current) => ({ ...current, ...next }));
  const updateConverterDefaults = (next: Partial<AppPreferences>) => {
    patchDraft({ ...next, imagePreset: "custom" });
  };

  const handleSave = () => {
    setSaveStatus("saving");
    onChange(draft);
    window.setTimeout(() => setSaveStatus("idle"), SAVE_FEEDBACK_MS);
  };

  const handleCancel = () => {
    setDraft(preferences);
    setSaveStatus("idle");
  };

  const applyPreset = (value: ImagePresetId) => {
    if (value === "custom") {
      patchDraft({ imagePreset: value });
      return;
    }
    if (value === draft.imagePreset) return;
    const preset = IMAGE_PRESETS[value];
    if (!window.confirm(`切换到“${presetLabel(value)}”会覆盖图片转换默认格式、JPEG 质量、位深、RAW 参数、透明色和比例设置。是否继续？`)) {
      return;
    }
    patchDraft({ ...preset, imagePreset: value });
  };

  const handleDefaultOutputFormat = (value: string | number) => {
    const nextFormat = value as AppPreferences["defaultOutputFormat"];
    const availableBitDepths = getBitDepths(nextFormat);
    const nextBitDepth = availableBitDepths.includes(draft.defaultBitDepth)
      ? draft.defaultBitDepth
      : availableBitDepths[0] ?? 24;
    updateConverterDefaults({ defaultOutputFormat: nextFormat, defaultBitDepth: nextBitDepth });
  };

  const saveCustomPreset = () => {
    const name = customPresetName.trim();
    if (!name) return;
    const next = [...customPresets, createImageCustomPreset(name, draft)];
    setCustomPresets(next);
    saveImageCustomPresets(next);
    setCustomPresetName("");
  };

  const applyCustomPreset = (id: string) => {
    setCustomPresetId(id);
    const preset = customPresets.find((item) => item.id === id);
    if (preset) patchDraft({ ...preset.values, imagePreset: "custom" });
  };

  const deleteCustomPreset = () => {
    const next = customPresets.filter((item) => item.id !== customPresetId);
    setCustomPresets(next);
    saveImageCustomPresets(next);
    setCustomPresetId("");
  };

  const downloadImagePresets = () => {
    downloadBlob(new Blob([exportPresetBundle(customPresets, [])], { type: "application/json" }), "embedpix-image-presets.json");
    setPresetMessage("图片预设 JSON 已导出");
  };
  const importImagePresetFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const incoming = importPresetBundle(await file.text()).image;
      const next = mergeImportedPresets(customPresets, incoming, "skip"); setCustomPresets(next); saveImageCustomPresets(next);
      setPresetMessage(`已导入 ${next.length - customPresets.length} 个图片预设，重复名称已跳过`);
    } catch (error) { setPresetMessage(formatPresetTransferError(error)); }
  };

  return (
    <div className="settings-view page-view">
      <header className="page-header settings-toolbar">
        <div className="page-header-icon"><Settings2 size={19} aria-hidden="true" /></div>
        <div>
          <p className="page-eyebrow">PREFERENCES</p>
          <h1>设置</h1>
          <p>调整工作区外观与常用导出参数。</p>
        </div>
        <div className="settings-toolbar-actions">
          <span
            className={`settings-save-status${saveStatus === "saving" ? " settings-save-status-saving" : hasUnsavedChanges ? " settings-save-status-danger" : " settings-save-status-saved"}`}
            role="status"
            aria-live="polite"
          >
            {saveStatus === "saving" ? (
              <><RefreshCw className="settings-save-spinner" size={12} aria-hidden="true" />正在保存...</>
            ) : hasUnsavedChanges ? (
              <>有未保存更改</>
            ) : (
              <><Check size={13} aria-hidden="true" />配置已更新</>
            )}
          </span>
          <button className="quiet-button settings-toolbar-cancel" type="button" onClick={handleCancel} disabled={!hasUnsavedChanges || saveStatus === "saving"}>取消</button>
          <button className="settings-primary-button settings-toolbar-save" type="button" onClick={handleSave} disabled={!hasUnsavedChanges || saveStatus === "saving"}>
            {saveStatus === "saving" ? <RefreshCw className="settings-save-spinner" size={14} aria-hidden="true" /> : null}
            保存
          </button>
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
          <SettingsRow title="界面主题" hint="选择 EmbedPix 的显示方式。">
            <div className="theme-options" role="radiogroup" aria-label="界面主题">
              {THEME_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={`theme-option${draft.themeMode === option.value ? " theme-option-active" : ""}`}
                  title={option.hint}
                >
                  <input type="radio" name="theme-mode" value={option.value} checked={draft.themeMode === option.value} onChange={() => patchDraft({ themeMode: option.value })} />
                  <ThemeModeIcon mode={option.value} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </SettingsRow>
          <SettingsRow stacked title="配色方案" hint="浅色与深色各选一套；跟随系统时按当前明暗分别生效。">
            <div className="scheme-picker-grid">
              <SchemePicker
                variant="light"
                label="浅色主题"
                value={draft.colorSchemeLight}
                onChange={(scheme) => patchDraft({ colorSchemeLight: scheme })}
              />
              <SchemePicker
                variant="dark"
                label="深色主题"
                value={draft.colorSchemeDark}
                onChange={(scheme) => patchDraft({ colorSchemeDark: scheme })}
              />
            </div>
          </SettingsRow>
        </section>

        <section className="settings-card" aria-labelledby="export-defaults-title">
          <div className="settings-card-header">
            <div>
              <h2 id="export-defaults-title">导出默认值</h2>
              <p>新打开转换页时使用这些参数，单次调整不会覆盖默认值。</p>
            </div>
          </div>
          <SettingsRow title="默认输出格式" hint="适合嵌入式资源的常用格式也可以直接设为默认。">
            <ThemeSelect
              id="default-output-format"
              className="settings-select"
              value={draft.defaultOutputFormat}
              options={OUTPUT_FORMATS.map((format) => ({ value: format.value, label: `${format.label} · ${format.hint}` }))}
              aria-label="默认输出格式"
              onChange={handleDefaultOutputFormat}
            />
          </SettingsRow>
          <SettingsRow title="JPEG 默认质量" hint="仅在选择 JPG 时生效，范围为 1–100。">
            <div className="settings-range-control">
              <input
                type="range"
                min="1"
                max="100"
                value={draft.defaultJpegQuality}
                aria-label="JPEG 默认质量"
                aria-valuetext={`${draft.defaultJpegQuality}% JPEG 默认质量`}
                onChange={(event) => updateConverterDefaults({ defaultJpegQuality: Number(event.target.value) })}
              />
              <output>{draft.defaultJpegQuality}</output>
            </div>
          </SettingsRow>
          <label className="settings-check-row">
            <input
              type="checkbox"
              checked={draft.keepAspectRatio}
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
              <p>预设会覆盖图片转换的默认格式、质量、位深、RAW 参数、透明色和比例设置；单独修改任一项后会变为自定义。</p>
            </div>
          </div>
          <SettingsRow className="settings-preset-row" title={`当前预设：${presetLabel(draft.imagePreset)}`} hint={activeImagePresetDescription ?? ""}>
            <ThemeSelect
              id="image-converter-preset"
              className="settings-select"
              value={draft.imagePreset}
              options={IMAGE_PRESET_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
              aria-label="图片转换预设"
              onChange={(value) => applyPreset(value as ImagePresetId)}
            />
          </SettingsRow>
          <SettingsRow stacked className="settings-preset-row" title="自定义图片预设" hint="只保存在本机，可保存当前图片转换默认参数。">
            <div className="settings-custom-preset-controls">
              <ThemeSelect id="custom-image-preset" className="settings-select" value={customPresetId} options={[{ value: "", label: "选择本地预设" }, ...customPresets.map((preset) => ({ value: preset.id, label: preset.name }))]} aria-label="自定义图片预设" onChange={(value) => applyCustomPreset(String(value))} />
              <input className="settings-text-input" value={customPresetName} placeholder="预设名称" aria-label="新预设名称" onChange={(event) => setCustomPresetName(event.target.value)} />
              <button className="quiet-button" type="button" disabled={!customPresetName.trim()} onClick={saveCustomPreset}>保存</button>
              <button className="quiet-button" type="button" disabled={!customPresetId} onClick={deleteCustomPreset}>删除</button>
              <button className="quiet-button" type="button" onClick={downloadImagePresets}>导出 JSON</button>
              <button className="quiet-button" type="button" onClick={() => presetInputRef.current?.click()}>导入 JSON</button>
              <input ref={presetInputRef} type="file" accept="application/json,.json" hidden onChange={(event) => { void importImagePresetFile(event.target.files?.[0]); event.target.value = ""; }} />
            </div>
          </SettingsRow>
          {presetMessage ? <p className="settings-preset-message" role="status">{presetMessage}</p> : null}
        </section>

        <section className="settings-card" aria-labelledby="raw-defaults-title">
          <div className="settings-card-header">
            <div>
              <h2 id="raw-defaults-title">RAW 与像素默认参数</h2>
              <p>用于 BMP、RGB565 BIN 和 C 数组等嵌入式资源输出；切换预设会覆盖这些值。</p>
            </div>
          </div>
          <SettingsRow title="默认位深" hint="具体格式可能固定或限制可用位深。">
            <ThemeSelect
              id="default-bit-depth"
              className="settings-select"
              value={draft.defaultBitDepth}
              options={getBitDepths(draft.defaultOutputFormat).map((depth) => ({ value: depth, label: `${depth} 位` }))}
              aria-label="默认位深"
              onChange={(value) => updateConverterDefaults({ defaultBitDepth: value as BmpBitDepth })}
            />
          </SettingsRow>
          <SettingsRow title="默认字节序" hint="RGB565 BIN 与 C 数组的字节排列方式。">
            <ThemeSelect id="default-byte-order" className="settings-select" value={draft.defaultByteOrder} options={BYTE_ORDER_OPTIONS} aria-label="默认字节序" onChange={(value) => updateConverterDefaults({ defaultByteOrder: value as ByteOrder })} />
          </SettingsRow>
          <SettingsRow title="默认通道顺序" hint="适配 RGB/BGR 屏幕控制器。">
            <ThemeSelect id="default-channel-order" className="settings-select" value={draft.defaultChannelOrder} options={CHANNEL_ORDER_OPTIONS} aria-label="默认通道顺序" onChange={(value) => updateConverterDefaults({ defaultChannelOrder: value as ChannelOrder })} />
          </SettingsRow>
          <SettingsRow title="默认行顺序" hint="适配从上到下或从下到上的帧缓冲。">
            <ThemeSelect id="default-row-order" className="settings-select" value={draft.defaultRowOrder} options={ROW_ORDER_OPTIONS} aria-label="默认行顺序" onChange={(value) => updateConverterDefaults({ defaultRowOrder: value as RowOrder })} />
          </SettingsRow>
          <SettingsRow title="默认行对齐" hint="原始像素数据的每行补齐字节数。">
            <ThemeSelect id="default-row-alignment" className="settings-select" value={draft.defaultRowAlignment} options={ROW_ALIGNMENT_OPTIONS} aria-label="默认行对齐" onChange={(value) => updateConverterDefaults({ defaultRowAlignment: value as RowAlignment })} />
          </SettingsRow>
          <SettingsRow title="默认 C 数组变量名" hint="生成 C 数组源码时使用的标识符。">
            <input className="settings-text-input" value={draft.defaultCArrayName} aria-label="默认 C 数组变量名" spellCheck={false} onChange={(event) => updateConverterDefaults({ defaultCArrayName: event.target.value })} />
          </SettingsRow>
          <SettingsRow title="默认透明色" hint="非透明输出或留白区域使用的颜色。">
            <label className="settings-color-control" htmlFor="default-background-color">
              <input id="default-background-color" type="color" value={draft.defaultBackgroundColor} aria-label="默认透明色" onChange={(event) => updateConverterDefaults({ defaultBackgroundColor: event.target.value.toUpperCase() })} />
              <span>{draft.defaultBackgroundColor}</span>
            </label>
          </SettingsRow>
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
