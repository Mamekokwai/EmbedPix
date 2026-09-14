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
import type {
  BmpBitDepth,
  ExportImageRequest,
  ImageDimensions,
  OutputFormat,
} from "./types";

const OUTPUT_FORMATS: Array<{ value: OutputFormat; label: string; hint: string }> = [
  { value: "bmp", label: "BMP", hint: "嵌入式常用" },
  { value: "png", label: "PNG", hint: "无损压缩" },
  { value: "jpg", label: "JPG", hint: "体积更小" },
];

const BMP_BIT_DEPTHS: BmpBitDepth[] = [1, 4, 8, 16, 24, 32];
const MAX_DIMENSION = 20000;

type Status =
  | { kind: "idle"; text: string }
  | { kind: "ready"; text: string }
  | { kind: "busy"; text: string }
  | { kind: "success"; text: string }
  | { kind: "error"; text: string };

function formatFileSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeDimension(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(MAX_DIMENSION, Math.max(1, parsed));
}

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

function fileToBase64(file: File) {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }

    return btoa(binary);
  });
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || /\.(bmp|gif|jpe?g|png|webp|tiff?)$/i.test(file.name);
}

function getOutputLabel(format: OutputFormat) {
  return format.toUpperCase();
}

function FormatSelector({
  value,
  onChange,
}: {
  value: OutputFormat;
  onChange: (value: OutputFormat) => void;
}) {
  return (
    <div className="format-selector" role="radiogroup" aria-label="输出格式">
      {OUTPUT_FORMATS.map((format) => (
        <button
          key={format.value}
          className={`format-option${value === format.value ? " format-option-selected" : ""}`}
          type="button"
          role="radio"
          aria-checked={value === format.value}
          onClick={() => onChange(format.value)}
        >
          <span>{format.label}</span>
          <small>{format.hint}</small>
        </button>
      ))}
    </div>
  );
}

