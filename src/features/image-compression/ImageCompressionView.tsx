import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { AlertCircle, CheckCircle2, FileDown, FolderOpen, Images, LoaderCircle, RefreshCw, Trash2, Upload } from "lucide-react";
import "../../styles/features/image-compression.css";
import { cancelCompression, compressImage, createCompressionRequest, estimateImageCompression, formatCompressionProgressError, getCompressionProgress, pickCompressionDirectoryResult, pickCompressionFiles, preflightCompression, previewCompression } from "../../platform/compression/compressionGateway";
import { isTauriEnvironment, revealImageOutput } from "../../platform/image/imageExportGateway";
import type { NativeImageFile } from "../../platform/image/imageExportGateway";
import {
  COMPRESSION_FORMATS,
  COMPRESSION_PRESETS,
  COMPRESSION_WEBP_METHOD_DEFAULT,
  COMPRESSION_WEBP_METHOD_MAX,
  COMPRESSION_WEBP_METHOD_MIN,
  canReplaceCompressionOriginal,
  canDeleteCompressionSource,
  estimateFallback,
  COMPRESSION_MAX_INPUT_BYTES,
  COMPRESSION_MAX_CANDIDATES_DEFAULT,
  COMPRESSION_MAX_CANDIDATES_MAX,
  COMPRESSION_MAX_CANDIDATES_MIN,
  filterCompressionFiles,
  splitCompressionImportFiles,
  formatCompressionBytes,
  formatCompressionFailureDetails,
  formatCompressionEstimateSource,
  formatCompressionItemResultStatus,
  getCompressionItemResultMetrics,
  formatCompressionReplaceOriginalConfirmation,
  formatCompressionDeleteSourceConfirmation,
  getCompressionTargetSizeError,
  getSuccessfulCompressionOutputPath,
  getCompressionPreset,
  getCompressionOutputLocationError,
  getCompressionOutputFileNameError,
  getCompressionBatchFinalState,
  getCompressionCancelledItemResults,
  getCompressionRetryQueue,
  getCompressionSourcePathError,
  mergeCompressionItems,
  normalizeCompressionOutputFileName,
  normalizeCompressionOutputModes,
  removeCompressionItem,
  isCurrentCompressionEstimate,
  isCompressionSourcePathError,
  supportsCompressionTargetSize,
} from "./imageCompressionLogic";
import {
  COMPRESSION_MAX_TARGET_SIZE_KIB,
  loadCompressionPreferences,
  saveCompressionPreferences,
} from "./compressionPreferences";
import {
  createCompressionCustomPreset,
  exportCompressionPresetsJson,
  importCompressionPresetsJson,
  loadCompressionCustomPresets,
  mergeCompressionCustomPresets,
  saveCompressionCustomPresets,
  type CompressionCustomPreset,
  type CompressionPresetValues,
} from "./compressionCustomPresets";
import type { CompressionEstimate, CompressionFormat, CompressionItem, CompressionItemResult, CompressionOptions, CompressionOutputLocation, CompressionPreset, MetadataPolicy } from "./types";
import type { CompressionPreview } from "../../platform/compression/compressionGateway";
import { downloadBlob } from "../../shared/downloadBlob";

type CompressionStatus = "idle" | "ready" | "busy" | "success" | "error";

interface ImageCompressionViewProps {
  active?: boolean;
}

interface CompressionResultStats {
  total: number;
  succeeded: number;
  skipped: number;
  failed: number;
  inputBytes: number;
  processedInputBytes: number;
  outputBytes: number;
  savedBytes: number;
  targetMet: boolean | null;
  selectedQualities: number[];
}

interface CompressionImportError {
  id: string;
  fileName: string;
  message: string;
}

interface CompressionFailureDetail {
  itemId?: string;
  fileName: string;
  message: string;
}

function fileTypeForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension ? `image/${extension}` : "application/octet-stream";
}

function nativeFileToItem(nativeFile: NativeImageFile): CompressionItem {
  if (nativeFile.data.length > COMPRESSION_MAX_INPUT_BYTES) {
    throw new Error(`文件超过 ${COMPRESSION_MAX_INPUT_BYTES / (1024 * 1024)} MiB 输入限制。`);
  }
  const file = new File([new Uint8Array(nativeFile.data)], nativeFile.fileName, { type: fileTypeForPath(nativeFile.fileName) });
  return { id: `${nativeFile.path}-${file.size}`, file, sourcePath: nativeFile.path, size: file.size };
}

function toBrowserItems(files: File[]): CompressionItem[] {
  return filterCompressionFiles(files).map((file, index) => ({
    id: `${file.name}-${file.lastModified}-${file.size}-${index}`,
    file,
    size: file.size,
  }));
}

function getCompressionInputFormat(file: File): string {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg" || file.type === "image/jpeg") return "JPEG";
  if (extension) return extension.toUpperCase();
  return file.type.startsWith("image/") ? file.type.slice(6).toUpperCase() : "图片";
}

function readCompressionDimensions(file: File): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file).then((bitmap) => {
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return dimensions;
    });
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("无法读取图片尺寸。"));
    };
    image.src = objectUrl;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function previewMimeType(format: string): string {
  return format === "jpeg" || format === "jpg" ? "image/jpeg" : format === "png" ? "image/png" : "image/webp";
}

