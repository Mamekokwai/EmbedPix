import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChangeEvent, DragEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  Check,
  Download,
  Image as ImageIcon,
  Plus,
  Upload,
  X,
} from "lucide-react";
import {
  exportImage,
  isTauriEnvironment,
  pickImageFiles,
  pickOutputDirectory,
  readImageFile,
  type NativeImageFile,
} from "../../platform/image/imageExportGateway";
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
  getExportSafetyPlan,
  getBatchExportStatus,
  formatExportSafetyConfirmation,
  getMissingSourcePathFileName,
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
  OutputLocation,
  RowAlignment,
  RowOrder,
} from "./types";
import ThemeSelect from "../../shared/components/ThemeSelect";

interface ImageConverterProps {
  defaultOutputFormat?: OutputFormat;
  defaultJpegQuality?: number;
  defaultBitDepth?: BmpBitDepth;
  defaultByteOrder?: ByteOrder;
  defaultChannelOrder?: ChannelOrder;
  defaultRowOrder?: RowOrder;
  defaultRowAlignment?: RowAlignment;
  defaultCArrayName?: string;
  defaultBackgroundColor?: string;
  defaultKeepAspectRatio?: boolean;
  active?: boolean;
}

type Status =
  | { kind: "idle"; text: string }
  | { kind: "ready"; text: string }
  | { kind: "busy"; text: string }
  | { kind: "success"; text: string }
  | { kind: "error"; text: string };

type FileWithPath = File & { path?: string };

interface LoadedImage {
  id: string;
  file: File;
  sourcePath: string | null;
  previewUrl: string;
  dimensions: ImageDimensions;
}

function getSourcePath(file: File): string | null {
  const path = (file as FileWithPath).path;
  return typeof path === "string" && path.trim() ? path.trim() : null;
}

function createNativeFile(source: NativeImageFile): File {
  const file = new File([new Uint8Array(source.data)], source.fileName);
  Object.defineProperty(file, "path", { configurable: false, enumerable: false, value: source.path });
  return file;
}

function getSubdirectoryError(value: string): string | null {
  const name = value.trim();
  if (!name) {
    return "请输入子文件夹名称。";
  }
  if (name === "." || name === "..") {
    return "子文件夹名称不能是 . 或 ..。";
  }
  if (/[\\/:*?"<>|\u0000-\u001f]/u.test(name)) {
    return "子文件夹名称不能包含路径分隔符或 Windows 保留字符。";
  }
  return null;
}

function resolveDefaultBitDepth(format: OutputFormat, requested: BmpBitDepth): BmpBitDepth {
  return getBitDepths(format).includes(requested) ? requested : getBitDepths(format)[0] ?? 24;
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
      <ThemeSelect id={id} value={value} options={options} onChange={onChange} aria-label={label} />
    </label>
  );
}

