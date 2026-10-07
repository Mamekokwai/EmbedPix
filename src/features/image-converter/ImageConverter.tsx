import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChangeEvent, CSSProperties, DragEvent, KeyboardEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  Check,
  Download,
  Image as ImageIcon,
  Images,
  Plus,
  Upload,
  X,
} from "lucide-react";
import {
  exportImage,
  isTauriEnvironment,
  pickImageFiles,
  pickImageDirectory,
  pickOutputDirectory,
  preflightImageExports,
  previewImageExport,
  readImageFile,
  revealImageOutput,
  type NativeImageFile,
} from "../../platform/image/imageExportGateway";
import type { ImageExportPreflightResult } from "../../platform/image/imageExportGateway";
import type { ExportImageResponse, ImagePreviewResponse } from "./types";
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
  formatImageConverterError,
  formatMebibytes,
  getImagePreviewComparison,
  estimateImageExportBytesForDimensions,
  getCropPreviewLayout,
  getBitDepthNote,
  getBitDepths,
  getDimensionError,
  getEffectiveBitDepth,
  getFormatInfo,
  getOutputLabel,
  getOutputParameterNote,
  getExportSafetyPlan,
  getExportPreflight,
  getCropInputValidation,
  getTransformedSourceDimensions,
  formatExportSafetyConfirmation,
  getMissingSourcePathFileName,
  getPixelError,
  getSubdirectoryError,
  normalizeSubdirectoryPath,
  isCArrayFormat,
  isImageFile,
  isRawPixelFormat,
  normalizeDimension,
  normalizeCArrayName,
  parseCropInput,
  parseDimension,
} from "./imageConverterLogic";
import { inspectEmbeddedOutput } from "./embeddedOutputInspector";
import type {
  ByteOrder,
  ChannelOrder,
  ExportImageRequest,
  ImageDimensions,
  ImageRotation,
  ImageTransform,
  BmpBitDepth,
  OutputFormat,
  OutputLocation,
  RowAlignment,
  RowOrder,
} from "./types";
import ThemeSelect from "../../shared/components/ThemeSelect";
import { formatExportFailureDetails, formatExportOutputPaths, formatExportQueueProgress, formatExportQueueSummary, runExportQueue } from "./imageExportQueue";
import type { ExportFailureDetail, ExportQueueProgress } from "./imageExportQueue";
import type { ExportPreflightResult } from "./imageConverterLogic";
import { DEFAULT_FILE_NAME_TEMPLATE, formatBatchConversionPlanError, planBatchConversions } from "./batchConversionPlan";
import type { BatchConversionPlan } from "./batchConversionPlan";
import { exportWorkspace, formatWorkspaceTransferError, importWorkspace } from "../../shared/workspaceTransfer";
import { downloadBlob } from "../../shared/downloadBlob";
import { readImageDimensions } from "./imageDimensions";

type ImageExportQueueProgress = ExportQueueProgress<{ file: { name: string } }>;

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

function resolveDefaultBitDepth(format: OutputFormat, requested: BmpBitDepth): BmpBitDepth {
  return getBitDepths(format).includes(requested) ? requested : getBitDepths(format)[0] ?? 24;
}

interface CropInputs {
  x: string;
  y: string;
  width: string;
  height: string;
}

function getFullImageCropInputs(source: ImageDimensions | null): CropInputs {
  return {
    x: "0",
    y: "0",
    width: source ? String(source.width) : "",
    height: source ? String(source.height) : "",
  };
}


