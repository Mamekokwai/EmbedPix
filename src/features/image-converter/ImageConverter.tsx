import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChangeEvent, DragEvent } from "react";
import {
  Check,
  ChevronDown,
  Download,
  Image as ImageIcon,
  Info,
  Upload,
  X,
} from "lucide-react";
import { exportImage } from "../../platform/image/imageExportGateway";
import {
  DEFAULT_C_ARRAY_NAME,
  DEFAULT_JPEG_QUALITY,
  MAX_DIMENSION,
  MAX_INPUT_BYTES,
  OUTPUT_FORMATS,
  PNG_BIT_DEPTHS,
  ROW_ALIGNMENTS,
  SUPPORTED_IMAGE_ACCEPT,
  SUPPORTED_IMAGE_FORMAT_LABEL,
  constrainAspectDimensions,
  constrainDimensions,
  formatFileSize,
  formatMebibytes,
  getBackgroundNote,
  getBitDepthNote,
  getBitDepths,
  getDimensionError,
  getEffectiveBitDepth,
  getFormatInfo,
  getOutputLabel,
  getOutputParameterNote,
  getPixelError,
  isCArrayFormat,
  isImageFile,
  isRawPixelFormat,
  normalizeDimension,
  normalizeCArrayName,
  parseDimension,
} from "./imageConverterLogic";
import type {
  ByteOrder,
  ChannelOrder,
  ExportImageRequest,
  ImageDimensions,
  BmpBitDepth,
  OutputFormat,
  RowAlignment,
  RowOrder,
} from "./types";

interface ImageConverterProps {
  defaultOutputFormat?: OutputFormat;
  defaultJpegQuality?: number;
  defaultKeepAspectRatio?: boolean;
}

type Status =
  | { kind: "idle"; text: string }
  | { kind: "ready"; text: string }
  | { kind: "busy"; text: string }
  | { kind: "success"; text: string }
  | { kind: "error"; text: string };


function readImageDimensions(file: File) {
  return new Promise<ImageDimensions>((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("无法读取这张图片，请选择有效的图片文件。"));
    };
    image.src = objectUrl;
  });
}

function FormatSelector({
  value,
  onChange,
}: {
  value: OutputFormat;
  onChange: (value: OutputFormat) => void;
}) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  return (
    <div className="format-selector" role="radiogroup" aria-label="输出格式" aria-describedby="format-description">
      {OUTPUT_FORMATS.map((format, index) => (
        <button
          key={format.value}
          className={`format-option${value === format.value ? " format-option-selected" : ""}`}
          type="button"
          role="radio"
          aria-checked={value === format.value}
          tabIndex={value === format.value ? 0 : -1}
          ref={(element) => { optionRefs.current[index] = element; }}
          onClick={() => onChange(format.value)}
          onKeyDown={(event) => {
            const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
            if (direction !== 0 || event.key === "Home" || event.key === "End") {
              event.preventDefault();
              const nextIndex = event.key === "Home"
                ? 0
                : event.key === "End"
                  ? OUTPUT_FORMATS.length - 1
                  : (index + direction + OUTPUT_FORMATS.length) % OUTPUT_FORMATS.length;
              onChange(OUTPUT_FORMATS[nextIndex].value);
              optionRefs.current[nextIndex]?.focus();
            }
          }}
          aria-label={`${format.label}：${format.description}`}
        >
          <span>{format.label}</span>
          <small>{format.hint}</small>
        </button>
      ))}
    </div>
  );
}

function SelectField<T extends string | number>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <label className="compact-field" htmlFor={id}>
      <span>{label}</span>
      <span className="select-wrap">
        <select id={id} value={value} onChange={(event) => {
          const next = options.find((option) => String(option.value) === event.target.value)?.value;
          if (next !== undefined) {
            onChange(next);
          }
        }}>
          {options.map((option) => <option key={String(option.value)} value={option.value}>{option.label}</option>)}
        </select>
        <ChevronDown size={15} aria-hidden="true" />
      </span>
    </label>
  );
}