export default function ImageConverter({
  defaultOutputFormat = "bmp",
  defaultJpegQuality = DEFAULT_JPEG_QUALITY,
  defaultBitDepth = 24,
  defaultByteOrder = "little",
  defaultChannelOrder = "rgb",
  defaultRowOrder = "top-down",
  defaultRowAlignment = 1,
  defaultCArrayName = DEFAULT_C_ARRAY_NAME,
  defaultBackgroundColor = "#FFFFFF",
  defaultKeepAspectRatio = true,
  active = true,
}: ImageConverterProps) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<ImageDimensions | null>(null);
  const [loadedImages, setLoadedImages] = useState<LoadedImage[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [widthInput, setWidthInput] = useState("");
  const [heightInput, setHeightInput] = useState("");
  const [outputFormat, setOutputFormat] = useState<OutputFormat>(defaultOutputFormat);
  const [bitDepth, setBitDepth] = useState<BmpBitDepth>(() => resolveDefaultBitDepth(defaultOutputFormat, defaultBitDepth));
  const [jpegQuality, setJpegQuality] = useState(defaultJpegQuality);
  const [byteOrder, setByteOrder] = useState<ByteOrder>(defaultByteOrder);
  const [channelOrder, setChannelOrder] = useState<ChannelOrder>(defaultChannelOrder);
  const [rowOrder, setRowOrder] = useState<RowOrder>(defaultRowOrder);
  const [rowAlignment, setRowAlignment] = useState<RowAlignment>(defaultRowAlignment);
  const [cArrayName, setCArrayName] = useState(defaultCArrayName);
  const [keepAspectRatio, setKeepAspectRatio] = useState(defaultKeepAspectRatio);
  const [backgroundColor, setBackgroundColor] = useState(defaultBackgroundColor.toUpperCase());
  const [outputLocation, setOutputLocation] = useState<OutputLocation>("source");
  const [outputSubdirectory, setOutputSubdirectory] = useState("");
  const [outputDirectory, setOutputDirectory] = useState("");
  const [overwriteSameName, setOverwriteSameName] = useState(false);
  const [deleteSource, setDeleteSource] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "等待导入图片" });
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const loadIdRef = useRef(0);
  const imageIdRef = useRef(0);
  const loadedImagesRef = useRef<LoadedImage[]>([]);
  const replaceImageIdRef = useRef<string | null>(null);
  loadedImagesRef.current = loadedImages;
  const loadNativeImageRef = useRef<(paths?: string[]) => void>(() => undefined);

  useEffect(() => {
    return () => {
      loadIdRef.current += 1;
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      loadedImagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl));
    };
  }, []);

  useEffect(() => {
    if (active) return;
    setOutputFormat(defaultOutputFormat);
    setBitDepth(resolveDefaultBitDepth(defaultOutputFormat, defaultBitDepth));
    setJpegQuality(defaultJpegQuality);
    setByteOrder(defaultByteOrder);
    setChannelOrder(defaultChannelOrder);
    setRowOrder(defaultRowOrder);
    setRowAlignment(defaultRowAlignment);
    setCArrayName(normalizeCArrayName(defaultCArrayName));
    setKeepAspectRatio(defaultKeepAspectRatio);
    setBackgroundColor(defaultBackgroundColor.toUpperCase());
  }, [active, defaultBackgroundColor, defaultBitDepth, defaultByteOrder, defaultCArrayName, defaultChannelOrder, defaultJpegQuality, defaultKeepAspectRatio, defaultOutputFormat, defaultRowAlignment, defaultRowOrder]);

  const widthError = file ? getDimensionError(widthInput, "宽度") : null;
  const heightError = file ? getDimensionError(heightInput, "高度") : null;
  const dimensionError = widthError ?? heightError ?? (file ? getPixelError(widthInput, heightInput) : null);
  const errorMessage = dimensionError ?? error;

  const outputLocationError = useMemo(() => {
    if (!file) {
      return null;
    }
    if (isTauriEnvironment()
      && (outputLocation === "source" || outputLocation === "subfolder" || outputLocation === "original")
      && loadedImages.some((image) => !image.sourcePath)) {
      return outputLocation === "original"
        ? "覆盖原图需要可用的源文件路径，请重新导入图片。"
        : "当前导入方式没有可用的源文件路径，请改用“指定目录”。";
    }
    if (outputLocation === "subfolder") {
      return getSubdirectoryError(outputSubdirectory);
    }
    if (outputLocation === "directory" && !outputDirectory.trim()) {
      return "请输入输出目录。";
    }
    return null;
  }, [file, loadedImages, outputDirectory, outputLocation, outputSubdirectory]);
  const outputLocationDescription = [
    "output-location-help",
    outputLocation === "original" ? "output-original-help" : null,
    outputLocationError ? "output-location-error" : null,
  ].filter(Boolean).join(" ");
  const batchOutputLocationError = useMemo(() => {
    if (outputLocationError
      || !isTauriEnvironment()
      || !file
      || !["source", "subfolder", "original"].includes(outputLocation)) {
      return outputLocationError;
    }
    const missingPathFileName = getMissingSourcePathFileName(outputLocation, loadedImages, true);
    return missingPathFileName
      ? `“${missingPathFileName}”没有可用的源文件路径，请改用“指定目录”。`
      : null;
  }, [file, loadedImages, outputLocation, outputLocationError]);

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

  const activateLoadedImage = (image: LoadedImage, resetDeleteSource = true) => {
    setFile(image.file);
    setPreviewUrl(image.previewUrl);
    setDimensions(image.dimensions);
    const targetDimensions = constrainDimensions(image.dimensions);
    setWidth(targetDimensions.width);
    setHeight(targetDimensions.height);
    setWidthInput(String(targetDimensions.width));
    setHeightInput(String(targetDimensions.height));
    if (resetDeleteSource) {
      setDeleteSource(false);
    }
    previewUrlRef.current = image.previewUrl;
    setStatus({ kind: "ready", text: "图片已载入，可以导出" });
  };

  const loadFile = async (nextFile: File, replaceImageId: string | null = null) => {
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
        previewUrlRef.current = null;
      }
      const nextImage: LoadedImage = {
        id: `image-${imageIdRef.current += 1}`,
        file: nextFile,
        sourcePath: getSourcePath(nextFile),
        previewUrl: nextPreviewUrl,
        dimensions: nextDimensions,
      };
      setLoadedImages((current) => {
        if (!replaceImageId) {
          return [...current, nextImage];
        }
        const replacedImage = current.find((image) => image.id === replaceImageId);
        if (!replacedImage) {
          return [...current, nextImage];
        }
        URL.revokeObjectURL(replacedImage.previewUrl);
        return current.map((image) => image.id === replaceImageId ? nextImage : image);
      });
      setSelectedImageId(nextImage.id);
      activateLoadedImage(nextImage);
      return true;
    } catch (loadError) {
      if (loadId !== loadIdRef.current) {
        return;
      }
      const message = loadError instanceof Error ? loadError.message : "图片读取失败，请重试。";
      setStatus({ kind: "error", text: "读取失败" });
      setError(message);
      return false;
    }
  };

  const loadFiles = async (files: File[], replaceImageId: string | null = null) => {
    const initialCount = loadedImagesRef.current.length;
    const replacingExistingImage = replaceImageId !== null
      && loadedImagesRef.current.some((image) => image.id === replaceImageId);
    let loadedCount = 0;
    for (const [index, nextFile] of files.entries()) {
      if (await loadFile(nextFile, index === 0 ? replaceImageId : null)) {
        loadedCount += 1;
      }
    }
    replaceImageIdRef.current = null;
    if (loadedCount > 0) {
      setStatus({
        kind: "ready",
        text: `${initialCount + loadedCount - (replacingExistingImage ? 1 : 0)} 张图片已载入，可以导出`,
      });
    }
  };

  const loadNativeImages = async (paths?: string[], replaceImageId: string | null = null) => {
    try {
      const sources: NativeImageFile[] = [];
      if (paths) {
        for (const path of paths) {
          sources.push(await readImageFile(path));
        }
      } else {
        sources.push(...await pickImageFiles());
      }
      await loadFiles(sources.map(createNativeFile), replaceImageId);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "图片读取失败，请重试。";
      setStatus({ kind: "error", text: "读取失败" });
      setError(message);
      replaceImageIdRef.current = null;
    }
  };

  loadNativeImageRef.current = (paths) => {
    void loadNativeImages(paths);
  };

  useEffect(() => {
    if (!active || !isTauriEnvironment()) {
      setIsDragging(false);
      return;
    }

    let unlisten: (() => void) | undefined;
    try {
      void getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setIsDragging(true);
        } else if (event.payload.type === "leave") {
          setIsDragging(false);
        } else {
          setIsDragging(false);
          if (event.payload.paths.length > 0) {
            loadNativeImageRef.current(event.payload.paths);
          }
        }
      }).then((cleanup) => {
        unlisten = cleanup;
      }).catch(() => undefined);
    } catch {
      return undefined;
    }
    return () => unlisten?.();
  }, [active]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFiles = Array.from(event.target.files ?? []);
    if (nextFiles.length > 0) {
      void loadFiles(nextFiles, replaceImageIdRef.current);
    }
    event.target.value = "";
  };

  const handleSelectImage = (replaceImageId: string | null = null) => {
    replaceImageIdRef.current = replaceImageId;
    if (isTauriEnvironment()) {
      void loadNativeImages(undefined, replaceImageId);
    } else {
      inputRef.current?.click();
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const nextFiles = Array.from(event.dataTransfer.files);
    if (nextFiles.length > 0) {
      void loadFiles(nextFiles);
    }
  };

  const removeImage = (imageId: string) => {
    const removedImage = loadedImages.find((image) => image.id === imageId);
    if (!removedImage) {
      return;
    }

    URL.revokeObjectURL(removedImage.previewUrl);
    const remainingImages = loadedImages.filter((image) => image.id !== imageId);
    setLoadedImages(remainingImages);

    if (selectedImageId !== imageId) {
      return;
    }

    const nextImage = remainingImages[remainingImages.length - 1];
    if (nextImage) {
      setSelectedImageId(nextImage.id);
      activateLoadedImage(nextImage);
      return;
    }

    setSelectedImageId(null);
    loadIdRef.current += 1;
    setFile(null);
    setDimensions(null);
    setDeleteSource(false);
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

  const clearFile = () => {
    if (selectedImageId) {
      removeImage(selectedImageId);
    }
  };

  const clearAllImages = () => {
    loadIdRef.current += 1;
    loadedImages.forEach((image) => URL.revokeObjectURL(image.previewUrl));
    setLoadedImages([]);
    setSelectedImageId(null);
    setFile(null);
    setDimensions(null);
    setDeleteSource(false);
    setWidth(0);
    setHeight(0);
    setWidthInput("");
    setHeightInput("");
    setError(null);
    setStatus({ kind: "idle", text: "等待导入图片" });
    previewUrlRef.current = null;
    setPreviewUrl(null);
  };

  const selectImage = (imageId: string) => {
    const image = loadedImages.find((item) => item.id === imageId);
    if (!image || image.id === selectedImageId) {
      return;
    }
    setSelectedImageId(image.id);
    activateLoadedImage(image);
    setError(null);
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

  const handleOutputLocationChange = (nextLocation: OutputLocation) => {
    setOutputLocation(nextLocation);
    if (nextLocation === "original") {
      setOverwriteSameName(false);
      setDeleteSource(false);
    }
    setError(null);
  };

  const handlePickOutputDirectory = async () => {
    const previousDirectory = outputDirectory;
    setError(null);
    setStatus({ kind: "busy", text: "正在选择输出目录…" });
    try {
      const selectedDirectory = await pickOutputDirectory();
      if (!selectedDirectory) {
        setStatus({
          kind: "ready",
          text: previousDirectory.trim() ? "已保留当前输出目录" : "未选择输出目录",
        });
        return;
      }
      setOutputDirectory(selectedDirectory);
      setStatus({ kind: "ready", text: "已选择输出目录" });
    } catch (pickError) {
      const message = pickError instanceof Error ? pickError.message : "无法选择输出目录，请重试。";
      setError(message);
      setStatus({ kind: "error", text: "选择输出目录失败" });
    }
  };

  const handleDeleteSourceChange = (checked: boolean) => {
    setDeleteSource(checked);
    setError(null);
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

    if (batchOutputLocationError) {
      setError(batchOutputLocationError);
      setStatus({ kind: "error", text: "请检查输出位置" });
      return;
    }

    const safetyPlan = getExportSafetyPlan(loadedImages, {
      outputFormat,
      outputLocation,
      outputSubdirectory,
      outputDirectory,
      overwriteSameName,
      deleteSource,
    });
    const confirmationMessage = formatExportSafetyConfirmation(safetyPlan);
    if (confirmationMessage && !window.confirm(confirmationMessage)) {
      setError(null);
      setStatus({ kind: "ready", text: "已取消导出，文件未改变" });
      return;
    }

    setError(null);
    let lastOutputPath: string | null = null;
    let completedCount = 0;
    const failures: string[] = [];
    for (const [index, image] of loadedImages.entries()) {
      setStatus({ kind: "busy", text: `正在导出 ${index + 1}/${loadedImages.length} 张：${image.file.name}` });
      try {
        const targetDimensions = keepAspectRatio
          ? constrainAspectDimensions("width", width, image.dimensions)
          : { width, height };
        const request: ExportImageRequest = {
          fileName: image.file.name,
          inputData: new Uint8Array(await image.file.arrayBuffer()),
          outputFormat,
          width: targetDimensions.width,
          height: targetDimensions.height,
          keepAspectRatio,
          bitDepth: getEffectiveBitDepth(outputFormat, bitDepth),
          backgroundColor,
          jpegQuality,
          byteOrder,
          channelOrder,
          rowOrder,
          rowAlignment,
          cArrayName: normalizeCArrayName(cArrayName),
          outputLocation,
          sourcePath: image.sourcePath,
          outputSubdirectory: outputSubdirectory.trim() || undefined,
          outputDirectory: outputDirectory.trim() || undefined,
          overwriteSameName,
          deleteSource,
        };
        lastOutputPath = await exportImage(request);
        completedCount += 1;
      } catch (exportError) {
        const message = exportError instanceof Error ? exportError.message : "导出失败，请重试。";
        failures.push(`${image.file.name}：${message}`);
      }
    }

    if (failures.length > 0) {
      setStatus({ kind: "error", text: `已导出 ${completedCount}/${loadedImages.length} 张` });
      setError(failures.join("\n"));
    } else {
      setStatus({
        kind: "success",
        text: getBatchExportStatus(completedCount, loadedImages.length, lastOutputPath),
      });
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
          <p className="intro-copy">导入一张或多张图片，统一调整尺寸与输出规格，然后导出到本地文件。</p>
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
              <button className="icon-button" type="button" onClick={clearFile} aria-label="移除当前图片" title="移除当前图片">
                <X size={16} aria-hidden="true" />
              </button>
            ) : null}
          </div>

          <input ref={inputRef} type="file" accept={SUPPORTED_IMAGE_ACCEPT} onChange={handleFileChange} multiple hidden />

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
              onClick={() => handleSelectImage()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handleSelectImage();
                }
              }}
              aria-label="拖拽图片到这里，或按 Enter 选择本地文件"
            >
              <div className="drop-icon"><Upload size={22} aria-hidden="true" /></div>
              <strong>拖拽图片到这里</strong>
              <span>或点击选择一个或多个本地文件</span>
              <small>支持 {SUPPORTED_IMAGE_FORMAT_LABEL}</small>
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
                <div className="file-summary-actions">
                  <span className="file-ready"><Check size={14} aria-hidden="true" /> 已载入</span>
                  <button
                    className="quiet-button file-replace-button"
                    type="button"
                    onClick={() => handleSelectImage(selectedImageId)}
                  >
                    更换
                  </button>
                </div>
              </div>
              <div className="file-list-toolbar">
                <span className="file-count">已导入 {loadedImages.length} 张</span>
                <div className="file-list-actions">
                  <button className="quiet-button file-add-button" type="button" onClick={() => handleSelectImage()}>
                    <Plus size={14} aria-hidden="true" />
                    继续添加
                  </button>
                  {loadedImages.length > 1 ? (
                    <button className="quiet-button file-clear-button" type="button" onClick={clearAllImages}>清空列表</button>
                  ) : null}
                </div>
              </div>
              {loadedImages.length > 1 ? (
                <div className="file-list" role="listbox" aria-label="已导入图片列表">
                  {loadedImages.map((image) => (
                    <div className={`file-list-item${image.id === selectedImageId ? " file-list-item-selected" : ""}`} key={image.id}>
                      <button
                        className="file-list-select"
                        type="button"
                        role="option"
                        aria-selected={image.id === selectedImageId}
                        onClick={() => selectImage(image.id)}
                      >
                        <span className="file-list-icon"><ImageIcon size={14} aria-hidden="true" /></span>
                        <span className="file-list-copy">
                          <strong title={image.file.name}>{image.file.name}</strong>
                          <small>{image.dimensions.width} × {image.dimensions.height} px · {formatFileSize(image.file.size)}</small>
                        </span>
                      </button>
                      <button className="icon-button file-remove-button" type="button" onClick={() => removeImage(image.id)} aria-label={`移除 ${image.file.name}`} title="移除这张图片">
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
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

            <details className="settings-module">
              <summary>画面与像素参数</summary>
              <div className="settings-module-body">
            <div className="setting-group">
              <div className="label-row">
                <label className="field-label" htmlFor="bit-depth">位深</label>
                <span className="field-note">{outputFormat === "jpg" ? "JPG 固定 24 位" : isRawPixelFormat(outputFormat) ? "RGB565 固定 16 位" : `${getBitDepths(outputFormat).join(" / ")} 位可选`}</span>
              </div>
              <ThemeSelect
                id="bit-depth"
                value={bitDepth}
                options={getBitDepths(outputFormat).map((depth) => ({ value: depth, label: `${depth} 位` }))}
                disabled={outputFormat === "jpg" || isRawPixelFormat(outputFormat)}
                aria-label="位深"
                aria-describedby="bit-depth-description"
                onChange={handleBitDepthChange}
              />
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
              </details>

              <details className="settings-module">
                <summary>输出位置与文件处理</summary>
                <div className="settings-module-body">
            <div className="setting-group output-location-group">
              <div className="label-row">
                <label className="field-label" htmlFor="output-location">输出位置</label>
                <span className="field-note">导出后自动使用对应目录</span>
              </div>
              <ThemeSelect
                id="output-location"
                value={outputLocation}
                options={[
                  { value: "source" as const, label: "源文件夹" },
                  { value: "subfolder" as const, label: "源文件夹 / 子文件夹" },
                  { value: "directory" as const, label: "指定目录" },
                  { value: "original" as const, label: "覆盖原图" },
                ]}
                aria-label="输出位置"
                aria-describedby={outputLocationDescription}
                aria-invalid={Boolean(outputLocationError)}
                onChange={handleOutputLocationChange}
              />
              {outputLocation === "subfolder" ? (
                <label className="text-field" htmlFor="output-subdirectory">
                  <span>子文件夹名称</span>
                  <input
                    id="output-subdirectory"
                    value={outputSubdirectory}
                    aria-describedby={outputLocationDescription}
                    aria-invalid={Boolean(outputLocationError)}
                    onChange={(event) => { setOutputSubdirectory(event.target.value); setError(null); }}
                    placeholder="例如 export"
                    spellCheck={false}
                  />
                </label>
              ) : null}
              {outputLocation === "directory" ? (
                <label className="text-field" htmlFor="output-directory">
                  <span>输出目录</span>
                  <div className="path-input-row">
                    <input
                      id="output-directory"
                      value={outputDirectory}
                      aria-describedby={outputLocationDescription}
                      aria-invalid={Boolean(outputLocationError)}
                      onChange={(event) => { setOutputDirectory(event.target.value); setError(null); }}
                      placeholder="例如 D:\\Images\\Export"
                      spellCheck={false}
                    />
                    <button
                      className="quiet-button path-input-picker"
                      type="button"
                      disabled={!isTauriEnvironment() || status.kind === "busy"}
                      onClick={() => void handlePickOutputDirectory()}
                      title={isTauriEnvironment() ? "使用系统对话框选择目录" : "仅桌面应用支持目录选择"}
                    >
                      选择目录
                    </button>
                  </div>
                </label>
              ) : null}
              <p className="field-help" id="output-location-help">
                {outputLocation === "source"
                  ? "直接保存到源图片所在文件夹。"
                  : outputLocation === "subfolder"
                    ? "子文件夹不存在时会自动创建。"
                    : outputLocation === "directory"
                      ? "目录不存在时会自动创建，支持绝对路径。"
                      : "替换源图片并保留旧文件备份。"}
              </p>
              {outputLocationError ? <p className="error-message output-location-error" id="output-location-error" role="alert">{outputLocationError}</p> : null}
              {outputLocation === "original" ? (
                <p className="field-help output-action-help output-action-info" id="output-original-help">导出前会列出将被覆盖的目标和待备份源文件并要求确认；旧图片会先移入同目录的 bak 文件夹，再将新文件写回原图位置。</p>
              ) : (
                <div className="output-actions">
                  <div className="output-action">
                    <label className="toggle-row output-action-toggle">
                      <input type="checkbox" checked={overwriteSameName} aria-describedby="overwrite-same-name-help" onChange={(event) => { setOverwriteSameName(event.target.checked); setError(null); }} />
                      <span className="toggle-track" aria-hidden="true"><span /></span>
                      <span>覆盖同名输出文件</span>
                    </label>
                    <p className="field-help output-action-help" id="overwrite-same-name-help">导出前会列出目标文件并要求确认；已有同名输出会直接覆盖，不移动到 bak 文件夹。</p>
                  </div>
                  <div className="output-action">
                    <label className="toggle-row output-action-toggle">
                      <input type="checkbox" checked={deleteSource} aria-describedby="delete-source-help" onChange={(event) => handleDeleteSourceChange(event.target.checked)} />
                      <span className="toggle-track" aria-hidden="true"><span /></span>
                      <span>导出成功后删除源图片</span>
                    </label>
                    <p className="field-help output-action-help output-action-danger" id="delete-source-help">导出前会列出待删除源文件并要求确认；只有对应输出成功后才会删除。</p>
                  </div>
                </div>
              )}
            </div>
                </div>
              </details>

          </div>

          <div className="panel-footer">
            <div className="footer-status">
              <div className={`status-message status-${status.kind}`} role="status" aria-live="polite">
                <span className="status-indicator" aria-hidden="true" />
                <span>{status.text}</span>
              </div>
              {errorMessage ? <p className="error-message" id="dimension-error" role="alert">{errorMessage}</p> : null}
            </div>
            <button className="export-button" type="button" disabled={!file || status.kind === "busy" || Boolean(dimensionError) || Boolean(batchOutputLocationError)} aria-busy={status.kind === "busy"} onClick={() => void handleExport()}>
              <Download size={17} aria-hidden="true" />
              {status.kind === "busy" ? "处理中…" : `导出 ${getOutputLabel(outputFormat)}`}
            </button>
          </div>
        </div>
      </section>

      <footer className="converter-footer">
        <span>EmbedPix · 嵌图匠</span>
      </footer>
    </main>
  );
}