function FormatSelector({
  value,
  onChange,
  describedBy,
}: {
  value: OutputFormat;
  onChange: (value: OutputFormat) => void;
  describedBy?: string;
}) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  return (
    <div className="format-selector" role="radiogroup" aria-label="输出格式" aria-describedby={describedBy}>
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
  const [fillTransparent, setFillTransparent] = useState(false);
  const [rotation, setRotation] = useState<ImageRotation>(0);
  const [flipHorizontal, setFlipHorizontal] = useState(false);
  const [flipVertical, setFlipVertical] = useState(false);
  const [cropEnabled, setCropEnabled] = useState(false);
  const [cropInputs, setCropInputs] = useState<CropInputs>(() => getFullImageCropInputs(null));
  const [livePreview, setLivePreview] = useState(true);
  const [appliedPreviewTransform, setAppliedPreviewTransform] = useState<ImageTransform>({ rotation: 0, flipHorizontal: false, flipVertical: false, crop: null });
  const [pixelSettingsOpen, setPixelSettingsOpen] = useState(false);
  const [outputSettingsOpen, setOutputSettingsOpen] = useState(false);
  const [outputLocation, setOutputLocation] = useState<OutputLocation>("source");
  const [outputSubdirectory, setOutputSubdirectory] = useState("");
  const [outputDirectory, setOutputDirectory] = useState("");
  const [fileNameTemplate, setFileNameTemplate] = useState(DEFAULT_FILE_NAME_TEMPLATE);
  const [renameEnabled, setRenameEnabled] = useState(false);
  const [overwriteSameName, setOverwriteSameName] = useState(false);
  const [deleteSource, setDeleteSource] = useState(false);
  const [metadataPolicy, setMetadataPolicy] = useState<"strip" | "preserve">("strip");
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "等待导入图片" });
  const [error, setError] = useState<string | null>(null);
  const [failedExportIds, setFailedExportIds] = useState<string[]>([]);
  const [exportFailures, setExportFailures] = useState<ExportFailureDetail[]>([]);
  const [exportPreflight, setExportPreflight] = useState<ExportPreflightResult | null>(null);
  const [nativePreflightStatus, setNativePreflightStatus] = useState<string | null>(null);
  const [actualExportResult, setActualExportResult] = useState<ExportImageResponse | null>(null);
  const [exportOutputPaths, setExportOutputPaths] = useState<string[]>([]);
  const [realPreview, setRealPreview] = useState<ImagePreviewResponse | null>(null);
  const [realPreviewUrl, setRealPreviewUrl] = useState<string | null>(null);
  const [realPreviewError, setRealPreviewError] = useState<string | null>(null);
  const [failureDetailsOpen, setFailureDetailsOpen] = useState(false);
  const [exportProgress, setExportProgress] = useState<ImageExportQueueProgress | null>(null);
  const [exportPaused, setExportPaused] = useState(false);
  const exportCancelRef = useRef(false);
  const exportPauseRef = useRef(false);
  const exportResumeRef = useRef<(() => void) | null>(null);
  const exportCancelWaitRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const workspaceInputRef = useRef<HTMLInputElement>(null);
  const previewUrlRef = useRef<string | null>(null);
  const realPreviewUrlRef = useRef<string | null>(null);
  const loadIdRef = useRef(0);
  const dimensionControllerRef = useRef<AbortController | null>(null);
  const imageIdRef = useRef(0);
  const loadedImagesRef = useRef<LoadedImage[]>([]);
  const replaceImageIdRef = useRef<string | null>(null);
  loadedImagesRef.current = loadedImages;
  const loadNativeImageRef = useRef<(paths?: string[]) => void>(() => undefined);
  const loadFilesRef = useRef<(files: File[], replaceImageId?: string | null) => Promise<void>>(async () => undefined);

  useEffect(() => {
    return () => {
      loadIdRef.current += 1;
      dimensionControllerRef.current?.abort();
      dimensionControllerRef.current = null;
      exportCancelRef.current = true;
      exportPauseRef.current = false;
      exportCancelWaitRef.current?.();
      exportResumeRef.current = null;
      exportCancelWaitRef.current = null;
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      if (realPreviewUrlRef.current) {
        URL.revokeObjectURL(realPreviewUrlRef.current);
        realPreviewUrlRef.current = null;
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
    setRotation(0);
    setFlipHorizontal(false);
    setFlipVertical(false);
    setCropEnabled(false);
    setCropInputs(getFullImageCropInputs(null));
  }, [active, defaultBackgroundColor, defaultBitDepth, defaultByteOrder, defaultCArrayName, defaultChannelOrder, defaultJpegQuality, defaultKeepAspectRatio, defaultOutputFormat, defaultRowAlignment, defaultRowOrder]);

  const widthError = file ? getDimensionError(widthInput, "宽度") : null;
  const heightError = file ? getDimensionError(heightInput, "高度") : null;
  const dimensionError = widthError ?? heightError ?? (file ? getPixelError(widthInput, heightInput) : null);
  const cropValidationError = file && cropEnabled ? getCropInputValidation(cropInputs, dimensions) : null;
  const errorMessage = dimensionError ?? cropValidationError ?? error;
  const imageTransform: ImageTransform = useMemo(() => ({
    rotation,
    flipHorizontal,
    flipVertical,
    crop: cropEnabled
      ? {
          x: parseCropInput(cropInputs.x) ?? 0,
          y: parseCropInput(cropInputs.y) ?? 0,
          width: parseCropInput(cropInputs.width) ?? 0,
          height: parseCropInput(cropInputs.height) ?? 0,
        }
      : null,
  }), [cropEnabled, cropInputs.height, cropInputs.width, cropInputs.x, cropInputs.y, flipHorizontal, flipVertical, rotation]);
  const previewTransform = livePreview ? imageTransform : appliedPreviewTransform;
  const previewTransformDirty = JSON.stringify(imageTransform) !== JSON.stringify(appliedPreviewTransform);
  const transformedSourceDimensions = dimensions
    ? getTransformedSourceDimensions(dimensions, imageTransform)
    : null;
  const hasImageTransform = rotation !== 0 || flipHorizontal || flipVertical || cropEnabled;
  const cropPreview = useMemo(
    () => (previewTransform.crop ? getCropPreviewLayout({ x: String(previewTransform.crop.x), y: String(previewTransform.crop.y), width: String(previewTransform.crop.width), height: String(previewTransform.crop.height) }, dimensions) : null),
    [dimensions, previewTransform.crop],
  );
  const previewAppliedTransforms = [
    cropEnabled && cropPreview ? "裁剪" : null,
    rotation !== 0 ? `旋转 ${rotation}°` : null,
    flipHorizontal ? "水平翻转" : null,
    flipVertical ? "垂直翻转" : null,
  ].filter((value): value is string => Boolean(value));

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
  // 规划失败要把原因露出来：模板/子文件夹的校验（Windows 非法字符、结尾点或空格、过长…）不能让用户对着空白猜。
  const batchPlanResult = useMemo(() => {
    if (!loadedImages.length) return { plan: null, error: null } as { plan: BatchConversionPlan | null; error: string | null };
    try {
      const plan = planBatchConversions(loadedImages.map((image) => ({ name: image.file.name, width: image.dimensions.width, height: image.dimensions.height, sourcePath: image.sourcePath })), { template: fileNameTemplate, outputFormat, outputLocation, outputDirectory, outputSubdirectory });
      return { plan, error: null };
    } catch (error) {
      return { plan: null, error: formatBatchConversionPlanError(error) };
    }
  }, [fileNameTemplate, loadedImages, outputDirectory, outputFormat, outputLocation, outputSubdirectory]);
  const batchPlan = batchPlanResult.plan;

  const setSettingStatus = (nextWidthInput = widthInput, nextHeightInput = heightInput) => {
    if (!file) {
      return;
    }

    const nextDimensionError = getDimensionError(nextWidthInput, "宽度") ?? getDimensionError(nextHeightInput, "高度") ?? getPixelError(nextWidthInput, nextHeightInput);
    setStatus(nextDimensionError ? { kind: "error", text: "请检查输出尺寸" } : { kind: "ready", text: "参数已更新，可以导出" });
  };

  const outputSummary = useMemo(() => {
    if (!file) {
      return "";
    }

    const summaryBitDepth = getEffectiveBitDepth(outputFormat, bitDepth);
    return `${width} × ${height} · ${getOutputLabel(outputFormat)} · ${summaryBitDepth} 位`;
  }, [bitDepth, file, height, outputFormat, width]);

  const embeddedInspection = useMemo(() => {
    if (!file || !["bmp", "rgb565", "c-array"].includes(outputFormat)) return null;
    try {
      return inspectEmbeddedOutput({ outputFormat, width, height, bitDepth, byteOrder, channelOrder, rowOrder, rowAlignment });
    } catch {
      return null;
    }
  }, [bitDepth, byteOrder, channelOrder, file, height, outputFormat, rowAlignment, rowOrder, width]);
  const outputPreviewComparison = useMemo(
    () => getImagePreviewComparison(outputFormat, width, height, bitDepth, backgroundColor),
    [backgroundColor, bitDepth, height, outputFormat, width],
  );

  useEffect(() => {
    setExportPreflight(null);
    setNativePreflightStatus(null);
  }, [bitDepth, deleteSource, file, fileNameTemplate, height, imageTransform, keepAspectRatio, loadedImages, outputDirectory, outputLocation, outputSubdirectory, outputFormat, overwriteSameName, width]);

  useEffect(() => {
    let cancelled = false;
    const requestPreview = async () => {
      if (realPreviewUrlRef.current) URL.revokeObjectURL(realPreviewUrlRef.current);
      realPreviewUrlRef.current = null;
      setRealPreviewUrl(null);
      if (!active || !file || !dimensions || !isTauriEnvironment() || dimensionError || cropValidationError) {
        setRealPreview(null);
        setRealPreviewError(active && !isTauriEnvironment() && file ? "桌面真实编码预览仅在 Tauri 应用中可用。" : null);
        return;
      }
      setRealPreviewError(null);
      try {
        const targetSourceDimensions = getTransformedSourceDimensions(dimensions, previewTransform);
        const targetDimensions = keepAspectRatio
          ? constrainAspectDimensions("width", width, targetSourceDimensions)
          : { width, height };
        const response = await previewImageExport({
          fileName: file.name,
          inputData: new Uint8Array(await file.arrayBuffer()),
          outputFormat,
          width: targetDimensions.width,
          height: targetDimensions.height,
          keepAspectRatio,
          bitDepth: getEffectiveBitDepth(outputFormat, bitDepth),
          backgroundColor,
          fillTransparent,
          jpegQuality,
          byteOrder,
          channelOrder,
          rowOrder,
          rowAlignment,
          cArrayName: normalizeCArrayName(cArrayName),
          transform: previewTransform,
          metadataPolicy,
        });
        if (cancelled) return;
        const visualFormat = response.format === "png" || response.format === "jpg" || response.format === "bmp";
        if (visualFormat) {
          const url = URL.createObjectURL(new Blob([new Uint8Array(response.data)], { type: `image/${response.format === "jpg" ? "jpeg" : response.format}` }));
          realPreviewUrlRef.current = url;
          setRealPreviewUrl(url);
        } else {
          setRealPreviewUrl(null);
        }
        setRealPreview(response);
      } catch (previewError) {
        if (cancelled) return;
        setRealPreviewUrl(null);
        setRealPreview(null);
        setRealPreviewError(formatImageConverterError(previewError));
      }
    };
    void requestPreview();
    return () => { cancelled = true; };
  }, [active, backgroundColor, bitDepth, byteOrder, channelOrder, cArrayName, cropValidationError, dimensions, file, fillTransparent, height, previewTransform, jpegQuality, keepAspectRatio, metadataPolicy, outputFormat, rowAlignment, rowOrder, width, dimensionError]);

  const resetImageTransform = (source: ImageDimensions | null = dimensions) => {
    setRotation(0);
    setFlipHorizontal(false);
    setFlipVertical(false);
    setCropEnabled(false);
    setCropInputs(getFullImageCropInputs(source));
  };

  const updateTransformStatus = (nextCropInputs = cropInputs, nextCropEnabled = cropEnabled) => {
    const nextError = nextCropEnabled ? getCropInputValidation(nextCropInputs, dimensions) : null;
    setError(null);
    setStatus(nextError ? { kind: "error", text: "请检查编辑参数" } : { kind: "ready", text: "参数已更新，可以导出" });
  };

  const clearExportResults = () => {
    setActualExportResult(null);
    setExportOutputPaths([]);
    setExportFailures([]);
    setFailedExportIds([]);
    setExportPreflight(null);
    setNativePreflightStatus(null);
    setFailureDetailsOpen(false);
    setExportProgress(null);
  };

  const activateLoadedImage = (image: LoadedImage, resetDeleteSource = true) => {
    clearExportResults();
    setFile(image.file);
    setPreviewUrl(image.previewUrl);
    setDimensions(image.dimensions);
    const targetDimensions = constrainDimensions(image.dimensions);
    setWidth(targetDimensions.width);
    setHeight(targetDimensions.height);
    setWidthInput(String(targetDimensions.width));
    setHeightInput(String(targetDimensions.height));
    resetImageTransform(image.dimensions);
    if (resetDeleteSource) {
      setDeleteSource(false);
    }
    previewUrlRef.current = image.previewUrl;
    setStatus({ kind: "ready", text: "图片已载入，可以导出" });
  };

  const loadFile = async (nextFile: File, replaceImageId: string | null = null) => {
    const loadId = loadIdRef.current + 1;
    loadIdRef.current = loadId;
    dimensionControllerRef.current?.abort();
    dimensionControllerRef.current = null;
    clearExportResults();
    setError(null);
    setStatus({ kind: "busy", text: "正在读取图片…" });

    if (!isImageFile(nextFile)) {
      setStatus({ kind: "error", text: "文件格式不支持" });
      setError(`请选择 ${SUPPORTED_IMAGE_FORMAT_LABEL} 文件。`);
      return false;
    }

    if (nextFile.size > MAX_INPUT_BYTES) {
      setStatus({ kind: "error", text: "文件过大，无法读取" });
      setError(`图片文件不能超过 32 MiB，当前为 ${formatMebibytes(nextFile.size)}。`);
      return false;
    }

    const dimensionController = new AbortController();
    dimensionControllerRef.current = dimensionController;
    try {
      const nextDimensions = await readImageDimensions(nextFile, { signal: dimensionController.signal });
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
      const message = formatImageConverterError(loadError);
      setStatus({ kind: "error", text: "读取失败" });
      setError(message);
      return false;
    } finally {
      if (dimensionControllerRef.current === dimensionController) dimensionControllerRef.current = null;
    }
  };

  const loadFiles = async (files: File[], replaceImageId: string | null = null) => {
    if (status.kind === "busy") return;
    const initialCount = loadedImagesRef.current.length;
    const replacingExistingImage = replaceImageId !== null
      && loadedImagesRef.current.some((image) => image.id === replaceImageId);
    let loadedCount = 0;
    let failedCount = 0;
    for (const [index, nextFile] of files.entries()) {
      if (await loadFile(nextFile, index === 0 ? replaceImageId : null)) {
        loadedCount += 1;
      } else {
        failedCount += 1;
      }
    }
    replaceImageIdRef.current = null;
    if (loadedCount > 0) {
      const totalLoaded = initialCount + loadedCount - (replacingExistingImage ? 1 : 0);
      if (failedCount > 0) {
        setError(`${failedCount} 张图片导入失败；已载入 ${loadedCount} 张，可检查文件格式、大小或读取错误后重试。`);
        setStatus({ kind: "error", text: `部分导入完成：${totalLoaded} 张图片可导出` });
      } else {
        setStatus({ kind: "ready", text: `${totalLoaded} 张图片已载入，可以导出` });
      }
    }
  };

  loadFilesRef.current = loadFiles;

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
      return true;
    } catch (loadError) {
      const message = formatImageConverterError(loadError);
      setStatus({ kind: "error", text: "读取失败" });
      setError(message);
      replaceImageIdRef.current = null;
      return false;
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

  useEffect(() => {
    if (!active) return undefined;
    const handlePaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      const imageFiles = files.filter(isImageFile);
      if (imageFiles.length > 0) {
        event.preventDefault();
        void loadFilesRef.current(imageFiles, replaceImageIdRef.current);
        return;
      }
      if (files.length > 0 || (event.clipboardData?.items.length ?? 0) > 0) {
        setError("剪贴板中没有可导入的图片，请复制图片后再试。 ");
        setStatus({ kind: "error", text: "剪贴板没有图片" });
      }
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [active]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFiles = Array.from(event.target.files ?? []);
    if (nextFiles.length > 0) {
      void loadFiles(nextFiles, replaceImageIdRef.current);
    }
    event.target.value = "";
  };

  const handleSelectImage = (replaceImageId: string | null = null) => {
    if (status.kind === "busy") return;
    replaceImageIdRef.current = replaceImageId;
    if (isTauriEnvironment()) {
      void loadNativeImages(undefined, replaceImageId);
    } else {
      inputRef.current?.click();
    }
  };

  const handleImportImageDirectory = async () => {
    if (status.kind === "busy") return;
    if (!isTauriEnvironment()) {
      setError("导入文件夹仅在桌面应用中可用，请使用文件选择或拖放。 ");
      setStatus({ kind: "error", text: "当前环境不支持导入文件夹" });
      return;
    }
    try {
      const result = await pickImageDirectory();
      if (!result) { setStatus({ kind: "ready", text: "未选择图片文件夹" }); return; }
      const existingPaths = new Set(loadedImagesRef.current.map((image) => image.sourcePath).filter((path): path is string => Boolean(path)));
      const freshSources = result.files.filter((source) => !existingPaths.has(source.path));
      const duplicateCount = result.files.length - freshSources.length;
      await loadFiles(freshSources.map(createNativeFile));
      const skippedCount = result.skipped.length + duplicateCount;
      const summary = `文件夹扫描：载入 ${freshSources.length} 张，跳过 ${skippedCount} 张，共 ${formatFileSize(result.totalBytes)}`;
      setStatus({ kind: skippedCount > 0 ? "error" : "ready", text: summary });
      if (skippedCount > 0) setError(`${summary}。${result.skipped.length ? result.skipped.join("；") : "已跳过列表中已有的重复图片。"}`);
    } catch (importError) {
      setError(`图片文件夹导入失败：${formatImageConverterError(importError)}`);
      setStatus({ kind: "error", text: "图片文件夹导入失败" });
    }
  };

  const saveWorkspace = () => {
    const data = exportWorkspace({ kind: "image", outputLocation, outputDirectory, outputSubdirectory, namingTemplate: fileNameTemplate, sourcePaths: loadedImages.map((image) => image.sourcePath).filter((path): path is string => Boolean(path)), parameters: { outputFormat, bitDepth, jpegQuality, byteOrder, channelOrder, rowOrder, rowAlignment, cArrayName, keepAspectRatio, backgroundColor, width, height, fileNameTemplate } });
    downloadBlob(new Blob([data], { type: "application/json" }), "embedpix-workspace.json");
    setStatus({ kind: "ready", text: "工作区已保存" });
  };
  const openWorkspace = async (file: File | undefined) => {
    if (!file) return;
    try {
      const bundle = importWorkspace(await file.text(), "image"); const p = bundle.parameters;
      setError(bundle.issues.length ? bundle.issues.map((issue) => issue.path ? `${formatWorkspaceTransferError(issue.message)}：${issue.path}` : formatWorkspaceTransferError(issue.message)).join("；") : null);
      if (bundle.outputLocation === "source" || bundle.outputLocation === "subfolder" || bundle.outputLocation === "directory") setOutputLocation(bundle.outputLocation); if (typeof bundle.outputDirectory === "string") setOutputDirectory(bundle.outputDirectory); if (typeof bundle.outputSubdirectory === "string") setOutputSubdirectory(bundle.outputSubdirectory); if (typeof bundle.namingTemplate === "string") { setFileNameTemplate(bundle.namingTemplate); setRenameEnabled(bundle.namingTemplate !== DEFAULT_FILE_NAME_TEMPLATE); }
      if (typeof p.defaultOutputFormat === "string") setOutputFormat(p.defaultOutputFormat as OutputFormat); if (typeof p.defaultBitDepth === "number") setBitDepth(p.defaultBitDepth as BmpBitDepth); if (typeof p.defaultJpegQuality === "number") setJpegQuality(p.defaultJpegQuality); if (p.defaultByteOrder === "little" || p.defaultByteOrder === "big") setByteOrder(p.defaultByteOrder); if (p.defaultChannelOrder === "rgb" || p.defaultChannelOrder === "bgr") setChannelOrder(p.defaultChannelOrder); if (p.defaultRowOrder === "top-down" || p.defaultRowOrder === "bottom-up") setRowOrder(p.defaultRowOrder); if (p.defaultRowAlignment === 1 || p.defaultRowAlignment === 2 || p.defaultRowAlignment === 4) setRowAlignment(p.defaultRowAlignment); if (typeof p.defaultCArrayName === "string") setCArrayName(p.defaultCArrayName); if (typeof p.keepAspectRatio === "boolean") setKeepAspectRatio(p.keepAspectRatio); if (typeof p.defaultBackgroundColor === "string") setBackgroundColor(p.defaultBackgroundColor);
      if (isTauriEnvironment() && bundle.sourcePaths.length) {
        const restored = await loadNativeImages(bundle.sourcePaths);
        if (restored) setStatus({ kind: "ready", text: "工作区参数和源图片已恢复" });
        else { setError(`无法恢复源图片：${bundle.sourcePaths.join("、")}`); setStatus({ kind: "error", text: "部分源图片恢复失败，已保留当前列表" }); }
      } else if (bundle.sourcePaths.length) { setStatus({ kind: "ready", text: "参数已恢复，源图片请重新选择" }); setError("浏览器不会自动读取工作区源文件，请重新选择图片。 "); }
      else setStatus({ kind: "ready", text: "工作区参数已恢复" });
    } catch (error) { setError(formatWorkspaceTransferError(error)); setStatus({ kind: "error", text: "工作区打开失败" }); }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (status.kind === "busy") return;
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
    clearExportResults();
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
    resetImageTransform(null);
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
    clearExportResults();
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
    resetImageTransform(null);
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
      const message = formatImageConverterError(pickError);
      setError(message);
      setStatus({ kind: "error", text: "选择输出目录失败" });
    }
  };

  const handleDeleteSourceChange = (checked: boolean) => {
    setDeleteSource(checked);
    setError(null);
  };

  // 关掉重命名就回到源图名，免得看不见的模板继续生效。
  const handleRenameChange = (checked: boolean) => {
    setRenameEnabled(checked);
    if (!checked) setFileNameTemplate(DEFAULT_FILE_NAME_TEMPLATE);
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

  const handleCropInputChange = (field: keyof CropInputs, value: string) => {
    const nextCropInputs = { ...cropInputs, [field]: value };
    setCropInputs(nextCropInputs);
    updateTransformStatus(nextCropInputs);
  };

  const handleResetImageTransform = () => {
    resetImageTransform(dimensions);
    updateTransformStatus(getFullImageCropInputs(dimensions), false);
  };

  const handleSettingsSummaryKeyDown = (event: KeyboardEvent<HTMLElement>, close: () => void) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      event.currentTarget.focus();
    }
  };

  const requestExportCancel = () => {
    if (status.kind !== "busy") {
      return;
    }
    exportCancelRef.current = true;
    exportPauseRef.current = false;
    exportCancelWaitRef.current?.();
    exportResumeRef.current?.();
    exportResumeRef.current = null;
    exportCancelWaitRef.current = null;
    setExportPaused(false);
    setStatus({ kind: "busy", text: "正在等待当前文件完成，之后将停止队列…" });
  };

  const toggleExportPause = () => {
    if (status.kind !== "busy") return;
    if (!exportPaused) {
      exportPauseRef.current = true;
      setExportPaused(true);
      setStatus({ kind: "busy", text: "已暂停：当前文件完成后等待继续，原子导出不会被中断。" });
      return;
    }
    exportPauseRef.current = false;
    exportResumeRef.current?.();
    exportResumeRef.current = null;
    setExportPaused(false);
    setStatus({ kind: "busy", text: "正在继续批量导出…" });
  };

  const handleExport = async (requestedImages: ReadonlyArray<LoadedImage> = loadedImages) => {
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

    if (cropValidationError && requestedImages === loadedImages) {
      setError(cropValidationError);
      setStatus({ kind: "error", text: "请检查编辑参数" });
      return;
    }

    let requestedPlan;
    try {
      requestedPlan = planBatchConversions(requestedImages.map((image) => ({ name: image.file.name, width: image.dimensions.width, height: image.dimensions.height, sourcePath: image.sourcePath })), { template: fileNameTemplate, outputFormat, outputLocation, outputDirectory, outputSubdirectory });
    } catch (planError) {
      setError(formatBatchConversionPlanError(planError));
      setStatus({ kind: "error", text: "请检查文件名模板" });
      return;
    }

    const safetyPlan = getExportSafetyPlan(requestedImages, {
      outputFormat,
      outputLocation,
      outputSubdirectory: normalizeSubdirectoryPath(outputSubdirectory),
      outputDirectory,
      overwriteSameName,
      deleteSource,
    });
    setNativePreflightStatus(null);
    setActualExportResult(null);
    const estimatedBytes = estimateImageExportBytesForDimensions(requestedImages.map((image) => {
      const targetSourceDimensions = getTransformedSourceDimensions(image.dimensions, imageTransform);
      const targetDimensions = keepAspectRatio
        ? constrainAspectDimensions("width", width, targetSourceDimensions)
        : { width, height };
      return { file: image.file, width: targetDimensions.width, height: targetDimensions.height };
    }), outputFormat, getEffectiveBitDepth(outputFormat, bitDepth));
    const preflight = getExportPreflight(safetyPlan);
    setExportPreflight(preflight);
    if (preflight.expectedFailures > 0) {
      const details = preflight.items
        .filter((item) => !item.ok)
        .map((item) => `${item.targetPath}：${item.reasons.map(({ message }) => message).join("；")}`)
        .join("\n");
      setError(details);
      setStatus({ kind: "error", text: `导出预检：预计成功 ${preflight.expectedSuccesses}，失败 ${preflight.expectedFailures}` });
      return;
    }
    let nativePreflight: ImageExportPreflightResult | null = null;
    try {
      nativePreflight = await preflightImageExports(safetyPlan.targetPaths, estimatedBytes ?? 0);
      setNativePreflightStatus(nativePreflight.supported
        ? `已执行原生目录与权限预检；${nativePreflight.diskSpaceChecked ? `预估 ${formatFileSize(estimatedBytes ?? 0)}，可用 ${formatFileSize(nativePreflight.availableBytes ?? 0)}` : "磁盘空间未检查"}`
        : "未执行原生文件系统预检（当前不是桌面应用）");
    } catch (probeError) {
      const probeMessage = `原生预检失败，已阻止导出：${formatImageConverterError(probeError)}`;
      setNativePreflightStatus(probeMessage);
      setError(probeMessage);
      setStatus({ kind: "error", text: "导出预检失败" });
      return;
    }
    if (nativePreflight?.supported) {
      const allowExisting = overwriteSameName || outputLocation === "original";
      const nativeItems = nativePreflight.items.map((item) => {
        const reasons = [];
        if (!item.parentExists) reasons.push({ code: "output-directory-missing" as const, message: item.reason ?? "输出目录不存在。" });
        else if (!item.parentWritable) reasons.push({ code: "output-directory-not-writable" as const, message: item.reason ?? "输出目录不可写。" });
        if (item.targetExists && !allowExisting) reasons.push({ code: "target-exists" as const, message: item.reason ?? "输出文件已存在。" });
        if (nativePreflight?.diskSpaceSufficient === false) reasons.push({ code: "insufficient-disk-space" as const, message: `磁盘空间不足：预估需要 ${formatFileSize(estimatedBytes ?? 0)}，可用 ${formatFileSize(nativePreflight.availableBytes ?? 0)}。` });
        return { targetPath: item.targetPath, ok: reasons.length === 0, reasons };
      });
      const nativeFailures = nativeItems.filter((item) => !item.ok);
      const mergedPreflight: ExportPreflightResult = {
        total: nativeItems.length,
        expectedSuccesses: nativeItems.filter((item) => item.ok).length,
        expectedFailures: nativeFailures.length,
        items: nativeItems,
        diskSpaceChecked: nativePreflight.diskSpaceChecked,
      };
      setExportPreflight(mergedPreflight);
      if (nativeFailures.length > 0) {
        const details = nativeFailures.map((item) => `${item.targetPath}：${item.reasons.map(({ message }) => message).join("；")}`).join("\n");
        setError(details);
        setStatus({ kind: "error", text: `原生导出预检：预计成功 ${mergedPreflight.expectedSuccesses}，失败 ${mergedPreflight.expectedFailures}` });
        return;
      }
    }
    const confirmationMessage = formatExportSafetyConfirmation(safetyPlan);
    if (confirmationMessage && !window.confirm(confirmationMessage)) {
      setError(null);
      setStatus({ kind: "ready", text: "已取消导出，文件未改变" });
      return;
    }

    exportCancelRef.current = false;
    exportPauseRef.current = false;
    setExportPaused(false);
    setError(null);
    setFailedExportIds([]);
    setExportFailures([]);
    setFailureDetailsOpen(false);
    setExportProgress(null);
    setExportOutputPaths([]);
    let lastOutputPath: string | null = null;
    const exportedOutputPaths: string[] = [];
    const result = await runExportQueue(requestedImages, async (image, queueIndex) => {
        const imageTransformError = cropEnabled ? getCropInputValidation(cropInputs, image.dimensions) : null;
        if (imageTransformError) {
          throw new Error(imageTransformError);
        }
        const targetSourceDimensions = getTransformedSourceDimensions(image.dimensions, imageTransform);
        const targetDimensions = keepAspectRatio
          ? constrainAspectDimensions("width", width, targetSourceDimensions)
          : { width, height };
        const request: ExportImageRequest = {
          fileName: requestedPlan.items[queueIndex]?.targetPath.split(/[\\/]/u).pop() ?? image.file.name,
          inputData: new Uint8Array(await image.file.arrayBuffer()),
          outputFormat,
          width: targetDimensions.width,
          height: targetDimensions.height,
          keepAspectRatio,
          bitDepth: getEffectiveBitDepth(outputFormat, bitDepth),
          backgroundColor,
          fillTransparent,
          jpegQuality,
          byteOrder,
          channelOrder,
          rowOrder,
          rowAlignment,
          cArrayName: normalizeCArrayName(cArrayName),
          outputLocation,
          sourcePath: image.sourcePath,
          outputSubdirectory: normalizeSubdirectoryPath(outputSubdirectory) || undefined,
          outputDirectory: outputDirectory.trim() || undefined,
          overwriteSameName,
          deleteSource,
          metadataPolicy,
          transform: imageTransform,
        };
        const exportResult = await exportImage(request);
        lastOutputPath = exportResult?.outputPath ?? null;
        if (exportResult?.outputPath) exportedOutputPaths.push(exportResult.outputPath);
        setActualExportResult(exportResult);
      }, {
        shouldCancel: () => exportCancelRef.current,
        shouldPause: () => exportPauseRef.current,
        waitForResume: () => new Promise<void>((resolve) => {
          exportResumeRef.current = resolve;
          exportCancelWaitRef.current = () => {
            exportPauseRef.current = false;
            resolve();
          };
        }),
        cancelWaitForResume: () => {
          exportPauseRef.current = false;
          exportResumeRef.current?.();
          exportResumeRef.current = null;
        },
        onProgress: (progress) => {
          setExportProgress(progress);
          setStatus({ kind: "busy", text: formatExportQueueProgress(progress) });
        },
      });
    const failures = result.failed.map(({ item, error: exportError }) => {
      const message = formatImageConverterError(exportError);
      return { fileName: item.file.name, message };
    });
    setFailedExportIds(result.failed.map(({ item }) => item.id));
    setExportOutputPaths(exportedOutputPaths);
    setExportFailures(failures);
    if (failures.length > 0) {
      setError(formatExportFailureDetails(failures));
    } else {
      setError(null);
    }
    if (result.cancelled || failures.length > 0) {
      setStatus({ kind: failures.length > 0 ? "error" : "ready", text: `${formatExportQueueSummary(result)} · 预检预计成功 ${preflight.expectedSuccesses} 项` });
    } else {
      setStatus({
        kind: "success",
        text: result.total === 1 && result.succeeded.length === 1
          ? `已导出到 ${lastOutputPath ?? "目标位置"}`
          : formatExportQueueSummary(result),
      });
    }
  };

  const retryFailedExports = () => {
    const retryImages = loadedImages.filter((image) => failedExportIds.includes(image.id));
    if (retryImages.length > 0) {
      void handleExport(retryImages);
    }
  };

  const copyExportFailureDetails = async () => {
    if (!exportFailures.length) return;
    try {
      if (!navigator.clipboard) throw new Error("当前环境不支持复制，请手动选择失败详情。" );
      await navigator.clipboard.writeText(formatExportFailureDetails(exportFailures));
      setStatus({ kind: "ready", text: "失败详情已复制" });
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "复制失败，请手动选择失败详情。" );
      setStatus({ kind: "error", text: "复制失败" });
    }
  };

  const copyExportPath = async () => {
    const outputPath = actualExportResult?.outputPath;
    if (!outputPath) return;
    try {
      if (!navigator.clipboard) throw new Error("当前环境不支持复制，请手动选择输出路径。 ");
      await navigator.clipboard.writeText(outputPath);
      setStatus({ kind: "ready", text: "输出路径已复制" });
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "复制失败，请手动选择输出路径。 ");
      setStatus({ kind: "error", text: "复制失败" });
    }
  };

  const copyExportPaths = async () => {
    const paths = formatExportOutputPaths(exportOutputPaths);
    if (!paths) return;
    try {
      if (!navigator.clipboard) throw new Error("当前环境不支持复制，请手动选择输出路径。 ");
      await navigator.clipboard.writeText(paths);
      setStatus({ kind: "ready", text: `已复制 ${exportOutputPaths.length} 个输出路径` });
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "复制失败，请手动选择输出路径。 ");
      setStatus({ kind: "error", text: "复制失败" });
    }
  };

  const revealExportFolder = async () => {
    const outputPath = actualExportResult?.outputPath;
    if (!outputPath) return;
    try {
      await revealImageOutput(outputPath);
      setStatus({ kind: "ready", text: "已打开输出文件夹" });
    } catch (openError) {
      setError(formatImageConverterError(openError));
      setStatus({ kind: "error", text: "打开失败" });
    }
  };

  return (
    <main className="converter-app">
      <header className="converter-header">
        <div className="header-lockup">
          <Images className="header-lockup-icon" size={19} strokeWidth={2} aria-hidden="true" />
          <div>
            <p className="eyebrow">EMBEDPIX</p>
            <h1>图片转换工作区</h1>
          </div>
        </div>
      </header>

      <div className="converter-content">
      <section className="workspace-grid" aria-label="图片转换工作区">
        <div className="panel preview-panel">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">01 / SOURCE</p>
              <h3>源图片</h3>
            </div>
            {file ? (
              <button className="icon-button" type="button" onClick={clearFile} disabled={status.kind === "busy"} aria-label="移除当前图片" title="移除当前图片">
                <X size={16} aria-hidden="true" />
              </button>
            ) : null}
          </div>

          <input ref={inputRef} type="file" accept={SUPPORTED_IMAGE_ACCEPT} onChange={handleFileChange} multiple hidden disabled={status.kind === "busy"} />

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
              aria-disabled={status.kind === "busy"}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  handleSelectImage();
                }
              }}
              aria-label="拖拽图片到这里，或按 Enter 选择本地文件"
            >
              <div className="drop-icon"><Download size={22} aria-hidden="true" /></div>
              <strong>拖拽图片到这里</strong>
              <small>支持 {SUPPORTED_IMAGE_FORMAT_LABEL}</small>
            </div>
          ) : (
            <div className="preview-content">
              <div className="preview-frame" style={{ backgroundColor }}>
                {previewUrl ? (cropPreview ? (
                  <div
                    className="preview-crop-window"
                    data-crop-window="true"
                    style={{ "--crop-w": cropPreview.cropWidth, "--crop-h": cropPreview.cropHeight } as CSSProperties}
                  >
                    <img
                      src={previewUrl}
                      alt={`预览（裁剪 ${cropPreview.aspectRatio}）：${file.name}`}
                      style={{
                        left: `${cropPreview.imageLeftPercent}%`,
                        top: `${cropPreview.imageTopPercent}%`,
                        width: `${cropPreview.imageWidthPercent}%`,
                        transform: `scaleY(${previewTransform.flipVertical ? -1 : 1}) scaleX(${previewTransform.flipHorizontal ? -1 : 1}) rotate(${previewTransform.rotation}deg)`,
                      }}
                    />
                  </div>
                ) : <img
                  src={previewUrl}
                  alt={`预览：${file.name}`}
                  style={{
                    transform: `rotate(${previewTransform.rotation}deg) scaleX(${previewTransform.flipHorizontal ? -1 : 1}) scaleY(${previewTransform.flipVertical ? -1 : 1})`,
                  }}
                />) : null}
              </div>
              <div className="preview-comparison" aria-label="输出预览对比">
                <div className="preview-comparison-heading"><strong>输出预览</strong><span>参数模拟，非已导出文件</span></div>
                <div className="preview-frame preview-frame-output" style={{ backgroundColor }}>
                  {previewUrl ? (cropPreview ? (
                    <div
                      className="preview-crop-window"
                      data-crop-window="true"
                      style={{ "--crop-w": cropPreview.cropWidth, "--crop-h": cropPreview.cropHeight } as CSSProperties}
                    >
                      <img
                        src={previewUrl}
                        alt={`输出预览（裁剪 ${cropPreview.aspectRatio}）：${file.name}`}
                        style={{
                          left: `${cropPreview.imageLeftPercent}%`,
                          top: `${cropPreview.imageTopPercent}%`,
                          width: `${cropPreview.imageWidthPercent}%`,
                          transform: `scaleY(${previewTransform.flipVertical ? -1 : 1}) scaleX(${previewTransform.flipHorizontal ? -1 : 1}) rotate(${previewTransform.rotation}deg)`,
                        }}
                      />
                    </div>
                  ) : <img src={previewUrl} alt={`输出预览：${file.name}`} style={{ transform: `rotate(${previewTransform.rotation}deg) scaleX(${previewTransform.flipHorizontal ? -1 : 1}) scaleY(${previewTransform.flipVertical ? -1 : 1})` }} />) : null}
                </div>
                <div className="preview-comparison-meta">
                  <span>{outputPreviewComparison.dimensions}</span>
                  <span>{outputPreviewComparison.format} · {outputPreviewComparison.bitDepth}</span>
                  <span>{outputPreviewComparison.color}</span>
                  <span>{outputPreviewComparison.fileSize}</span>
                </div>
                {realPreviewError ? <p className="preview-edit-note" role="status">{realPreviewError}</p> : null}
                {realPreview ? <>
                  <div className="preview-comparison-heading"><strong>桌面真实编码预览</strong><span>{realPreview.outputBytes} B</span></div>
                  {realPreviewUrl ? <div className="preview-frame preview-frame-output"><img src={realPreviewUrl} alt={`真实编码预览：${file.name}`} /></div> : <p className="preview-edit-note">该格式没有可显示的图像像素，已显示真实编码参数和体积。</p>}
                  <div className="preview-comparison-meta"><span>{realPreview.width} × {realPreview.height} px</span><span>{realPreview.format.toUpperCase()} · {realPreview.bitDepth} 位</span><span>真实体积 {formatFileSize(realPreview.outputBytes)}</span></div>
                </> : null}
              </div>
              {hasImageTransform ? <p className="preview-edit-note">
                {previewAppliedTransforms.length > 0 ? `预览已应用${previewAppliedTransforms.join("、")}；` : "裁剪预览受限；"}
                {cropEnabled ? (cropPreview ? "裁剪按原图像素坐标实时预览。" : "裁剪区域无效，暂不预览。") : "当前没有启用裁剪。"}
              </p> : null}
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
                    disabled={status.kind === "busy"}
                  >
                    更换
                  </button>
                </div>
              </div>
              <div className="file-list-toolbar">
                <span className="file-count">已导入 {loadedImages.length} 张</span>
                <div className="file-list-actions">
                  <button className="quiet-button file-add-button" type="button" onClick={() => handleSelectImage()} disabled={status.kind === "busy"}>
                    <Plus size={14} aria-hidden="true" />
                    继续添加
                  </button>
                  <button className="quiet-button file-add-button" type="button" onClick={() => void handleImportImageDirectory()} disabled={status.kind === "busy"}>导入文件夹</button>
                  {loadedImages.length > 1 ? (
                    <button className="quiet-button file-clear-button" type="button" onClick={clearAllImages} disabled={status.kind === "busy"}>清空列表</button>
                  ) : null}
                </div>
              </div>
              {loadedImages.length > 1 ? (
                <div className="file-list" role="list" aria-label="已导入图片列表">
                  {loadedImages.map((image) => (
                    <div className={`file-list-item${image.id === selectedImageId ? " file-list-item-selected" : ""}`} key={image.id} role="listitem">
                      <button
                        className="file-list-select"
                        type="button"
                        aria-pressed={image.id === selectedImageId}
                        onClick={() => selectImage(image.id)}
                        disabled={status.kind === "busy"}
                      >
                        <span className="file-list-icon"><ImageIcon size={14} aria-hidden="true" /></span>
                        <span className="file-list-copy">
                          <strong title={image.file.name}>{image.file.name}</strong>
                          <small>{image.dimensions.width} × {image.dimensions.height} px · {formatFileSize(image.file.size)}</small>
                        </span>
                      </button>
                      <button className="icon-button file-remove-button" type="button" onClick={() => removeImage(image.id)} disabled={status.kind === "busy"} aria-label={`移除 ${image.file.name}`} title="移除这张图片">
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
          {!file ? <div className="drop-zone-actions"><button className="quiet-button directory-import-button" type="button" onClick={() => void handleImportImageDirectory()} disabled={status.kind === "busy"}>导入图片文件夹</button></div> : null}
        </div>

        <div className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">02 / OUTPUT</p>
              <h3>输出设置</h3>
            </div>
            <span className="output-summary">{outputSummary}</span>
          </div>

          <div className="settings-stack" inert={status.kind === "busy"} aria-disabled={status.kind === "busy"} aria-busy={status.kind === "busy"}>
            <fieldset className="setting-group format-group">
              <legend className="field-label">输出格式</legend>
              <FormatSelector value={outputFormat} onChange={handleFormatChange} describedBy="format-description" />
              <p className="format-description" id="format-description">{getFormatInfo(outputFormat).description}</p>
            </fieldset>

            {embeddedInspection ? <section className="embedded-output-inspector" aria-labelledby="embedded-output-title">
              <div className="label-row"><span className="field-label" id="embedded-output-title">嵌入式输出检查</span><span className="field-note">CRC32 {embeddedInspection.crc32}</span></div>
              <div className="embedded-output-grid">
                <span>理论像素字节<strong>{embeddedInspection.pixelBytes}</strong></span>
                <span>行 stride<strong>{embeddedInspection.rowStrideBytes} B</strong></span>
                <span>总缓冲区<strong>{embeddedInspection.totalBufferBytes} B</strong></span>
                <span>参数<strong>{embeddedInspection.channelOrder.toUpperCase()} · {embeddedInspection.byteOrder === "little" ? "小端" : "大端"} · {embeddedInspection.rowOrder === "top-down" ? "从上到下" : "从下到上"}</strong></span>
              </div>
            </section> : null}

            <details className="settings-module" open={pixelSettingsOpen} onToggle={(event) => setPixelSettingsOpen(event.currentTarget.open)}>
              <summary aria-expanded={pixelSettingsOpen} aria-controls="image-settings-panel" onKeyDown={(event) => handleSettingsSummaryKeyDown(event, () => setPixelSettingsOpen(false))}>画面与像素参数</summary>
              <div id="image-settings-panel" className="settings-module-body">
            <div className="setting-group image-transform-group">
              <div className="label-row">
                <span className="field-label">基础编辑</span>
                {transformedSourceDimensions ? <span className="field-note">编辑后 {transformedSourceDimensions.width} × {transformedSourceDimensions.height}</span> : null}
              </div>
              <div className="parameter-grid">
                <SelectField
                  id="image-rotation"
                  label="旋转"
                  value={rotation}
                  options={[0, 90, 180, 270].map((value) => ({ value: value as ImageRotation, label: value === 0 ? "0°" : `${value}°` }))}
                  onChange={(value) => { setRotation(value); updateTransformStatus(); }}
                />
                <label className="compact-field">
                  <span>裁剪</span>
                  <span className="transform-toggle">
                    <input type="checkbox" checked={cropEnabled} onChange={(event) => { setCropEnabled(event.target.checked); updateTransformStatus(cropInputs, event.target.checked); }} />
                    <span>启用裁剪</span>
                  </span>
                </label>
              </div>
              <div className="transform-toggle-row">
                <label className="toggle-row">
                  <input type="checkbox" checked={flipHorizontal} onChange={(event) => { setFlipHorizontal(event.target.checked); updateTransformStatus(); }} />
                  <span className="toggle-track" aria-hidden="true"><span /></span>
                  <span>水平翻转</span>
                </label>
                <label className="toggle-row">
                  <input type="checkbox" checked={flipVertical} onChange={(event) => { setFlipVertical(event.target.checked); updateTransformStatus(); }} />
                  <span className="toggle-track" aria-hidden="true"><span /></span>
                  <span>垂直翻转</span>
                </label>
              </div>
              {cropEnabled ? <div className="crop-grid" aria-label="裁剪区域">
                {(["x", "y", "width", "height"] as const).map((field) => {
                  const labels = { x: "X", y: "Y", width: "宽度", height: "高度" };
                  const max = field === "x" ? dimensions?.width : field === "y" ? dimensions?.height : field === "width" ? dimensions?.width : dimensions?.height;
                  return <label className="text-field" htmlFor={`crop-${field}`} key={field}>
                    <span>裁剪{labels[field]}</span>
                    <input
                      id={`crop-${field}`}
                      type="number"
                      inputMode="numeric"
                      min={field === "x" || field === "y" ? 0 : 1}
                      max={max}
                      step="1"
                      value={cropInputs[field]}
                      disabled={!file}
                      aria-invalid={Boolean(cropValidationError)}
                      onChange={(event) => handleCropInputChange(field, event.target.value)}
                    />
                  </label>;
                })}
              </div> : null}
              {cropValidationError ? <p className="error-message transform-error" role="alert">{cropValidationError}</p> : null}
              <div className="transform-footer">
                <label className="toggle-row transform-live-preview-toggle">
                  <input type="checkbox" checked={livePreview} onChange={(event) => { const enabled = event.target.checked; setLivePreview(enabled); if (enabled) setAppliedPreviewTransform(imageTransform); }} />
                  <span className="toggle-track" aria-hidden="true"><span /></span>
                  <span>实时预览</span>
                </label>
                {!livePreview && previewTransformDirty ? <button className="quiet-button" type="button" onClick={() => setAppliedPreviewTransform(imageTransform)}>应用预览</button> : null}
                <button className="quiet-button" type="button" onClick={handleResetImageTransform} disabled={!hasImageTransform}>重置编辑</button>
              </div>
            </div>
            <div className="setting-group bit-depth-group">
              <div className="label-row">
                <span className="field-label">位深</span>
                {outputFormat === "jpg" ? <span className="field-note">JPG 固定 24 位</span> : isRawPixelFormat(outputFormat) ? <span className="field-note">RGB565 固定 16 位</span> : null}
              </div>
              {outputFormat === "jpg" || isRawPixelFormat(outputFormat) ? null : (
                <div className="bit-depth-select-row">
                  <ThemeSelect
                    id="bit-depth"
                    value={bitDepth}
                    options={getBitDepths(outputFormat).map((depth) => ({ value: depth, label: `${depth} 位` }))}
                    aria-label="位深"
                    aria-describedby="bit-depth-description"
                    onChange={handleBitDepthChange}
                  />
                  <p className="field-help bit-depth-option-help" id="bit-depth-description">{getBitDepthNote(outputFormat, bitDepth)}</p>
                </div>
              )}
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
                <label className="field-label" htmlFor="background-color">透明色</label>
              </div>
              <label className="color-control" htmlFor="background-color">
                <input id="background-color" type="color" value={backgroundColor} onChange={(event) => handleBackgroundColorChange(event.target.value)} />
                <span>{backgroundColor}</span>
              </label>
            </div>

            {outputFormat === "bmp" && getEffectiveBitDepth(outputFormat, bitDepth) === 32 ? (
              <div className="setting-group">
                <div className="field-hint-anchor">
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={fillTransparent}
                      aria-describedby="fill-transparent-help"
                      onChange={(event) => setFillTransparent(event.target.checked)}
                    />
                    <span className="toggle-track" aria-hidden="true"><span /></span>
                    <span>填充透明色</span>
                  </label>
                  <p className="field-help field-help-hover" id="fill-transparent-help">勾选后透明区域按上面的透明色填充，输出不再保留透明度。</p>
                </div>
              </div>
            ) : null}

                </div>
              </details>

              <details className="settings-module" open={outputSettingsOpen} onToggle={(event) => setOutputSettingsOpen(event.currentTarget.open)}>
                <summary aria-expanded={outputSettingsOpen} aria-controls="image-output-settings-panel" onKeyDown={(event) => handleSettingsSummaryKeyDown(event, () => setOutputSettingsOpen(false))}>输出位置与文件处理</summary>
                <div id="image-output-settings-panel" className="settings-module-body">
            <div className="setting-group output-location-group">
              <div className="label-row">
                <label className="field-label" htmlFor="output-location">输出位置</label>
              </div>
              <ThemeSelect
                id="output-location"
                value={outputLocation}
                options={[
                  { value: "source" as const, label: "源文件夹" },
                  { value: "subfolder" as const, label: "子文件夹" },
                  { value: "directory" as const, label: "指定目录" },
                ]}
                aria-label="输出位置"
                aria-describedby={outputLocationDescription}
                aria-invalid={Boolean(outputLocationError)}
                onChange={handleOutputLocationChange}
              />
              {outputLocation === "subfolder" ? (
                <label className="text-field" htmlFor="output-subdirectory">
                  <span>子文件夹</span>
                  <input
                    id="output-subdirectory"
                    value={outputSubdirectory}
                    aria-describedby={outputLocationDescription}
                    aria-invalid={Boolean(outputLocationError)}
                    onChange={(event) => { setOutputSubdirectory(event.target.value); setError(null); }}
                    placeholder="子文件夹不存在时会自动创建。"
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
                      placeholder="目录不存在时会自动创建，支持绝对路径。"
                      spellCheck={false}
                    />
                    {isTauriEnvironment() ? <button
                      className="quiet-button path-input-picker"
                      type="button"
                      disabled={status.kind === "busy"}
                      onClick={() => void handlePickOutputDirectory()}
                      title="使用系统对话框选择目录"
                    >
                      选择目录
                    </button> : null}
                  </div>
                </label>
              ) : null}
              {outputLocationError ? <p className="error-message output-location-error" id="output-location-error" role="alert">{outputLocationError}</p> : null}
              <label className="toggle-row output-action-toggle">
                <input type="checkbox" checked={renameEnabled} onChange={(event) => handleRenameChange(event.target.checked)} />
                <span className="toggle-track" aria-hidden="true"><span /></span>
                <span>重命名</span>
              </label>
              {renameEnabled ? <div className="field-hint-anchor">
                <label className="text-field" htmlFor="file-name-template">
                  <span>文件名模板</span>
                  <input id="file-name-template" value={fileNameTemplate} onChange={(event) => { setFileNameTemplate(event.target.value); setError(null); }} placeholder="{name}.{ext}" spellCheck={false} aria-describedby="file-name-template-help" />
                </label>
                <p className="field-help field-help-hover" id="file-name-template-help"><strong>可用变量</strong><br /><strong>&#123;name&#125;</strong> 源图片文件名，不含扩展名<br /><strong>&#123;ext&#125;</strong> 输出扩展名，不带点：bmp / png / jpg / webp / tiff / ico，RGB565 为 bin，C 数组为 h<br /><strong>&#123;width&#125; / &#123;height&#125;</strong> 源图片的像素宽 / 高<br /><strong>&#123;index&#125;</strong> 批次内序号，按导入顺序从 1 开始<br />不支持其它 &#123;…&#125; 占位符，模板里也不能写路径分隔符；没写扩展名时会按输出格式自动补上。</p>
              </div> : null}
              {batchPlanResult.error ? <p className="field-help output-location-error" role="alert">{batchPlanResult.error}</p> : null}
              {batchPlan ? <p className={`field-help${batchPlan.duplicateTargets.length > 0 ? " output-location-error" : ""}`} role={batchPlan.duplicateTargets.length > 0 ? "alert" : undefined}>
                示例目标：{batchPlan.targetPaths[0] ?? "暂无"}{batchPlan.duplicateTargets.length > 0 ? ` · 检测到 ${batchPlan.duplicateTargets.length} 个重复目标` : ""}
              </p> : null}
              <div className="output-actions">
                <div className="output-action">
                  <label className="toggle-row output-action-toggle">
                    <input type="checkbox" checked={overwriteSameName} aria-describedby="overwrite-same-name-help" onChange={(event) => { setOverwriteSameName(event.target.checked); setError(null); }} />
                    <span className="toggle-track" aria-hidden="true"><span /></span>
                    <span>覆盖同名文件</span>
                  </label>
                  <p className="field-help output-action-help field-help-hover" id="overwrite-same-name-help">导出前会列出目标文件并要求确认；已有同名输出会直接覆盖，不移动到 bak 文件夹。</p>
                </div>
                <div className="output-action">
                  <label className="toggle-row output-action-toggle">
                    <input type="checkbox" checked={deleteSource} aria-describedby="delete-source-help" onChange={(event) => handleDeleteSourceChange(event.target.checked)} />
                    <span className="toggle-track" aria-hidden="true"><span /></span>
                    <span>导出成功后删除源图片</span>
                  </label>
                  <p className="field-help output-action-help output-action-danger field-help-hover" id="delete-source-help">导出前会列出待删除源文件并要求确认；只有对应输出成功后才会删除。</p>
                </div>
              </div>
            </div>
            <div className="setting-group">
              <label className="toggle-row">
                <input type="checkbox" checked={metadataPolicy === "strip"} aria-describedby="converter-metadata-policy-help" onChange={(event) => setMetadataPolicy(event.target.checked ? "strip" : "preserve")} />
                <span className="toggle-track" aria-hidden="true"><span /></span>
                <span>清理元数据（推荐）</span>
              </label>
              <p className="field-help field-help-hover" id="converter-metadata-policy-help">
                开启时导出会清理可识别元数据；关闭时仅尝试同格式、原尺寸、无裁剪旋转和无水印的原始字节直通，不满足条件会明确拒绝而不是伪装保留。
              </p>
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
              {status.kind === "busy" && exportProgress ? (
                <div className="export-progress-panel" role="group" aria-label="批量导出进度">
                  <div className="export-progress-heading">
                    <span className="export-progress-file" title={exportProgress.item.file.name}>当前：{exportProgress.item.file.name}</span>
                    <strong>{exportProgress.index}/{exportProgress.total}</strong>
                  </div>
                  <div
                    className="export-progress-track"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={exportProgress.total}
                    aria-valuenow={exportProgress.succeeded + exportProgress.failed + exportProgress.skipped}
                    aria-valuetext={`当前第 ${exportProgress.index} 个，共 ${exportProgress.total} 个；成功 ${exportProgress.succeeded}，失败 ${exportProgress.failed}，跳过 ${exportProgress.skipped}`}
                  >
                    <span className="export-progress-value" style={{ width: `${Math.min(100, ((exportProgress.succeeded + exportProgress.failed + exportProgress.skipped) / Math.max(1, exportProgress.total)) * 100)}%` }} />
                  </div>
                  <span className="export-progress-summary">成功 {exportProgress.succeeded} · 失败 {exportProgress.failed} · 跳过 {exportProgress.skipped}</span>
                  <button className="quiet-button export-pause-button" type="button" onClick={toggleExportPause}>{exportPaused ? "继续导出" : "暂停队列"}</button>
                </div>
              ) : null}
              {exportFailures.length > 0 ? (
                <div className="export-failure-panel">
                  <div className="export-failure-actions">
                    <button
                      className="quiet-button export-failure-toggle"
                      type="button"
                      aria-expanded={failureDetailsOpen}
                      aria-controls="export-failure-details"
                      onClick={() => setFailureDetailsOpen((open) => !open)}
                    >
                      {failureDetailsOpen ? "收起失败详情" : `查看失败详情（${exportFailures.length}）`}
                    </button>
                    <button className="quiet-button export-failure-copy" type="button" onClick={() => void copyExportFailureDetails()}>
                      复制错误详情
                    </button>
                  </div>
                  {failureDetailsOpen ? (
                    <ul className="export-failure-details" id="export-failure-details">
                      {exportFailures.map(({ fileName, message }) => (
                        <li key={`${fileName}:${message}`}><strong>{fileName}</strong><span>{message}</span></li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {exportPreflight ? (
                <p className="export-progress-summary" role="status">
                  预检：预计成功 {exportPreflight.expectedSuccesses} · 失败 {exportPreflight.expectedFailures}
                  {exportPreflight.diskSpaceChecked ? " · 已检查磁盘空间" : " · 未检查磁盘空间（当前平台无可靠探针）"}
                </p>
              ) : null}
              {nativePreflightStatus ? <p className="export-progress-summary" role="status">{nativePreflightStatus}</p> : null}
              {actualExportResult?.outputPath && status.kind === "success" ? <p className="export-progress-summary export-actual-result" role="status">
                实际导出：{actualExportResult.outputPath} · {actualExportResult.width && actualExportResult.height ? `${actualExportResult.width} × ${actualExportResult.height} px` : "尺寸由桌面端返回"} · {actualExportResult.format?.toUpperCase() ?? "格式由桌面端返回"} · {actualExportResult.bitDepth ? `${actualExportResult.bitDepth} 位` : "位深由桌面端返回"} · {typeof actualExportResult.outputBytes === "number" ? `实际体积 ${formatFileSize(actualExportResult.outputBytes)}` : "文件体积由桌面端返回"}
              </p> : null}
              {actualExportResult?.outputPath && status.kind !== "busy" ? <div className="export-output-actions">
                <button className="quiet-button" type="button" onClick={() => void revealExportFolder()}>打开所在文件夹</button>
                <button className="quiet-button" type="button" onClick={() => void copyExportPath()}>复制输出路径</button>
                {exportOutputPaths.length > 1 ? <button className="quiet-button" type="button" onClick={() => void copyExportPaths()}>复制全部路径</button> : null}
              </div> : null}
            </div>
            <div className="footer-actions">
              {failedExportIds.length > 0 && status.kind !== "busy" ? (
                <button className="quiet-button export-retry-button" type="button" onClick={retryFailedExports}>
                  仅重试失败项（{failedExportIds.length}）
                </button>
              ) : null}
              <button
                className="export-button"
                type="button"
                disabled={status.kind !== "busy" && (!file || Boolean(dimensionError) || Boolean(cropValidationError) || Boolean(batchOutputLocationError))}
                aria-busy={status.kind === "busy"}
                onClick={() => status.kind === "busy" ? requestExportCancel() : void handleExport()}
              >
                {status.kind === "busy" ? <X size={17} aria-hidden="true" /> : <Upload size={17} aria-hidden="true" />}
                {status.kind === "busy" ? "取消导出" : `导出 ${getOutputLabel(outputFormat)}`}
              </button>
            </div>
            <input ref={workspaceInputRef} type="file" accept="application/json,.json" hidden disabled={status.kind === "busy"} onChange={(event) => { void openWorkspace(event.target.files?.[0]); event.target.value = ""; }} />
            <div className="workspace-transfer-actions"><button className="quiet-button" type="button" onClick={saveWorkspace} disabled={status.kind === "busy"}>保存工作区</button><button className="quiet-button workspace-file-button" type="button" onClick={() => workspaceInputRef.current?.click()} disabled={status.kind === "busy"}>打开工作区</button></div>
          </div>
        </div>
      </section>

      <footer className="converter-footer">
        {errorMessage ? <p className="error-message converter-footer-error" id="dimension-error" role="alert">{errorMessage}</p> : null}
        <span>EmbedPix · 嵌图匠</span>
      </footer>
      </div>
    </main>
  );
}