export default function ImageConverter({
  defaultOutputFormat = "bmp",
  defaultJpegQuality = DEFAULT_JPEG_QUALITY,
  defaultKeepAspectRatio = true,
}: ImageConverterProps) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<ImageDimensions | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [widthInput, setWidthInput] = useState("");
  const [heightInput, setHeightInput] = useState("");
  const [outputFormat, setOutputFormat] = useState<OutputFormat>(defaultOutputFormat);
  const [bitDepth, setBitDepth] = useState<BmpBitDepth>(24);
  const [jpegQuality, setJpegQuality] = useState(defaultJpegQuality);
  const [byteOrder, setByteOrder] = useState<ByteOrder>("little");
  const [channelOrder, setChannelOrder] = useState<ChannelOrder>("rgb");
  const [rowOrder, setRowOrder] = useState<RowOrder>("top-down");
  const [rowAlignment, setRowAlignment] = useState<RowAlignment>(1);
  const [cArrayName, setCArrayName] = useState(DEFAULT_C_ARRAY_NAME);
  const [keepAspectRatio, setKeepAspectRatio] = useState(defaultKeepAspectRatio);
  const [backgroundColor, setBackgroundColor] = useState("#FFFFFF");
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "等待导入图片" });
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const loadIdRef = useRef(0);

  useEffect(() => {
    return () => {
      loadIdRef.current += 1;
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
    };
  }, []);

  const widthError = file ? getDimensionError(widthInput, "宽度") : null;
  const heightError = file ? getDimensionError(heightInput, "高度") : null;
  const dimensionError = widthError ?? heightError ?? (file ? getPixelError(widthInput, heightInput) : null);
  const errorMessage = dimensionError ?? error;

  const setSettingStatus = (nextWidthInput = widthInput, nextHeightInput = heightInput) => {
    if (!file) {
      return;
    }

    const nextDimensionError = getDimensionError(nextWidthInput, "宽度") ?? getDimensionError(nextHeightInput, "高度") ?? getPixelError(nextWidthInput, nextHeightInput);
    setStatus(nextDimensionError ? { kind: "error", text: "请检查输出尺寸" } : { kind: "ready", text: "参数已更新，可以导出" });
  };

  const outputSummary = useMemo(() => {
    if (!file) {
      return "导入图片后开始设置输出参数";
    }

    const summaryBitDepth = getEffectiveBitDepth(outputFormat, bitDepth);
    return `${width} × ${height} · ${getOutputLabel(outputFormat)} · ${summaryBitDepth} 位`;
  }, [bitDepth, file, height, outputFormat, width]);

  const loadFile = async (nextFile: File) => {
    const loadId = loadIdRef.current + 1;
    loadIdRef.current = loadId;
    setError(null);
    setStatus({ kind: "busy", text: "正在读取图片…" });

    if (!isImageFile(nextFile)) {
      setStatus({ kind: "error", text: "文件格式不支持" });
      setError(`请选择 ${SUPPORTED_IMAGE_FORMAT_LABEL} 文件。`);
      return;
    }

    if (nextFile.size > MAX_INPUT_BYTES) {
      setStatus({ kind: "error", text: "文件过大，无法读取" });
      setError(`图片文件不能超过 32 MiB，当前为 ${formatMebibytes(nextFile.size)}。`);
      return;
    }

    try {
      const nextDimensions = await readImageDimensions(nextFile);
      if (loadId !== loadIdRef.current) {
        return;
      }

      const nextPreviewUrl = URL.createObjectURL(nextFile);
      if (loadId !== loadIdRef.current) {
        URL.revokeObjectURL(nextPreviewUrl);
        return;
      }

      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
      previewUrlRef.current = nextPreviewUrl;
      const targetDimensions = constrainDimensions(nextDimensions);

      setFile(nextFile);
      setPreviewUrl(nextPreviewUrl);
      setDimensions(nextDimensions);
      setWidth(targetDimensions.width);
      setHeight(targetDimensions.height);
      setWidthInput(String(targetDimensions.width));
      setHeightInput(String(targetDimensions.height));
      setStatus({ kind: "ready", text: "图片已载入，可以导出" });
    } catch (loadError) {
      if (loadId !== loadIdRef.current) {
        return;
      }
      const message = loadError instanceof Error ? loadError.message : "图片读取失败，请重试。";
      setStatus({ kind: "error", text: "读取失败" });
      setError(message);
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0];
    if (nextFile) {
      void loadFile(nextFile);
    }
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const nextFile = event.dataTransfer.files[0];
    if (nextFile) {
      void loadFile(nextFile);
    }
  };

  const clearFile = () => {
    loadIdRef.current += 1;
    setFile(null);
    setDimensions(null);
    setWidth(0);
    setHeight(0);
    setWidthInput("");
    setHeightInput("");
    setError(null);
    setStatus({ kind: "idle", text: "等待导入图片" });
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewUrl(null);
  };

  const handleWidthChange = (value: string) => {
    setWidthInput(value);
    const nextWidth = parseDimension(value);
    if (nextWidth === null) {
      setError(null);
      setStatus({ kind: "error", text: "请检查输出尺寸" });
      return;
    }

    let nextWidthInput = value;
    let nextHeightInput = heightInput;
    if (keepAspectRatio && dimensions) {
      const target = constrainAspectDimensions("width", nextWidth, dimensions);
      setWidth(target.width);
      setHeight(target.height);
      nextWidthInput = String(target.width);
      nextHeightInput = String(target.height);
      setWidthInput(nextWidthInput);
      setHeightInput(nextHeightInput);
    } else {
      setWidth(nextWidth);
    }
    const nextError = getDimensionError(nextWidthInput, "宽度") ?? getDimensionError(nextHeightInput, "高度") ?? getPixelError(nextWidthInput, nextHeightInput);
    setError(null);
    setStatus(nextError ? { kind: "error", text: "请检查输出尺寸" } : { kind: "ready", text: "参数已更新，可以导出" });
  };

  const handleHeightChange = (value: string) => {
    setHeightInput(value);
    const nextHeight = parseDimension(value);
    if (nextHeight === null) {
      setError(null);
      setStatus({ kind: "error", text: "请检查输出尺寸" });
      return;
    }

    let nextWidthInput = widthInput;
    let nextHeightInput = value;
    if (keepAspectRatio && dimensions) {
      const target = constrainAspectDimensions("height", nextHeight, dimensions);
      setWidth(target.width);
      setHeight(target.height);
      nextWidthInput = String(target.width);
      nextHeightInput = String(target.height);
      setWidthInput(nextWidthInput);
      setHeightInput(nextHeightInput);
    } else {
      setHeight(nextHeight);
    }
    const nextError = getDimensionError(nextWidthInput, "宽度") ?? getDimensionError(nextHeightInput, "高度") ?? getPixelError(nextWidthInput, nextHeightInput);
    setError(null);
    setStatus(nextError ? { kind: "error", text: "请检查输出尺寸" } : { kind: "ready", text: "参数已更新，可以导出" });
  };

  const handleDimensionBlur = (axis: "width" | "height") => {
    const value = axis === "width" ? widthInput : heightInput;
    if (parseDimension(value) !== null) {
      return;
    }

    const fallback = axis === "width" ? width : height;
    const normalized = normalizeDimension(value, fallback || 1);
    const target = keepAspectRatio && dimensions
      ? constrainAspectDimensions(axis, normalized, dimensions)
      : null;
    const nextWidthInput = target?.width !== undefined
      ? String(target.width)
      : axis === "width"
        ? String(normalized)
        : widthInput;
    const nextHeightInput = target?.height !== undefined
      ? String(target.height)
      : axis === "height"
        ? String(normalized)
        : heightInput;
    if (axis === "width") {
      setWidth(target?.width ?? normalized);
      setWidthInput(nextWidthInput);
    } else {
      setHeight(target?.height ?? normalized);
      setHeightInput(nextHeightInput);
    }
    if (target) {
      setWidth(target.width);
      setHeight(target.height);
      setWidthInput(String(target.width));
      setHeightInput(String(target.height));
    }
    setError(null);
    setSettingStatus(nextWidthInput, nextHeightInput);
  };

  const handleFormatChange = (nextFormat: OutputFormat) => {
    setOutputFormat(nextFormat);
    if (nextFormat === "jpg" || (nextFormat === "png" && !PNG_BIT_DEPTHS.includes(bitDepth))) {
      setBitDepth(24);
    } else if (isRawPixelFormat(nextFormat)) {
      setBitDepth(16);
    }
    setError(null);
    setSettingStatus();
  };

  const handleBitDepthChange = (nextBitDepth: BmpBitDepth) => {
    setBitDepth(nextBitDepth);
    setError(null);
    setSettingStatus();
  };

  const handleBackgroundColorChange = (nextColor: string) => {
    setBackgroundColor(nextColor.toUpperCase());
    setError(null);
    setSettingStatus();
  };

  const handleOutputParameterChange = () => {
    setError(null);
    setSettingStatus();
  };

  const handleKeepAspectRatioChange = (checked: boolean) => {
    setKeepAspectRatio(checked);
    let nextWidthInput = widthInput;
    let nextHeightInput = heightInput;
    if (checked && dimensions) {
      const currentWidth = parseDimension(widthInput) ?? width;
      const target = constrainAspectDimensions("width", currentWidth, dimensions);
      setWidth(target.width);
      setHeight(target.height);
      nextWidthInput = String(target.width);
      nextHeightInput = String(target.height);
      setWidthInput(nextWidthInput);
      setHeightInput(nextHeightInput);
    }
    setError(null);
    setSettingStatus(nextWidthInput, nextHeightInput);
  };

  const handleExport = async () => {
    if (!file || !dimensions) {
      setError("请先导入一张图片。" );
      setStatus({ kind: "error", text: "还没有可导出的图片" });
      return;
    }

    setError(null);
    setStatus({ kind: "busy", text: "正在导出图片…" });

    try {
      const request: ExportImageRequest = {
        fileName: file.name,
        inputData: new Uint8Array(await file.arrayBuffer()),
        outputFormat,
        width,
        height,
        keepAspectRatio,
        bitDepth: getEffectiveBitDepth(outputFormat, bitDepth),
        backgroundColor,
        jpegQuality,
        byteOrder,
        channelOrder,
        rowOrder,
        rowAlignment,
        cArrayName: normalizeCArrayName(cArrayName),
      };
      const outputPath = await exportImage(request);
      setStatus({
        kind: "success",
        text: outputPath ? `已导出到 ${outputPath}` : "导出完成",
      });
    } catch (exportError) {
      const message = exportError instanceof Error ? exportError.message : "导出失败，请重试。";
      setStatus({ kind: "error", text: "导出失败" });
      setError(message);
    }
  };

  return (
    <main className="converter-app">
      <header className="converter-header">
        <div className="brand-lockup">
          <img className="brand-mark" src="/embedpix-icon.png" alt="" aria-hidden="true" />
          <div>
            <p className="eyebrow">EMBEDPIX</p>
            <h1>图片转换工作区</h1>
          </div>
        </div>
        <div className="header-context">
          <span className="status-dot" aria-hidden="true" />
          本地处理
        </div>
      </header>

      <section className="converter-intro" aria-labelledby="workspace-title">
        <div>
          <p className="eyebrow">IMAGE WORKSPACE</p>
          <h2 id="workspace-title">转换图片，适配你的嵌入式界面</h2>
          <p className="intro-copy">导入一张图片，调整尺寸与输出规格，然后导出到本地文件。</p>
        </div>
        <div className="intro-note">
          <Info size={16} aria-hidden="true" />
          <span>文件仅在本地处理</span>
        </div>
      </section>

      <section className="workspace-grid" aria-label="图片转换工作区">
        <div className="panel preview-panel">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">01 / SOURCE</p>
              <h3>源图片</h3>
            </div>
            {file ? (
              <button className="icon-button" type="button" onClick={clearFile} aria-label="移除图片" title="移除图片">
                <X size={16} aria-hidden="true" />
              </button>
            ) : null}
          </div>

          {!file ? (
            <div
              className={`drop-zone${isDragging ? " drop-zone-dragging" : ""}`}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setIsDragging(false);
                }
              }}
              onDrop={handleDrop}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  inputRef.current?.click();
                }
              }}
              aria-label="拖拽图片到这里，或按 Enter 选择本地文件"
            >
              <div className="drop-icon"><Upload size={22} aria-hidden="true" /></div>
              <strong>拖拽图片到这里</strong>
              <span>或点击选择本地文件</span>
              <small>支持 {SUPPORTED_IMAGE_FORMAT_LABEL}</small>
              <input ref={inputRef} type="file" accept={SUPPORTED_IMAGE_ACCEPT} onChange={handleFileChange} hidden />
            </div>
          ) : (
            <div className="preview-content">
              <div className="preview-frame" style={{ backgroundColor }}>
                {previewUrl ? <img src={previewUrl} alt={`预览：${file.name}`} /> : null}
              </div>
              <div className="file-summary">
                <div className="file-icon"><ImageIcon size={18} aria-hidden="true" /></div>
                <div className="file-copy">
                  <strong title={file.name}>{file.name}</strong>
                  <span>{dimensions?.width} × {dimensions?.height} px · {formatFileSize(file.size)}</span>
                </div>
                <span className="file-ready"><Check size={14} aria-hidden="true" /> 已载入</span>
              </div>
            </div>
          )}
        </div>

        <div className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">02 / OUTPUT</p>
              <h3>输出设置</h3>
            </div>
            <span className="output-summary">{outputSummary}</span>
          </div>

          <div className="settings-stack">
            <fieldset className="setting-group format-group">
              <legend className="field-label">输出格式</legend>
              <FormatSelector value={outputFormat} onChange={handleFormatChange} />
              <p className="format-description" id="format-description">{getFormatInfo(outputFormat).description}</p>
            </fieldset>

            <div className="setting-group">
              <div className="label-row">
                <label className="field-label" htmlFor="bit-depth">位深</label>
                <span className="field-note">{outputFormat === "jpg" ? "JPG 固定 24 位" : isRawPixelFormat(outputFormat) ? "RGB565 固定 16 位" : `${getBitDepths(outputFormat).join(" / ")} 位可选`}</span>
              </div>
              <div className="select-wrap">
                <select
                  id="bit-depth"
                  value={bitDepth}
                  disabled={outputFormat === "jpg" || isRawPixelFormat(outputFormat)}
                  aria-describedby="bit-depth-description"
                  onChange={(event) => handleBitDepthChange(Number(event.target.value) as BmpBitDepth)}
                >
                  {getBitDepths(outputFormat).map((depth) => <option key={depth} value={depth}>{depth} 位</option>)}
                </select>
                <ChevronDown size={15} aria-hidden="true" />
              </div>
              <p className="field-help" id="bit-depth-description">{getBitDepthNote(outputFormat, bitDepth)}</p>
            </div>

            {outputFormat === "jpg" ? (
              <div className="setting-group">
                <div className="label-row">
                  <label className="field-label" htmlFor="jpeg-quality">JPEG 质量</label>
                  <span className="field-note">{jpegQuality} / 100</span>
                </div>
                <input
                  className="range-input"
                  id="jpeg-quality"
                  type="range"
                  min="1"
                  max="100"
                  step="1"
                  value={jpegQuality}
                  onChange={(event) => {
                    setJpegQuality(Number(event.target.value));
                    handleOutputParameterChange();
                  }}
                  aria-describedby="jpeg-quality-description"
                />
                <p className="field-help" id="jpeg-quality-description">数值越高画质越好，文件也会更大。</p>
              </div>
            ) : null}

            {isRawPixelFormat(outputFormat) ? (
              <div className="setting-group">
                <div className="label-row">
                  <span className="field-label">像素排列</span>
                  <span className="field-note">RGB565 / 16 位固定</span>
                </div>
                <div className="parameter-grid">
                  <SelectField
                    id="byte-order"
                    label="字节序"
                    value={byteOrder}
                    options={[{ value: "little", label: "小端" }, { value: "big", label: "大端" }]}
                    onChange={(value) => { setByteOrder(value); handleOutputParameterChange(); }}
                  />
                  <SelectField
                    id="channel-order"
                    label="通道"
                    value={channelOrder}
                    options={[{ value: "rgb", label: "RGB" }, { value: "bgr", label: "BGR" }]}
                    onChange={(value) => { setChannelOrder(value); handleOutputParameterChange(); }}
                  />
                  <SelectField
                    id="row-order"
                    label="行顺序"
                    value={rowOrder}
                    options={[{ value: "top-down", label: "从上到下" }, { value: "bottom-up", label: "从下到上" }]}
                    onChange={(value) => { setRowOrder(value); handleOutputParameterChange(); }}
                  />
                  <SelectField
                    id="row-alignment"
                    label="行对齐"
                    value={rowAlignment}
                    options={ROW_ALIGNMENTS.map((alignment) => ({ value: alignment, label: `${alignment} 字节` }))}
                    onChange={(value) => { setRowAlignment(value); handleOutputParameterChange(); }}
                  />
                </div>
                {isCArrayFormat(outputFormat) ? (
                  <label className="text-field" htmlFor="c-array-name">
                    <span>变量名</span>
                    <input
                      id="c-array-name"
                      value={cArrayName}
                      onChange={(event) => {
                        setCArrayName(event.target.value);
                        handleOutputParameterChange();
                      }}
                      onBlur={() => setCArrayName(normalizeCArrayName(cArrayName))}
                      placeholder={DEFAULT_C_ARRAY_NAME}
                      spellCheck={false}
                    />
                  </label>
                ) : null}
                <p className="field-help">{getOutputParameterNote(outputFormat)}</p>
              </div>
            ) : null}

            <div className="setting-group">
              <div className="label-row">
                <label className="field-label">输出尺寸</label>
                {dimensions ? <span className="field-note">原图 {dimensions.width} × {dimensions.height}</span> : null}
              </div>
              <div className="dimensions-row">
                <label className={`dimension-input${widthError ? " dimension-input-invalid" : ""}`} htmlFor="output-width">
                  <span>宽</span>
                  <input id="output-width" type="number" inputMode="numeric" min="1" max={MAX_DIMENSION} step="1" value={widthInput} disabled={!file} aria-invalid={Boolean(widthError)} aria-describedby={dimensionError ? "dimension-error" : undefined} onChange={(event) => handleWidthChange(event.target.value)} onBlur={() => handleDimensionBlur("width")} />
                  <em>px</em>
                </label>
                <span className="dimension-times" aria-hidden="true">×</span>
                <label className={`dimension-input${heightError ? " dimension-input-invalid" : ""}`} htmlFor="output-height">
                  <span>高</span>
                  <input id="output-height" type="number" inputMode="numeric" min="1" max={MAX_DIMENSION} step="1" value={heightInput} disabled={!file} aria-invalid={Boolean(heightError)} aria-describedby={dimensionError ? "dimension-error" : undefined} onChange={(event) => handleHeightChange(event.target.value)} onBlur={() => handleDimensionBlur("height")} />
                  <em>px</em>
                </label>
              </div>
              <label className="toggle-row">
                <input type="checkbox" checked={keepAspectRatio} onChange={(event) => handleKeepAspectRatioChange(event.target.checked)} />
                <span className="toggle-track" aria-hidden="true"><span /></span>
                <span>保持比例</span>
              </label>
            </div>

            <div className="setting-group">
              <div className="label-row">
                <label className="field-label" htmlFor="background-color">背景色</label>
                <span className="field-note">{getBackgroundNote(outputFormat, bitDepth)}</span>
              </div>
              <label className="color-control" htmlFor="background-color">
                <input id="background-color" type="color" value={backgroundColor} onChange={(event) => handleBackgroundColorChange(event.target.value)} />
                <span>{backgroundColor}</span>
              </label>
            </div>
          </div>

          <div className="panel-footer">
            <div className="footer-status">
              <div className={`status-message status-${status.kind}`} role="status" aria-live="polite">
                <span className="status-indicator" aria-hidden="true" />
                <span>{status.text}</span>
              </div>
              {errorMessage ? <p className="error-message" id="dimension-error" role="alert">{errorMessage}</p> : null}
            </div>
            <button className="export-button" type="button" disabled={!file || status.kind === "busy" || Boolean(dimensionError)} aria-busy={status.kind === "busy"} onClick={() => void handleExport()}>
              <Download size={17} aria-hidden="true" />
              {status.kind === "busy" ? "处理中…" : `导出 ${getOutputLabel(outputFormat)}`}
            </button>
          </div>
        </div>
      </section>

      <footer className="converter-footer">
        <span>EmbedPix · 嵌图匠</span>
        <span className="footer-contract">输出由桌面端 <code>export_image</code> 命令处理</span>
      </footer>
    </main>
  );
}