export default function ImageCompressionView({ active = true }: ImageCompressionViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const presetFileInputRef = useRef<HTMLInputElement>(null);
  const replaceItemIdRef = useRef<string | null>(null);
  const previewRequestIdRef = useRef(0);
  const estimateRequestIdRef = useRef(0);
  const [initialPreferences] = useState(() => loadCompressionPreferences());
  const [items, setItems] = useState<CompressionItem[]>([]);
  const [format, setFormat] = useState<CompressionFormat>(initialPreferences.format);
  const [quality, setQuality] = useState(initialPreferences.quality);
  const [webpMethod, setWebpMethod] = useState(initialPreferences.webpMethod ?? COMPRESSION_WEBP_METHOD_DEFAULT);
  const [webpNearLossless, setWebpNearLossless] = useState<number | null>(initialPreferences.webpNearLossless);
  const [jpegBackground, setJpegBackground] = useState(initialPreferences.jpegBackground);
  const [pngOptimizationLevel, setPngOptimizationLevel] = useState(initialPreferences.pngOptimizationLevel);
  const [targetSizeKiB, setTargetSizeKiB] = useState(initialPreferences.targetSizeKiB);
  const [maxCandidates, setMaxCandidates] = useState(initialPreferences.maxCandidates);
  const [targetSizeEnabled, setTargetSizeEnabled] = useState(initialPreferences.targetSizeEnabled);
  const [skipIfLarger, setSkipIfLarger] = useState(initialPreferences.skipIfLarger);
  const [lossless, setLossless] = useState(initialPreferences.lossless);
  const [preset, setPreset] = useState<CompressionPreset>(initialPreferences.preset);
  const [metadataPolicy, setMetadataPolicy] = useState<MetadataPolicy>(initialPreferences.metadataPolicy);
  const [outputLocation, setOutputLocation] = useState<CompressionOutputLocation>(initialPreferences.outputLocation);
  const [outputFileName, setOutputFileName] = useState(initialPreferences.outputFileName);
  const [outputSubdirectory, setOutputSubdirectory] = useState(initialPreferences.outputSubdirectory);
  const [outputDirectory, setOutputDirectory] = useState("");
  const [overwrite, setOverwrite] = useState(initialPreferences.overwrite);
  const [autoNumbering, setAutoNumbering] = useState(initialPreferences.autoNumbering);
  const [replaceOriginal, setReplaceOriginal] = useState(initialPreferences.replaceOriginal);
  const [deleteSource, setDeleteSource] = useState(initialPreferences.deleteSource);
  const [customPresets, setCustomPresets] = useState<CompressionCustomPreset[]>(() => loadCompressionCustomPresets());
  const [customPresetId, setCustomPresetId] = useState("");
  const [customPresetName, setCustomPresetName] = useState("");
  const [customPresetMessage, setCustomPresetMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<CompressionStatus>("idle");
  const [importBusy, setImportBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [progressBytes, setProgressBytes] = useState<{ input: number | null; output: number | null }>({ input: null, output: null });
  const [stage, setStage] = useState("");
  const [estimate, setEstimate] = useState<CompressionEstimate>({ inputBytes: 0, estimatedBytes: 0, savingsPercent: 0 });
  const [estimateNote, setEstimateNote] = useState("等待导入图片");
  const [preflightSpaceBytes, setPreflightSpaceBytes] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [importErrors, setImportErrors] = useState<CompressionImportError[]>([]);
  const [failures, setFailures] = useState<string[]>([]);
  const [failureDetails, setFailureDetails] = useState<CompressionFailureDetail[]>([]);
  const [itemResults, setItemResults] = useState<CompressionItemResult[]>([]);
  const [skipReasons, setSkipReasons] = useState<string[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [preview, setPreview] = useState<CompressionPreview | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [originalPreviewUrl, setOriginalPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [lastSuccessfulOutputPath, setLastSuccessfulOutputPath] = useState<string | null>(null);
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);
  const [resultStats, setResultStats] = useState<CompressionResultStats>({ total: 0, succeeded: 0, skipped: 0, failed: 0, inputBytes: 0, processedInputBytes: 0, outputBytes: 0, savedBytes: 0, targetMet: null, selectedQualities: [] });
  const activeJobIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);

  useEffect(() => () => {
    const jobId = activeJobIdRef.current;
    if (!jobId || !isTauriEnvironment()) return;
    void cancelCompression(jobId).catch(() => undefined);
  }, []);

  const busy = status === "busy";
  const sourceBusy = busy || importBusy;
  const qualityEnabled = supportsCompressionTargetSize(format, lossless);
  const webpLossyActive = format === "webp" && !lossless;
  const replaceOriginalAvailable = canReplaceCompressionOriginal(items, isTauriEnvironment());
  const deleteSourceAvailable = canDeleteCompressionSource(items, isTauriEnvironment());
  const outputModes = useMemo(() => normalizeCompressionOutputModes({ autoNumbering, overwrite, replaceOriginal }), [autoNumbering, overwrite, replaceOriginal]);
  const targetSizeActive = targetSizeEnabled && qualityEnabled;
  const targetSizeError = useMemo(() => getCompressionTargetSizeError(targetSizeActive, targetSizeKiB, COMPRESSION_MAX_TARGET_SIZE_KIB), [targetSizeActive, targetSizeKiB]);
  const maxOutputBytes = targetSizeActive && !targetSizeError && targetSizeKiB.trim() ? Math.round(Number(targetSizeKiB) * 1024) : undefined;
  const outputFileNameError = useMemo(() => replaceOriginal ? null : getCompressionOutputFileNameError(outputFileName, format), [format, outputFileName, replaceOriginal]);
  const options = useMemo<CompressionOptions>(() => ({
    format,
    quality,
    webpMethod: webpLossyActive ? webpMethod : undefined,
    webpNearLossless: format === "webp" && lossless ? webpNearLossless : null,
    jpegBackground,
    lossless,
    pngOptimizationLevel,
    metadataPolicy,
    outputLocation,
    outputFileName: outputModes.replaceOriginal || outputFileNameError ? undefined : normalizeCompressionOutputFileName(outputFileName, format),
    outputSubdirectory: outputLocation === "subfolder" ? outputSubdirectory.trim() || undefined : undefined,
    outputDirectory: outputLocation === "directory" ? outputDirectory.trim() || undefined : undefined,
    overwrite: outputModes.overwrite,
    autoNumbering: outputModes.autoNumbering,
    replaceOriginal: outputModes.replaceOriginal,
    deleteSource: outputModes.replaceOriginal ? false : deleteSource,
    skipIfLarger,
    maxOutputBytes,
    maxCandidates: maxOutputBytes ? maxCandidates : undefined,
  }), [deleteSource, format, quality, webpLossyActive, webpMethod, webpNearLossless, jpegBackground, lossless, pngOptimizationLevel, metadataPolicy, outputLocation, outputFileName, outputFileNameError, outputSubdirectory, outputDirectory, outputModes, skipIfLarger, maxOutputBytes, maxCandidates]);

  const outputLocationError = useMemo(() => replaceOriginal ? null : getCompressionOutputLocationError(outputLocation, outputSubdirectory, outputDirectory, true), [outputDirectory, outputLocation, outputSubdirectory, replaceOriginal]);
  const actualSavedBytes = resultStats.savedBytes;
  const actualSavingsPercent = resultStats.processedInputBytes > 0 ? (actualSavedBytes / resultStats.processedInputBytes) * 100 : 0;
  const selectedItem = items.find((item) => item.id === selectedItemId) ?? null;
  const previewSavedBytes = selectedItem && preview ? selectedItem.size - preview.outputBytes : 0;
  const previewSavingsPercent = selectedItem && preview && selectedItem.size > 0 ? (previewSavedBytes / selectedItem.size) * 100 : 0;
  const progressBytesSummary = [
    progressBytes.input !== null ? `输入 ${formatCompressionBytes(progressBytes.input)}` : null,
    progressBytes.output !== null ? `候选/输出 ${formatCompressionBytes(progressBytes.output)}` : null,
  ].filter((entry): entry is string => Boolean(entry)).join(" · ");

  const queueCompressionDimensions = (item: CompressionItem) => {
    void Promise.resolve().then(() => readCompressionDimensions(item.file)).then((dimensions) => {
      setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, dimensions } : candidate));
    }).catch((error) => {
      setImportErrors((current) => [...current, { id: `dimensions-${item.id}`, fileName: item.file.name, message: errorMessage(error) }]);
    });
  };

  useEffect(() => {
    const requestId = ++estimateRequestIdRef.current;
    const controller = new AbortController();
    const fallback = estimateFallback(items, options);
    setEstimate(fallback);
    if (!active || items.length === 0) {
      setEstimateNote(items.length === 0 ? "等待导入图片" : formatCompressionEstimateSource("fallback", "选择桌面图片后可获取原生精确预估"));
      return () => controller.abort();
    }
    if (busy) {
      setEstimateNote(formatCompressionEstimateSource("fallback", "压缩任务进行中"));
      return () => controller.abort();
    }
    if (!selectedItem?.sourcePath) {
      setEstimateNote(formatCompressionEstimateSource("fallback", "浏览器文件不支持原生精确预估"));
      return () => controller.abort();
    }
    if (!isTauriEnvironment()) {
      setEstimateNote(formatCompressionEstimateSource("fallback", "当前环境不支持原生精确预估"));
      return () => controller.abort();
    }
    void (async () => {
      try {
        const request = {
          fileName: selectedItem.file.name,
          inputData: new Uint8Array(await selectedItem.file.arrayBuffer()),
          outputFormat: options.format,
          jpegQuality: options.quality,
          jpegBackground: options.format === "jpg" ? options.jpegBackground : undefined,
          webpMethod: options.webpMethod,
          webpNearLossless: options.webpNearLossless ?? undefined,
          lossless: options.format === "png" || (options.format === "webp" && options.lossless),
          metadataPolicy: options.metadataPolicy,
          skipIfLarger: options.skipIfLarger,
          pngOptimizationLevel: options.pngOptimizationLevel,
          maxOutputBytes: options.maxOutputBytes,
          maxCandidates: options.maxCandidates,
        };
        if (!isCurrentCompressionEstimate(requestId, estimateRequestIdRef.current, controller.signal.aborted)) return;
        const result = await estimateImageCompression(request);
        if (!isCurrentCompressionEstimate(requestId, estimateRequestIdRef.current, controller.signal.aborted)) return;
        setEstimate({ inputBytes: result.inputBytes, estimatedBytes: result.outputBytes, savingsPercent: result.savingsPercent, metadataPolicy: result.metadataPolicy, candidateSearchMs: result.candidateSearchMs, candidateCount: result.candidateCount });
        setEstimateNote(formatCompressionEstimateSource("native", result.status === "skipped" && result.skippedReason ? `输出将跳过：${result.skippedReason}` : "当前选中图片"));
      } catch (error) {
        if (!isCurrentCompressionEstimate(requestId, estimateRequestIdRef.current, controller.signal.aborted)) return;
        setEstimateNote(formatCompressionEstimateSource("fallback", `原生预估失败：${errorMessage(error)}`));
      }
    })();
    return () => controller.abort();
  }, [active, busy, items, options, selectedItem]);

  useEffect(() => {
    if (replaceOriginal && !replaceOriginalAvailable) setReplaceOriginal(false);
  }, [replaceOriginal, replaceOriginalAvailable]);

  useEffect(() => {
    if ((replaceOriginal || !deleteSourceAvailable) && deleteSource) setDeleteSource(false);
  }, [deleteSource, deleteSourceAvailable, replaceOriginal]);

  useEffect(() => {
    saveCompressionPreferences({
      format,
      quality,
      webpMethod,
      webpNearLossless,
      jpegBackground,
      pngOptimizationLevel,
      targetSizeEnabled: targetSizeActive,
      targetSizeKiB,
      maxCandidates,
      skipIfLarger,
      lossless,
      preset,
      metadataPolicy,
      outputLocation,
      outputFileName: outputFileNameError ? "" : outputFileName.trim(),
      outputSubdirectory,
      overwrite,
      autoNumbering,
      replaceOriginal,
      deleteSource,
    });
  }, [autoNumbering, deleteSource, format, lossless, maxCandidates, metadataPolicy, outputFileName, outputFileNameError, outputLocation, outputSubdirectory, overwrite, pngOptimizationLevel, preset, quality, replaceOriginal, skipIfLarger, targetSizeActive, targetSizeKiB, webpMethod, webpNearLossless, jpegBackground]);

  useEffect(() => {
    if (!selectedItemId || !items.some((item) => item.id === selectedItemId)) setSelectedItemId(items[0]?.id ?? null);
  }, [items, selectedItemId]);

  useEffect(() => {
    if (!selectedItem) {
      setOriginalPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(selectedItem.file);
    setOriginalPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedItem]);

  useEffect(() => {
    if (!preview) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([new Uint8Array(preview.data)], { type: previewMimeType(preview.format) }));
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [preview]);

  useEffect(() => {
    const requestId = ++previewRequestIdRef.current;
    const controller = new AbortController();
    setPreview(null);
    setPreviewError("");
    if (!active || !selectedItem) {
      setPreviewBusy(false);
      return () => controller.abort();
    }
    if (!isTauriEnvironment()) {
      setPreviewBusy(false);
      setPreviewError("真实压缩预览需要桌面应用；当前环境只显示原图和参数估算。");
      return () => controller.abort();
    }
    setPreviewBusy(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (!selectedItem.sourcePath) throw new Error("当前图片没有可用的桌面源路径。");
          const nativeFile: NativeImageFile = { path: selectedItem.sourcePath, fileName: selectedItem.file.name, data: Array.from(new Uint8Array(await selectedItem.file.arrayBuffer())) };
          const result = await previewCompression(createCompressionRequest(nativeFile, options), controller.signal);
          if (requestId !== previewRequestIdRef.current) return;
          setPreview(result);
        } catch (error) {
          if (requestId !== previewRequestIdRef.current || (error instanceof DOMException && error.name === "AbortError")) return;
          setPreviewError(errorMessage(error));
        } finally {
          if (requestId === previewRequestIdRef.current) setPreviewBusy(false);
        }
      })();
    }, 260);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, options, selectedItem]);

  const addBrowserFiles = (files: File[], replaceItemId: string | null = null) => {
    const { accepted, unsupported, oversized } = splitCompressionImportFiles(files);
    const next = toBrowserItems(accepted);
    const importErrorsForFiles = [
      ...unsupported.map((file, index) => ({ id: `browser-${file.name}-${file.lastModified}-${file.size}-${index}`, fileName: file.name, message: "格式不受支持，仅支持 PNG、JPEG、WebP、BMP、GIF。" })),
      ...oversized.map((file, index) => ({ id: `browser-size-${file.name}-${file.lastModified}-${file.size}-${index}`, fileName: file.name, message: `文件超过 ${COMPRESSION_MAX_INPUT_BYTES / (1024 * 1024)} MiB 输入限制。` })),
    ];
    if (next.length === 0) {
      setImportErrors(importErrorsForFiles);
      setMessage(importErrorsForFiles.length > 0 ? "没有可导入的图片；请检查格式和 32 MiB 输入限制。" : "没有找到支持的图片格式（PNG、JPEG、WebP、BMP、GIF）。");
      setStatus("error");
      return;
    }
    const merged = mergeCompressionItems(items, next, replaceItemId);
    setItems(merged.items);
    merged.itemsToHydrate.forEach(queueCompressionDimensions);
    if (merged.replacingExisting) setSelectedItemId(replaceItemId);
    setMessage(merged.replacingExisting ? "已替换当前图片。" : "");
    setImportErrors(importErrorsForFiles);
    setFailures([]);
    setFailureDetails([]);
    setItemResults([]);
    setSkipReasons([]);
    setResultStats({ total: 0, succeeded: 0, skipped: 0, failed: 0, inputBytes: 0, processedInputBytes: 0, outputBytes: 0, savedBytes: 0, targetMet: null, selectedQualities: [] });
    setStatus("ready");
  };

  const importNativeFiles = async (nativeFiles: NativeImageFile[], replaceItemId: string | null = null, directorySkipped: string[] = []) => {
    setImportErrors([]);
    const imported: CompressionItem[] = [];
    const skipped: Array<{ fileName: string; message: string }> = [];
    for (const nativeFile of nativeFiles) {
      try {
        imported.push(nativeFileToItem(nativeFile));
      } catch (error) {
        skipped.push({ fileName: nativeFile.fileName, message: errorMessage(error) });
      }
    }
    if (imported.length > 0) {
      const merged = mergeCompressionItems(items, imported, replaceItemId);
      setItems(merged.items);
      merged.itemsToHydrate.forEach(queueCompressionDimensions);
      if (merged.replacingExisting) {
        setSelectedItemId(replaceItemId);
        setMessage(nativeFiles.length > 1 ? "已替换当前图片（仅使用所选文件中的第一张）。" : "已替换当前图片。");
      }
      setFailures([]);
      setFailureDetails([]);
      setItemResults([]);
      setSkipReasons([]);
      setResultStats({ total: 0, succeeded: 0, skipped: 0, failed: 0, inputBytes: 0, processedInputBytes: 0, outputBytes: 0, savedBytes: 0, targetMet: null, selectedQualities: [] });
      setStatus("ready");
    }
    const importFailures = [...directorySkipped.map((fileName) => ({ fileName, message: "读取失败或被文件夹扫描跳过。" })), ...skipped];
    if (importFailures.length > 0) {
      setMessage(`有 ${importFailures.length} 个文件导入失败，已跳过。`);
      setImportErrors(importFailures.map(({ fileName, message }, index) => ({ id: `native-${fileName}-${index}`, fileName, message })));
      setFailures([]);
      setFailureDetails([]);
      setItemResults([]);
      setStatus(imported.length > 0 ? "ready" : "error");
    }
  };

  const chooseFiles = async () => {
    if (sourceBusy) return;
    if (!isTauriEnvironment()) {
      fileInputRef.current?.click();
      return;
    }
    setImportBusy(true);
    try {
      const replaceItemId = replaceItemIdRef.current;
      await importNativeFiles(await pickCompressionFiles(), replaceItemId);
    } catch (error) {
      setMessage(errorMessage(error));
      setStatus("error");
    } finally {
      replaceItemIdRef.current = null;
      setImportBusy(false);
    }
  };

  const chooseDirectory = async () => {
    if (sourceBusy) return;
    if (!isTauriEnvironment()) {
      setMessage("导入文件夹仅在桌面应用中可用；当前预览环境可使用“选择图片”后多选文件。");
      setStatus("error");
      return;
    }
    setImportBusy(true);
    try {
      const result = await pickCompressionDirectoryResult();
      if (result) await importNativeFiles(result.files, null, result.skipped);
    } catch (error) {
      setMessage(errorMessage(error));
      setStatus("error");
    } finally {
      setImportBusy(false);
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const replaceItemId = replaceItemIdRef.current;
    replaceItemIdRef.current = null;
    addBrowserFiles(Array.from(event.target.files ?? []), replaceItemId);
    event.target.value = "";
  };

  const replaceSelectedItem = () => {
    if (sourceBusy || !selectedItemId) return;
    replaceItemIdRef.current = selectedItemId;
    void chooseFiles();
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!sourceBusy) addBrowserFiles(Array.from(event.dataTransfer.files));
  };

  const monitorCompressionProgress = async (jobId: string) => {
    while (activeJobIdRef.current === jobId) {
      try {
        const next = await getCompressionProgress(jobId);
        setStage(next.stage);
        setProgressBytes((current) => ({
          input: typeof next.inputBytes === "number" ? next.inputBytes : current.input,
          output: typeof next.outputBytes === "number" ? next.outputBytes : current.output,
        }));
        const progressError = formatCompressionProgressError(next);
        if (progressError) setMessage(progressError);
      } catch {
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 160));
    }
  };

  const cancelActiveCompression = async () => {
    const jobId = activeJobIdRef.current;
    if (!jobId) return;
    setMessage("正在取消当前压缩任务…");
    try {
      await cancelCompression(jobId);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };

  const runCompression = async () => {
    if (busy || items.length === 0) return;
    if (outputFileNameError) {
      setMessage(outputFileNameError);
      setStatus("error");
      return;
    }
    if (targetSizeError) {
      setMessage(targetSizeError);
      setStatus("error");
      return;
    }
    if (outputLocationError) {
      setMessage(outputLocationError);
      setStatus("error");
      return;
    }
    if (!isTauriEnvironment()) {
      setMessage("压缩需要桌面应用的原生命令；当前浏览器预览仅支持编辑参数和估算大小。");
      setStatus("error");
      return;
    }
    const queue = getCompressionRetryQueue(items, failures);
    if (replaceOriginal) {
      if (!canReplaceCompressionOriginal(queue, true)) {
        const missingSourceItems = queue.filter((item) => !item.sourcePath);
        const sourceError = getCompressionSourcePathError(outputLocation, false, true) ?? "覆盖原图需要可访问的桌面源文件路径。";
        setImportErrors((current) => [...current.filter((entry) => !missingSourceItems.some((item) => item.id === entry.id)), ...missingSourceItems.map((item) => ({ id: item.id, fileName: item.file.name, message: sourceError }))]);
        setItemResults((current) => [...current, ...missingSourceItems.map((item) => ({ itemId: item.id, fileName: item.file.name, status: "failed" as const, reason: sourceError }))]);
        setFailureDetails((current) => [...current, ...missingSourceItems.map((item) => ({ itemId: item.id, fileName: item.file.name, message: sourceError }))]);
        setFailures(missingSourceItems.map((item) => item.id));
        setResultStats({ total: queue.length, succeeded: 0, skipped: 0, failed: missingSourceItems.length, inputBytes: queue.reduce((sum, item) => sum + item.size, 0), processedInputBytes: 0, outputBytes: 0, savedBytes: 0, targetMet: null, selectedQualities: [] });
        setProgress({ current: queue.length, total: queue.length });
        setMessage("部分文件缺少可访问的桌面源路径，未开始覆盖原图。");
        setStatus("error");
        return;
      }
      const sourcePaths = queue.map((item) => item.sourcePath as string);
      if (!window.confirm(formatCompressionReplaceOriginalConfirmation(sourcePaths))) {
        setMessage("已取消覆盖原图，未开始压缩。");
        setStatus("ready");
        return;
      }
    }
    if (deleteSource) {
      if (!canDeleteCompressionSource(queue, true)) {
        setMessage("删除源文件需要所有待处理项目都有可访问的桌面源路径。");
        setStatus("error");
        return;
      }
      const sourcePaths = queue.map((item) => item.sourcePath as string);
      if (!window.confirm(formatCompressionDeleteSourceConfirmation(sourcePaths))) {
        setMessage("已取消删除源文件，未开始压缩。");
        setStatus("ready");
        return;
      }
    }
    setStatus("busy");
    setMessage("");
    setStage("preflight");
    setFailures([]);
    setFailureDetails([]);
    setItemResults([]);
    setSkipReasons([]);
    cancelRequestedRef.current = false;
    setResultStats({ total: queue.length, succeeded: 0, skipped: 0, failed: 0, inputBytes: queue.reduce((sum, item) => sum + item.size, 0), processedInputBytes: 0, outputBytes: 0, savedBytes: 0, targetMet: null, selectedQualities: [] });
    setPreflightSpaceBytes(null);
    setProgress({ current: 0, total: queue.length });
    setProgressBytes({ input: null, output: null });
    const failedNames: string[] = [];
    const failedItemIds: string[] = [];
    let lastError = "";
    for (const [index, item] of queue.entries()) {
      setCurrentFileName(item.file.name);
      setStage("preflight");
      const jobId = `compression-${Date.now()}-${index}`;
      try {
        const sourcePathError = getCompressionSourcePathError(outputLocation, Boolean(item.sourcePath), replaceOriginal);
        if (sourcePathError) {
          failedNames.push(item.file.name);
          failedItemIds.push(item.id);
          lastError = sourcePathError;
          setImportErrors((current) => [...current.filter((entry) => entry.id !== item.id), { id: item.id, fileName: item.file.name, message: sourcePathError }]);
          setItemResults((current) => [...current, { itemId: item.id, fileName: item.file.name, status: "failed", reason: sourcePathError }]);
          setFailureDetails((current) => [...current, { itemId: item.id, fileName: item.file.name, message: sourcePathError }]);
          setResultStats((current) => ({ ...current, failed: current.failed + 1 }));
          setProgress({ current: index + 1, total: queue.length });
          continue;
        }
        const nativeFile: NativeImageFile = { path: item.sourcePath ?? "", fileName: item.file.name, data: Array.from(new Uint8Array(await item.file.arrayBuffer())) };
        const request = createCompressionRequest(nativeFile, options, jobId);
        const preflight = await preflightCompression(request);
        setPreflightSpaceBytes(typeof preflight.requiredSpaceBytes === "number" ? preflight.requiredSpaceBytes : null);
        if (preflight.overwritesExisting && !options.overwrite) {
          setResultStats((current) => ({ ...current, skipped: current.skipped + 1 }));
          setItemResults((current) => [...current, { itemId: item.id, fileName: item.file.name, status: "skipped", reason: "同名目标已存在" }]);
          setSkipReasons((current) => [...current, `${item.file.name}：同名目标已存在`]);
          setMessage(`已跳过同名目标：${item.file.name}`);
          setProgress({ current: index + 1, total: queue.length });
          continue;
        }
        activeJobIdRef.current = jobId;
        const progressPoll = monitorCompressionProgress(jobId);
        const result = await compressImage(request);
        activeJobIdRef.current = null;
        await progressPoll;
        if (result.status === "skipped") {
          const skippedReason = result.skippedReason || "原生压缩策略跳过，未发布输出";
          const itemMetrics = getCompressionItemResultMetrics(result, item.size);
          setResultStats((current) => ({ ...current, skipped: current.skipped + 1, targetMet: result.targetMet ?? (options.maxOutputBytes === undefined ? current.targetMet : false) }));
          setItemResults((current) => [...current, { itemId: item.id, fileName: item.file.name, status: "skipped", reason: skippedReason, candidateSearchMs: result.candidateSearchMs, candidateCount: result.candidateCount, ...itemMetrics }]);
          setSkipReasons((current) => [...current, `${item.file.name}：${skippedReason}`]);
          setMessage(`已跳过 ${item.file.name}：${skippedReason}`);
        } else {
          const successfulOutputPath = getSuccessfulCompressionOutputPath(result.status, result.outputPath);
          const itemMetrics = getCompressionItemResultMetrics(result, item.size);
          if (successfulOutputPath) setLastSuccessfulOutputPath(successfulOutputPath);
          setItemResults((current) => [...current, { itemId: item.id, fileName: item.file.name, status: "completed", outputPath: successfulOutputPath ?? undefined, reason: successfulOutputPath ? undefined : "原生结果未返回输出路径", sourceDeleted: result.sourceDeleted === true, candidateSearchMs: result.candidateSearchMs, candidateCount: result.candidateCount, ...itemMetrics }]);
          const targetMet = result.targetMet ?? (options.maxOutputBytes === undefined ? null : result.outputBytes <= options.maxOutputBytes);
          setResultStats((current) => ({ ...current, succeeded: current.succeeded + 1, processedInputBytes: current.processedInputBytes + result.inputBytes, outputBytes: current.outputBytes + result.outputBytes, savedBytes: current.savedBytes + result.savedBytes, targetMet: targetMet === null ? current.targetMet : current.targetMet === false || targetMet === false ? false : true, selectedQualities: typeof result.selectedQuality === "number" ? [...current.selectedQualities, result.selectedQuality] : current.selectedQualities }));
        }
      } catch (error) {
        let detail = errorMessage(error);
        try {
          const finalProgress = await getCompressionProgress(jobId);
          detail = formatCompressionProgressError(finalProgress) ?? detail;
        } catch {
          // A preflight or transport failure may not leave a readable native progress record.
        }
        activeJobIdRef.current = null;
        failedNames.push(item.file.name);
        failedItemIds.push(item.id);
        if (isCompressionSourcePathError(detail)) {
          setImportErrors((current) => [...current.filter((entry) => entry.id !== item.id), { id: item.id, fileName: item.file.name, message: "桌面源文件不可访问，未导出。" }]);
        }
        setItemResults((current) => [...current, { itemId: item.id, fileName: item.file.name, status: "failed", reason: detail }]);
        setFailureDetails((current) => [...current, { itemId: item.id, fileName: item.file.name, message: detail }]);
        lastError = detail;
        setResultStats((current) => ({ ...current, failed: current.failed + 1 }));
        if (cancelRequestedRef.current) {
          setItemResults((current) => [...current, ...getCompressionCancelledItemResults(queue, index)]);
          setResultStats((current) => ({ ...current, skipped: current.skipped + queue.length - index - 1 }));
          setMessage("已取消当前任务，其余文件未处理。");
          setProgress({ current: queue.length, total: queue.length });
          break;
        }
      }
      setProgress({ current: index + 1, total: queue.length });
    }
    activeJobIdRef.current = null;
    setCurrentFileName(null);
    const finalState = getCompressionBatchFinalState(failedNames, cancelRequestedRef.current);
    if (finalState.status === "error") {
      setFailures(failedItemIds);
      setStage(finalState.stage);
      setMessage(cancelRequestedRef.current ? "已取消当前任务，其余文件未处理。" : `部分任务完成，请查看统计。${lastError ? ` ${lastError}` : ""}`);
      setStatus("error");
    } else {
      setStatus("success");
      setStage(finalState.stage);
      setMessage("处理完成，请查看成功、跳过和节省统计。");
    }
  };

  const removeItem = (id: string) => {
    if (sourceBusy) return;
    const removedItem = items.find((item) => item.id === id);
    if (!removedItem) return;
    const nextItems = removeCompressionItem(items, id);
    setItems(nextItems);
    setFailures([]);
    setFailureDetails([]);
    setItemResults([]);
    setSkipReasons([]);
    setResultStats({ total: 0, succeeded: 0, skipped: 0, failed: 0, inputBytes: 0, processedInputBytes: 0, outputBytes: 0, savedBytes: 0, targetMet: null, selectedQualities: [] });
    setMessage("");
    setStatus(nextItems.length > 0 ? "ready" : "idle");
  };

  const clearItems = () => {
    if (sourceBusy) return;
    setItems([]);
    setSelectedItemId(null);
    setFailures([]);
    setFailureDetails([]);
    setItemResults([]);
    setImportErrors([]);
    setSkipReasons([]);
    setResultStats({ total: 0, succeeded: 0, skipped: 0, failed: 0, inputBytes: 0, processedInputBytes: 0, outputBytes: 0, savedBytes: 0, targetMet: null, selectedQualities: [] });
    setMessage("");
    setStatus("idle");
  };

  const applyPreset = (nextPreset: CompressionPreset) => {
    setPreset(nextPreset);
    setCustomPresetId("");
    if (nextPreset === "custom") return;
    const values = getCompressionPreset(nextPreset);
    setQuality(values.quality);
    setWebpMethod(COMPRESSION_WEBP_METHOD_DEFAULT);
    setWebpNearLossless(null);
    setJpegBackground(initialPreferences.jpegBackground);
    setMaxCandidates(COMPRESSION_MAX_CANDIDATES_DEFAULT);
    setPngOptimizationLevel(values.pngOptimizationLevel);
    setSkipIfLarger(true);
  };

  const currentCustomPresetValues = (): CompressionPresetValues => ({ format, quality, webpMethod, webpNearLossless, jpegBackground, pngOptimizationLevel, targetSizeEnabled: targetSizeActive, targetSizeKiB, maxCandidates, lossless, metadataPolicy, skipIfLarger });

  const applyCustomPreset = (id: string) => {
    setCustomPresetId(id);
    const selected = customPresets.find((item) => item.id === id);
    if (!selected) return;
    setFormat(selected.values.format);
    setQuality(selected.values.quality);
    setWebpMethod(selected.values.webpMethod ?? COMPRESSION_WEBP_METHOD_DEFAULT);
    setWebpNearLossless(selected.values.webpNearLossless ?? null);
    setJpegBackground(selected.values.jpegBackground ?? "#ffffff");
    setPngOptimizationLevel(selected.values.pngOptimizationLevel);
    setTargetSizeEnabled(selected.values.targetSizeEnabled);
    setTargetSizeKiB(selected.values.targetSizeKiB);
    setMaxCandidates(selected.values.maxCandidates ?? COMPRESSION_MAX_CANDIDATES_DEFAULT);
    setSkipIfLarger(selected.values.skipIfLarger);
    setLossless(selected.values.lossless);
    setMetadataPolicy(selected.values.metadataPolicy);
    setPreset("custom");
    setCustomPresetMessage(`已应用自定义预设“${selected.name}”`);
  };

  const saveCurrentAsCustomPreset = () => {
    const name = customPresetName.trim();
    if (!name) return;
    try {
      const created = createCompressionCustomPreset(name, currentCustomPresetValues());
      const next = mergeCompressionCustomPresets(customPresets, [created]);
      setCustomPresets(next);
      saveCompressionCustomPresets(next);
      setCustomPresetId(next[next.length - 1]?.id ?? "");
      setCustomPresetName("");
      setCustomPresetMessage(`已保存自定义预设“${next[next.length - 1]?.name ?? name}”`);
    } catch (error) {
      setCustomPresetMessage(errorMessage(error));
    }
  };

  const downloadCustomPresets = () => {
    downloadBlob(new Blob([exportCompressionPresetsJson(customPresets)], { type: "application/json" }), "embedpix-compression-presets.json");
    setCustomPresetMessage("压缩预设 JSON 已导出");
  };

  const importCustomPresets = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const incoming = importCompressionPresetsJson(await file.text());
      const next = mergeCompressionCustomPresets(customPresets, incoming);
      setCustomPresets(next);
      saveCompressionCustomPresets(next);
      setCustomPresetMessage(`已导入 ${incoming.length} 个压缩预设，重复名称已自动编号`);
    } catch (error) {
      setCustomPresetMessage(errorMessage(error));
    }
  };

  const copyOutputPath = async (outputPath: string) => {
    try {
      if (!navigator.clipboard) throw new Error("当前环境不支持复制，请手动选择输出路径。");
      await navigator.clipboard.writeText(outputPath);
      setMessage("输出路径已复制");
      setStatus("ready");
    } catch (error) {
      setMessage(errorMessage(error));
      setStatus("error");
    }
  };

  const copyFailureDetails = async () => {
    if (!failureDetails.length) return;
    try {
      if (!navigator.clipboard) throw new Error("当前环境不支持复制，请手动选择失败详情。");
      await navigator.clipboard.writeText(formatCompressionFailureDetails(failureDetails));
      setMessage("失败详情已复制");
      setStatus("ready");
    } catch (error) {
      setMessage(errorMessage(error));
      setStatus("error");
    }
  };

  const openOutputFolder = async (outputPath: string) => {
    try {
      await revealImageOutput(outputPath);
      setMessage("已打开输出文件夹");
      setStatus("ready");
    } catch (error) {
      setMessage(errorMessage(error));
      setStatus("error");
    }
  };

  return (
    <section className="compression-app" aria-label="图片压缩工作台">
      <header className="compression-header">
        <div>
          <p className="compression-kicker">IMAGE COMPRESSION</p>
          <h1>图片压缩</h1>
          <p>批量压缩图片体积，保留对嵌入式 UI 有用的格式与参数控制。</p>
        </div>
        <div className="compression-header-note"><FileDown size={17} aria-hidden="true" /> 桌面原生队列</div>
      </header>

      <div className="compression-grid">
        <div className="compression-card compression-input-card">
          <div className="compression-card-heading">
            <div><span className="compression-card-kicker">01 / SOURCE</span><h2>导入图片</h2></div>
            <div className="compression-heading-actions"><span className="compression-count">{items.length} 个文件</span>{items.length > 0 ? <button type="button" className="compression-clear-button" onClick={clearItems} disabled={sourceBusy}>清空</button> : null}</div>
          </div>
          <div
            className={`compression-drop-zone${dragging ? " compression-drop-zone-dragging" : ""}${sourceBusy ? " compression-drop-zone-disabled" : ""}`}
            onDragEnter={(event) => { event.preventDefault(); if (!sourceBusy) setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            role="button"
            tabIndex={sourceBusy ? -1 : 0}
            aria-disabled={sourceBusy}
            onKeyDown={(event) => { if (!sourceBusy && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); void chooseFiles(); } }}
            onClick={() => { void chooseFiles(); }}
          >
            <span className="compression-drop-icon"><Upload size={22} aria-hidden="true" /></span>
            <strong>拖放图片到这里</strong>
            <span>或点击选择多个文件</span>
            <small>支持 PNG / JPEG / WebP / BMP / GIF；单张输入不超过 {COMPRESSION_MAX_INPUT_BYTES / (1024 * 1024)} MiB；输出格式为 PNG / JPEG / WebP</small>
          </div>
          <input ref={fileInputRef} className="visually-hidden" type="file" accept="image/*,.bmp,.gif,.webp" multiple onChange={handleFileChange} disabled={sourceBusy} />
          <div className="compression-source-actions">
            <button type="button" className="compression-secondary-button" onClick={() => { void chooseFiles(); }} disabled={sourceBusy}><Images size={15} aria-hidden="true" /> {importBusy ? "正在导入" : "选择图片"}</button>
            <button type="button" className="compression-secondary-button" onClick={replaceSelectedItem} disabled={sourceBusy || !selectedItemId}><RefreshCw size={15} aria-hidden="true" /> 替换当前</button>
            <button type="button" className="compression-secondary-button" onClick={() => { void chooseDirectory(); }} disabled={sourceBusy}><FolderOpen size={15} aria-hidden="true" /> 导入文件夹</button>
          </div>
          <div className="compression-list" aria-label="待压缩图片列表">
            {items.length === 0 ? <p className="compression-empty">导入后将在这里显示文件、原始大小与来源。</p> : items.map((item) => (
              <div className="compression-item" key={item.id}>
                <button type="button" className={`compression-item-select${selectedItemId === item.id ? " compression-item-selected" : ""}`} aria-pressed={selectedItemId === item.id} onClick={() => { if (!sourceBusy) setSelectedItemId(item.id); }} disabled={sourceBusy}>
                  <div className="compression-item-icon"><Images size={15} aria-hidden="true" /></div>
                  <span className="compression-item-copy"><strong>{item.file.name}</strong><span>{item.dimensions ? `${item.dimensions.width} × ${item.dimensions.height} px` : "读取尺寸中"} · {getCompressionInputFormat(item.file)} · {formatCompressionBytes(item.size)}{item.sourcePath ? " · 桌面文件" : " · 浏览器文件"}</span></span>
                </button>
                <button type="button" className="compression-icon-button" aria-label={`移除 ${item.file.name}`} onClick={() => removeItem(item.id)} disabled={sourceBusy}><Trash2 size={15} aria-hidden="true" /></button>
              </div>
            ))}
          </div>
          {importErrors.length > 0 ? <div className="compression-import-errors" role="alert" aria-label="导入问题"><strong>导入问题</strong>{importErrors.map((entry) => <span key={entry.id}>{entry.fileName}：{entry.message}</span>)}</div> : null}
        </div>

        <aside className="compression-card compression-settings-card">
          <div className="compression-card-heading"><div><span className="compression-card-kicker">02 / OPTIONS</span><h2>压缩参数</h2></div></div>
          <label className="compression-field"><span>内置预设</span><select value={preset} onChange={(event) => applyPreset(event.target.value as CompressionPreset)} disabled={busy}><option value="custom">自定义</option>{COMPRESSION_PRESETS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small className="compression-field-hint">{preset === "custom" ? "手动参数；JPEG/WebP 有损质量、PNG 优化和 WebP 无损语义分别生效" : getCompressionPreset(preset).description}</small></label>
          <div className="compression-custom-presets" aria-label="自定义压缩预设">
            <label className="compression-field"><span>自定义预设</span><select value={customPresetId} onChange={(event) => applyCustomPreset(event.target.value)} disabled={busy}><option value="">选择已保存预设</option>{customPresets.map((customPreset) => <option key={customPreset.id} value={customPreset.id}>{customPreset.name}</option>)}</select></label>
            <div className="compression-preset-save-row"><input className="compression-preset-name" value={customPresetName} placeholder="预设名称" aria-label="压缩预设名称" onChange={(event) => setCustomPresetName(event.target.value)} disabled={busy} /><button type="button" className="compression-secondary-button" disabled={busy || !customPresetName.trim()} onClick={saveCurrentAsCustomPreset}>保存当前参数</button></div>
            <div className="compression-preset-actions"><button type="button" className="compression-secondary-button" onClick={downloadCustomPresets} disabled={busy}>导出 JSON</button><button type="button" className="compression-secondary-button" onClick={() => presetFileInputRef.current?.click()} disabled={busy}>导入 JSON</button><input ref={presetFileInputRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => { void importCustomPresets(event); }} disabled={busy} /></div>
            {customPresetMessage ? <p className="compression-preset-message" role="status">{customPresetMessage}</p> : null}
          </div>
          <label className="compression-field"><span>输出格式</span><select value={format} onChange={(event) => { const nextFormat = event.target.value as CompressionFormat; setFormat(nextFormat); setLossless(nextFormat !== "jpg"); if (nextFormat !== "jpg") setTargetSizeEnabled(false); }} disabled={busy}>{COMPRESSION_FORMATS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="compression-field"><span>PNG 优化级别</span><select value={pngOptimizationLevel} onChange={(event) => { setPngOptimizationLevel(Number(event.target.value)); setPreset("custom"); }} disabled={busy || format !== "png"}>{[0, 1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>{level}</option>)}</select><small className="compression-field-hint">{format === "png" ? "0 最快，6 压缩更积极；默认 2" : "仅 PNG 有效，当前格式不可用"}</small></label>
          <label className="compression-field"><span className="compression-label-row"><span>质量（JPEG/WebP 有损）</span><strong>{qualityEnabled ? quality : "—"}</strong></span><input type="range" min="1" max="100" value={quality} onChange={(event) => { setQuality(Number(event.target.value)); setPreset("custom"); }} disabled={busy || !qualityEnabled} /></label>
          {format === "jpg" ? <label className="compression-field"><span>JPEG 透明背景</span><input type="color" value={jpegBackground} onChange={(event) => { setJpegBackground(event.target.value.toLowerCase()); setPreset("custom"); }} disabled={busy} aria-label="JPEG 透明背景颜色" /><small className="compression-field-hint">输入含透明像素时合成到此背景色；不再静默丢弃 Alpha，默认白色。</small></label> : null}
          <label className="compression-field"><span className="compression-label-row"><span>WebP 编码方法</span><strong>{webpLossyActive ? webpMethod : "—"}</strong></span><input type="range" min={COMPRESSION_WEBP_METHOD_MIN} max={COMPRESSION_WEBP_METHOD_MAX} step="1" value={webpMethod} onChange={(event) => { setWebpMethod(Number(event.target.value)); setPreset("custom"); }} disabled={busy || !webpLossyActive} /><small className="compression-field-hint compression-webp-method-hint">{webpLossyActive ? `范围 ${COMPRESSION_WEBP_METHOD_MIN}–${COMPRESSION_WEBP_METHOD_MAX}；影响编码耗时与压缩率，不代表画质。默认 ${COMPRESSION_WEBP_METHOD_DEFAULT}` : "仅 WebP 有损模式有效，当前模式已禁用"}</small></label>
          <label className="compression-check"><input type="checkbox" checked={format === "png" || (format === "webp" && lossless)} onChange={(event) => { if (format === "webp") { setLossless(event.target.checked); if (event.target.checked) setTargetSizeEnabled(false); setPreset("custom"); } }} disabled={busy || format !== "webp"} /><span><strong>{format === "webp" ? "WebP 无损编码" : format === "png" ? "PNG 无损编码" : "JPEG 有损编码"}</strong><small>{format === "jpg" ? "JPEG 使用质量滑块进行有损编码" : format === "webp" ? lossless ? "当前为无损 WebP；关闭后使用有损质量" : "当前为有损 WebP；质量滑块控制编码质量" : "PNG 始终无损，使用优化级别控制编码效率"}</small></span></label>
          {format === "webp" && lossless ? <label className="compression-field"><span>WebP 近无损等级</span><select value={webpNearLossless ?? ""} onChange={(event) => { const value = event.target.value; setWebpNearLossless(value ? Number(value) : null); setPreset("custom"); }} disabled={busy}><option value="">标准无损（像素完全一致）</option><option value="95">95 · 高保真</option><option value="90">90 · 平衡</option><option value="80">80 · 更小体积</option></select><small className="compression-field-hint">近无损会对 RGB 做受控量化；Alpha 仍保持无损。等级越高越接近原图，标准无损不做量化。</small></label> : null}
          <label className="compression-check"><input type="checkbox" checked={targetSizeActive} onChange={(event) => setTargetSizeEnabled(event.target.checked)} disabled={busy || !qualityEnabled} /><span><strong>启用目标体积控制</strong><small>{format === "jpg" ? `启用后输入最大输出体积；核心最多尝试 ${maxCandidates} 个 JPEG 质量候选` : format === "webp" && !lossless ? `启用后输入最大输出体积；核心最多尝试 ${maxCandidates} 个 WebP 质量候选` : "PNG 和无损 WebP 不支持目标体积控制"}</small></span></label>
          <label className="compression-field"><span className="compression-label-row"><span>最大输出体积（JPEG/WebP 有损）</span><strong>{targetSizeActive && targetSizeKiB ? `${targetSizeKiB} KiB` : "—"}</strong></span><input type="number" min="1" max={COMPRESSION_MAX_TARGET_SIZE_KIB} step="1" value={targetSizeKiB} onChange={(event) => setTargetSizeKiB(event.target.value)} placeholder="启用后输入 KiB" disabled={busy || !qualityEnabled || !targetSizeActive} aria-invalid={Boolean(targetSizeError)} /><small className="compression-field-hint">{format === "jpg" ? `JPEG 质量候选范围为 1–${COMPRESSION_MAX_TARGET_SIZE_KIB.toLocaleString()} KiB` : format === "webp" && !lossless ? `WebP 质量候选范围为 1–${COMPRESSION_MAX_TARGET_SIZE_KIB.toLocaleString()} KiB` : "PNG 和无损 WebP 不支持目标体积控制"}</small></label>
          {targetSizeActive ? <label className="compression-field"><span className="compression-label-row"><span>候选搜索次数</span><strong>{maxCandidates}</strong></span><input type="number" min={COMPRESSION_MAX_CANDIDATES_MIN} max={COMPRESSION_MAX_CANDIDATES_MAX} step="1" value={maxCandidates} onChange={(event) => { const next = Number(event.target.value); setMaxCandidates(Number.isFinite(next) ? Math.min(COMPRESSION_MAX_CANDIDATES_MAX, Math.max(COMPRESSION_MAX_CANDIDATES_MIN, Math.round(next))) : COMPRESSION_MAX_CANDIDATES_DEFAULT); setPreset("custom"); }} disabled={busy || !qualityEnabled} /><small className="compression-field-hint">次数越多越接近目标体积，但编码耗时会增加；范围 {COMPRESSION_MAX_CANDIDATES_MIN}–{COMPRESSION_MAX_CANDIDATES_MAX}，默认 {COMPRESSION_MAX_CANDIDATES_DEFAULT}。</small></label> : null}
          {targetSizeError ? <p className="compression-field-error" role="alert">{targetSizeError}</p> : null}
          <label className="compression-check"><input type="checkbox" checked={skipIfLarger} onChange={(event) => { setSkipIfLarger(event.target.checked); setPreset("custom"); }} disabled={busy} /><span><strong>压缩后更大时跳过</strong><small className={skipIfLarger ? undefined : "compression-skip-larger-warning"}>{skipIfLarger ? "仅发布不大于原图的结果；目标体积仍按上方限制执行。" : "风险模式：压缩结果可能比原图更大，仍会写出；请确认输出位置和覆盖策略。"}</small></span></label>
          <details className="compression-advanced-settings">
            <summary><strong>高级输出选项</strong><span>元数据、路径与覆盖策略</span></summary>
            <div className="compression-advanced-settings-body">
          <label className="compression-field"><span>元数据策略</span><select value={metadataPolicy} onChange={(event) => setMetadataPolicy(event.target.value as MetadataPolicy)} disabled={busy}><option value="strip">移除元数据（推荐）</option><option value="preserve" disabled>保留元数据（当前不可用：核心拒绝）</option></select><small className="compression-field-hint">第一阶段仅支持移除元数据；保留元数据请求会被核心拒绝。</small></label>
          <label className="compression-field"><span>输出位置</span><select value={outputLocation} onChange={(event) => setOutputLocation(event.target.value as CompressionOutputLocation)} disabled={busy || replaceOriginal}><option value="source">源文件夹</option><option value="subfolder">源文件夹子目录</option><option value="directory">指定目录</option></select></label>
          {outputLocation === "subfolder" ? <label className="compression-field"><span>子目录名称</span><input value={outputSubdirectory} onChange={(event) => setOutputSubdirectory(event.target.value)} placeholder="例如 compressed" spellCheck={false} aria-invalid={Boolean(outputLocationError)} disabled={busy || replaceOriginal} /></label> : null}
          {outputLocation === "directory" ? <label className="compression-field"><span>输出目录</span><input value={outputDirectory} onChange={(event) => setOutputDirectory(event.target.value)} placeholder="例如 D:\\Export" spellCheck={false} aria-invalid={Boolean(outputLocationError)} disabled={busy || replaceOriginal} /></label> : null}
          <label className="compression-field"><span>自定义输出文件名</span><input value={outputFileName} onChange={(event) => { setOutputFileName(event.target.value); setPreset("custom"); }} placeholder={`留空，自动使用 .${format}`} spellCheck={false} aria-invalid={Boolean(outputFileNameError)} disabled={busy || replaceOriginal} /><small className="compression-output-file-name-hint" role={outputFileNameError ? "alert" : undefined}>{replaceOriginal ? "覆盖原图模式不使用自定义文件名。" : outputFileNameError ?? `可选；扩展名会自动规范为 .${format}，自动序号仍可继续生效。`}</small></label>
          {outputLocationError ? <p className="compression-field-error" role="alert">{outputLocationError}</p> : null}
          <label className="compression-check"><input type="checkbox" checked={outputModes.replaceOriginal && replaceOriginalAvailable} onChange={(event) => { const checked = event.target.checked; setReplaceOriginal(checked); if (checked) { setDeleteSource(false); setAutoNumbering(false); setOverwrite(false); } }} disabled={busy || !replaceOriginalAvailable} /><span><strong>覆盖原图并备份到 bak</strong><small>{replaceOriginalAvailable ? "启用后会先备份原图，再写入压缩结果；输出位置、自动序号和覆盖同名均不适用" : isTauriEnvironment() ? "仅全部桌面源文件队列可用，浏览器文件或混合队列会禁用" : "仅桌面应用支持覆盖原图"}</small></span></label>
          <label className="compression-check compression-check-danger"><input type="checkbox" checked={deleteSource && deleteSourceAvailable} onChange={(event) => setDeleteSource(event.target.checked)} disabled={busy || replaceOriginal || !deleteSourceAvailable} /><span><strong>导出成功后删除源文件</strong><small>{replaceOriginal ? "覆盖原图模式不适用删除源文件" : deleteSourceAvailable ? "仅对应输出成功并通过校验后删除；导出前需要再次确认" : isTauriEnvironment() ? "仅全部桌面源文件队列可用，浏览器文件或混合队列会禁用" : "仅桌面应用支持删除源文件"}</small></span></label>
          <label className="compression-check"><input type="checkbox" checked={outputModes.autoNumbering} onChange={(event) => { const checked = event.target.checked; setAutoNumbering(checked); if (checked) setOverwrite(false); }} disabled={busy || outputModes.replaceOriginal} /><span><strong>自动序号避免重名</strong><small>{outputModes.replaceOriginal ? "覆盖原图模式不适用自动序号" : "同名时自动使用 _1、_2 等序号；输出位置仍按上方设置"}</small></span></label>
          <label className="compression-check"><input type="checkbox" checked={outputModes.overwrite} onChange={(event) => setOverwrite(event.target.checked)} disabled={busy || outputModes.autoNumbering || outputModes.replaceOriginal} /><span><strong>允许覆盖同名文件</strong><small>{outputModes.autoNumbering ? "自动序号已启用，同名目标会改用下一个序号" : outputModes.replaceOriginal ? "覆盖原图模式不使用同名目标覆盖" : "关闭时同名目标会拒绝写入"}</small></span></label>
            </div>
          </details>
        </aside>
      </div>

      <section className="compression-card compression-preview-card" aria-live="polite" aria-label="压缩预览">
        <div className="compression-card-heading"><div><span className="compression-card-kicker">03 / PREVIEW</span><h2>真实压缩预览</h2></div><span className="compression-count">{selectedItem?.file.name ?? "未选择图片"}</span></div>
        {selectedItem ? <div className="compression-preview-grid">
          <figure className="compression-preview-pane"><figcaption>原图<span>{formatCompressionBytes(selectedItem.size)}</span></figcaption><div className="compression-preview-stage">{originalPreviewUrl ? <img src={originalPreviewUrl} alt={`原图 ${selectedItem.file.name}`} /> : null}</div></figure>
          <figure className="compression-preview-pane"><figcaption>压缩后{preview ? <span>{formatCompressionBytes(preview.outputBytes)}</span> : null}</figcaption><div className="compression-preview-stage">{previewUrl ? <img src={previewUrl} alt={`压缩预览 ${selectedItem.file.name}`} /> : previewBusy ? <LoaderCircle size={20} className="compression-spin" aria-label="正在生成预览" /> : <span className="compression-preview-placeholder">{previewError || "等待预览"}</span>}</div></figure>
        </div> : <p className="compression-empty">选择一张图片后查看原图与真实压缩结果。</p>}
        {preview ? <div className="compression-preview-stats"><span>尺寸 {preview.width} × {preview.height}</span><span>输出 {formatCompressionBytes(preview.outputBytes)}</span><span className={previewSavedBytes >= 0 ? "compression-saving" : "compression-failure"}>{previewSavedBytes >= 0 ? `节省 ${formatCompressionBytes(previewSavedBytes)} · ${previewSavingsPercent.toFixed(0)}%` : `增加 ${formatCompressionBytes(Math.abs(previewSavedBytes))}`}</span>{maxOutputBytes ? <span className={preview.targetMet ? "compression-saving" : "compression-failure"}>目标 {preview.targetMet ? "已达成" : "未达成"}</span> : null}{typeof preview.selectedQuality === "number" ? <span>选中质量 {preview.selectedQuality}</span> : null}{typeof preview.candidateCount === "number" ? <span>尝试候选 {preview.candidateCount}</span> : null}{typeof preview.candidateSearchMs === "number" ? <span>候选搜索 {preview.candidateSearchMs} ms</span> : null}{preview.qualityMetrics ? <span title="基于解码后的输入和输出逐像素计算，仅供相对比较，不等同主观画质">RGB MAE {preview.qualityMetrics.rgbMae.toFixed(2)} · PSNR {preview.qualityMetrics.psnrDb === null ? "无误差" : `${preview.qualityMetrics.psnrDb.toFixed(1)} dB`} · Alpha 差异 {preview.qualityMetrics.alphaMismatchPixels} 像素</span> : null}{preview.status === "skipped" ? <span className="compression-failure">预览跳过：{preview.skippedReason || "未发布输出"}</span> : null}</div> : null}
      </section>

      {preview ? <p className="compression-estimate-note">预览实际元数据策略：{preview.metadataPolicy === "strip" ? "已移除" : preview.metadataPolicy}</p> : null}
      {estimate.metadataPolicy ? <p className="compression-estimate-note">估算实际元数据策略：{estimate.metadataPolicy === "strip" ? "已移除" : estimate.metadataPolicy}</p> : null}
      <section className="compression-card compression-summary-card" aria-live="polite">
        <div className="compression-summary-stat"><span>原始大小</span><strong>{formatCompressionBytes(estimate.inputBytes)}</strong></div>
        <div className="compression-summary-stat"><span>预计输出</span><strong>{formatCompressionBytes(estimate.estimatedBytes)}</strong></div>
        <div className="compression-summary-stat"><span>预计节省</span><strong className="compression-saving">{estimate.savingsPercent.toFixed(0)}%</strong></div>
        <span className="compression-estimate-note">{estimateNote}{typeof estimate.candidateCount === "number" ? ` · 尝试候选 ${estimate.candidateCount}` : ""}{typeof estimate.candidateSearchMs === "number" ? ` · 候选搜索 ${estimate.candidateSearchMs} ms` : ""}{preflightSpaceBytes !== null ? ` · 临时空间预算 ${formatCompressionBytes(preflightSpaceBytes)}` : ""}</span>
      </section>

      <section className="compression-card compression-result-card" aria-label="压缩结果统计">
        <div className="compression-summary-stat"><span>成功</span><strong>{resultStats.succeeded}</strong></div>
        <div className="compression-summary-stat"><span>跳过</span><strong>{resultStats.skipped}</strong></div>
        <div className="compression-summary-stat"><span>失败</span><strong className={resultStats.failed > 0 ? "compression-failure" : undefined}>{resultStats.failed}</strong></div>
        <div className="compression-summary-stat"><span>实际节省</span><strong className="compression-saving">{formatCompressionBytes(actualSavedBytes)} · {actualSavingsPercent.toFixed(0)}%</strong></div>
        {maxOutputBytes ? <div className="compression-summary-stat"><span>目标体积</span><strong className={resultStats.targetMet === false ? "compression-failure" : "compression-saving"}>{resultStats.targetMet === null ? "待处理" : resultStats.targetMet ? "已达成" : "未达成"}</strong></div> : null}
        {resultStats.selectedQualities.length > 0 ? <div className="compression-summary-stat"><span>实际质量</span><strong>{resultStats.selectedQualities.join(" / ")}</strong></div> : null}
        <span className="compression-estimate-note">输出 {formatCompressionBytes(resultStats.outputBytes)} / 已处理输入 {formatCompressionBytes(resultStats.processedInputBytes)}{deleteSource ? " · 成功项源文件已按设置删除" : ""}</span>
        {lastSuccessfulOutputPath ? <div className="compression-output-actions" aria-label="最近成功输出"><div className="compression-output-path"><span>最近成功输出</span><code>{lastSuccessfulOutputPath}</code></div><div className="compression-output-buttons"><button type="button" className="compression-secondary-button" onClick={() => { void copyOutputPath(lastSuccessfulOutputPath); }}>复制输出路径</button><button type="button" className="compression-secondary-button" onClick={() => { void openOutputFolder(lastSuccessfulOutputPath); }}>打开输出文件夹</button></div></div> : null}
        {itemResults.length > 0 ? <div className="compression-item-results" aria-label="逐项压缩结果"><div className="compression-item-results-heading"><strong>逐项结果（{itemResults.length}）</strong></div><ul>{itemResults.map((result, index) => { const sourceItem = items.find((item) => item.id === result.itemId) ?? items.find((item) => item.file.name === result.fileName); const metrics = getCompressionItemResultMetrics(result, sourceItem?.size ?? 0); const sizeSummary = [`原图 ${formatCompressionBytes(metrics.inputBytes)}`, metrics.outputBytes === undefined ? null : `${result.status === "skipped" ? "候选" : "输出"} ${formatCompressionBytes(metrics.outputBytes)}`, metrics.savedBytes === undefined || metrics.savingsPercent === undefined ? null : `${metrics.savedBytes >= 0 ? "节省" : "增加"} ${formatCompressionBytes(Math.abs(metrics.savedBytes))}（${Math.abs(metrics.savingsPercent).toFixed(1)}%）`, result.candidateCount === undefined ? null : `尝试候选 ${result.candidateCount}`, result.candidateSearchMs === undefined ? null : `候选搜索 ${result.candidateSearchMs} ms`, result.sourceDeleted ? "源文件已删除" : null].filter((entry): entry is string => Boolean(entry)).join(" · "); return <li className={`compression-item-result compression-item-result-${result.status}`} key={`${result.itemId ?? result.fileName}:${index}`}><div className="compression-item-result-copy"><strong>{result.fileName}</strong><span>{formatCompressionItemResultStatus(result.status)} · {sizeSummary}{result.outputPath || result.reason ? ` · ${result.outputPath || result.reason}` : ""}</span></div>{result.status === "completed" && result.outputPath ? <div className="compression-item-result-actions"><button type="button" className="compression-secondary-button" onClick={() => { void copyOutputPath(result.outputPath as string); }}>复制路径</button><button type="button" className="compression-secondary-button" onClick={() => { void openOutputFolder(result.outputPath as string); }}>打开文件夹</button></div> : null}</li>; })}</ul></div> : null}
        {failureDetails.length > 0 ? <div className="compression-failure-details" role="alert" aria-label="失败详情"><div className="compression-failure-heading"><strong>失败详情（{failureDetails.length}）</strong><button type="button" className="compression-secondary-button" onClick={() => { void copyFailureDetails(); }}>复制失败详情</button></div><ul>{failureDetails.map((detail) => <li key={`${detail.itemId ?? detail.fileName}:${detail.message}`}><strong>{detail.fileName}</strong><span>{detail.message}</span></li>)}</ul></div> : null}
        {skipReasons.length > 0 ? <div className="compression-skip-details"><strong>跳过原因</strong>{skipReasons.map((reason) => <span key={reason}>{reason}</span>)}</div> : null}
      </section>

      <footer className="compression-footer">
        <div className={`compression-status compression-status-${status}`} role={status === "error" ? "alert" : "status"}>
          {status === "busy" ? <LoaderCircle size={15} className="compression-spin" aria-hidden="true" /> : status === "success" ? <CheckCircle2 size={15} aria-hidden="true" /> : status === "error" ? <AlertCircle size={15} aria-hidden="true" /> : null}
          <span>{message || (status === "busy" ? `正在处理 ${progress.current}/${progress.total}${stage ? ` · ${stage}` : ""}` : status === "success" ? "任务已完成" : "准备就绪")}</span>
          {busy ? <span className="compression-current-file" aria-live="polite">当前文件：{currentFileName || "准备中"}{stage ? ` · 阶段：${stage}` : ""}{progressBytesSummary ? ` · ${progressBytesSummary}` : ""}</span> : null}
          {failures.length > 0 && status === "error" ? <button type="button" className="compression-retry-button" onClick={() => { void runCompression(); }} disabled={busy}><RefreshCw size={13} aria-hidden="true" /> 重试失败项</button> : null}
          {busy ? <button type="button" className="compression-retry-button" onClick={() => { void cancelActiveCompression(); }}><AlertCircle size={13} aria-hidden="true" /> 取消当前任务</button> : null}
        </div>
        <div className="compression-progress" aria-label="压缩进度"><span style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }} /></div>
        <button type="button" className="compression-primary-button" onClick={() => { void runCompression(); }} disabled={busy || items.length === 0 || Boolean(outputLocationError) || Boolean(outputFileNameError) || Boolean(targetSizeError)}>{busy ? <LoaderCircle size={16} className="compression-spin" aria-hidden="true" /> : <FileDown size={16} aria-hidden="true" />} {busy ? "正在压缩" : "开始压缩"}</button>
      </footer>
    </section>
  );
}