export default function ImageConverter() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<ImageDimensions | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("bmp");
  const [bitDepth, setBitDepth] = useState<BmpBitDepth>(24);
  const [keepAspectRatio, setKeepAspectRatio] = useState(true);
  const [backgroundColor, setBackgroundColor] = useState("#FFFFFF");
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "等待导入图片" });
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  const outputSummary = useMemo(() => {
    if (!file) {
      return "导入图片后开始设置输出参数";
    }

    return `${width} × ${height} · ${getOutputLabel(outputFormat)}${outputFormat === "bmp" ? ` · ${bitDepth} 位` : ""}`;
  }, [bitDepth, file, height, outputFormat, width]);

  const loadFile = async (nextFile: File) => {
    setError(null);
    setStatus({ kind: "busy", text: "正在读取图片…" });

    if (!isImageFile(nextFile)) {
      setStatus({ kind: "error", text: "文件格式不支持" });
      setError("请选择 BMP、PNG、JPG 或其他常见图片文件。" );
      return;
    }

    try {
      const nextDimensions = await readImageDimensions(nextFile);
      const nextPreviewUrl = URL.createObjectURL(nextFile);

      setFile(nextFile);
      setPreviewUrl((currentUrl) => {
        if (currentUrl) {
          URL.revokeObjectURL(currentUrl);
        }
        return nextPreviewUrl;
      });
      setDimensions(nextDimensions);
      setWidth(nextDimensions.width);
      setHeight(nextDimensions.height);
      setStatus({ kind: "ready", text: "图片已载入，可以导出" });
    } catch (loadError) {
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
    setFile(null);
    setDimensions(null);
    setWidth(0);
    setHeight(0);
    setError(null);
    setStatus({ kind: "idle", text: "等待导入图片" });
    setPreviewUrl((currentUrl) => {
      if (currentUrl) {
        URL.revokeObjectURL(currentUrl);
      }
      return null;
    });
  };

  const handleWidthChange = (value: string) => {
    const nextWidth = normalizeDimension(value, width || 1);
    setWidth(nextWidth);
    if (keepAspectRatio && dimensions) {
      setHeight(Math.max(1, Math.round(nextWidth / (dimensions.width / dimensions.height))));
    }
    setStatus({ kind: "ready", text: "参数已更新，可以导出" });
  };

  const handleHeightChange = (value: string) => {
    const nextHeight = normalizeDimension(value, height || 1);
    setHeight(nextHeight);
    if (keepAspectRatio && dimensions) {
      setWidth(Math.max(1, Math.round(nextHeight * (dimensions.width / dimensions.height))));
    }
    setStatus({ kind: "ready", text: "参数已更新，可以导出" });
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
        inputDataBase64: await fileToBase64(file),
        outputFormat,
        width,
        height,
        keepAspectRatio,
        bitDepth: outputFormat === "bmp" ? bitDepth : null,
        backgroundColor,
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
          <div className="brand-mark" aria-hidden="true">EF</div>
          <div>
            <p className="eyebrow">ENGIFORMAT</p>
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
                if (event.currentTarget === event.target) {
                  setIsDragging(false);
                }
              }}
              onDrop={handleDrop}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  inputRef.current?.click();
                }
              }}
            >
              <div className="drop-icon"><Upload size={22} aria-hidden="true" /></div>
              <strong>拖拽图片到这里</strong>
              <span>或点击选择本地文件</span>
              <small>支持 BMP、PNG、JPG、WEBP 等常见格式</small>
              <input ref={inputRef} type="file" accept="image/*" onChange={handleFileChange} hidden />
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
            <div className="setting-group">
              <label className="field-label">输出格式</label>
              <FormatSelector value={outputFormat} onChange={setOutputFormat} />
            </div>

            <div className="setting-group">
              <div className="label-row">
                <label className="field-label" htmlFor="bit-depth">位深</label>
                {outputFormat !== "bmp" ? <span className="field-note">仅 BMP 支持</span> : null}
              </div>
              <div className="select-wrap">
                <select
                  id="bit-depth"
                  value={bitDepth}
                  disabled={outputFormat !== "bmp"}
                  onChange={(event) => setBitDepth(Number(event.target.value) as BmpBitDepth)}
                >
                  {BMP_BIT_DEPTHS.map((depth) => <option key={depth} value={depth}>{depth} 位</option>)}
                </select>
                <ChevronDown size={15} aria-hidden="true" />
              </div>
            </div>

            <div className="setting-group">
              <div className="label-row">
                <label className="field-label">输出尺寸</label>
                {dimensions ? <span className="field-note">原图 {dimensions.width} × {dimensions.height}</span> : null}
              </div>
              <div className="dimensions-row">
                <label className="dimension-input">
                  <span>宽</span>
                  <input type="number" min="1" max={MAX_DIMENSION} value={width || ""} disabled={!file} onChange={(event) => handleWidthChange(event.target.value)} />
                  <em>px</em>
                </label>
                <span className="dimension-times" aria-hidden="true">×</span>
                <label className="dimension-input">
                  <span>高</span>
                  <input type="number" min="1" max={MAX_DIMENSION} value={height || ""} disabled={!file} onChange={(event) => handleHeightChange(event.target.value)} />
                  <em>px</em>
                </label>
              </div>
              <label className="toggle-row">
                <input type="checkbox" checked={keepAspectRatio} onChange={(event) => setKeepAspectRatio(event.target.checked)} />
                <span className="toggle-track" aria-hidden="true"><span /></span>
                <span>保持比例</span>
              </label>
            </div>

            <div className="setting-group">
              <div className="label-row">
                <label className="field-label" htmlFor="background-color">背景色</label>
                <span className="field-note">透明区域填充色</span>
              </div>
              <label className="color-control" htmlFor="background-color">
                <input id="background-color" type="color" value={backgroundColor} onChange={(event) => setBackgroundColor(event.target.value.toUpperCase())} />
                <span>{backgroundColor}</span>
              </label>
            </div>
          </div>

          <div className="panel-footer">
            <div className={`status-message status-${status.kind}`} role={status.kind === "error" ? "alert" : "status"}>
              <span className="status-indicator" aria-hidden="true" />
              <span>{status.text}</span>
            </div>
            {error ? <p className="error-message">{error}</p> : null}
            <button className="export-button" type="button" disabled={!file || status.kind === "busy"} onClick={() => void handleExport()}>
              <Download size={17} aria-hidden="true" />
              {status.kind === "busy" ? "处理中…" : `导出 ${getOutputLabel(outputFormat)}`}
            </button>
          </div>
        </div>
      </section>

      <footer className="converter-footer">
        <span>EngiFormat · 图片转换工具</span>
        <span className="footer-contract">输出由桌面端 <code>export_image</code> 命令处理</span>
      </footer>
    </main>
  );
}
