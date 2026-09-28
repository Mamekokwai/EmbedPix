import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { AlertCircle, CheckCircle2, FileDown, FolderOpen, Images, LoaderCircle, RefreshCw, Trash2, Upload } from "lucide-react";
import "../../styles/features/image-compression.css";
import { cancelCompression, compressImage, createCompressionRequest, formatCompressionProgressError, getCompressionProgress, pickCompressionDirectoryResult, pickCompressionFiles, preflightCompression, previewCompression } from "../../platform/compression/compressionGateway";
import { isTauriEnvironment, revealImageOutput } from "../../platform/image/imageExportGateway";
import type { NativeImageFile } from "../../platform/image/imageExportGateway";
import {
  COMPRESSION_FORMATS,
  COMPRESSION_PRESETS,
  estimateFallback,
  filterCompressionFiles,
  formatCompressionBytes,
  formatCompressionFailureDetails,
  getSuccessfulCompressionOutputPath,
  getCompressionPreset,
  getCompressionOutputLocationError,
  supportsCompressionTargetSize,
} from "./imageCompressionLogic";
import {
  COMPRESSION_MAX_TARGET_SIZE_KIB,
  loadCompressionPreferences,
  saveCompressionPreferences,
} from "./compressionPreferences";
import type { CompressionEstimate, CompressionFormat, CompressionItem, CompressionOptions, CompressionOutputLocation, CompressionPreset, MetadataPolicy } from "./types";
import type { CompressionPreview } from "../../platform/compression/compressionGateway";

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
  fileName: string;
  message: string;
}

function fileTypeForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension ? `image/${extension}` : "application/octet-stream";
}

function nativeFileToItem(nativeFile: NativeImageFile): CompressionItem {
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
  const replaceItemIdRef = useRef<string | null>(null);
  const previewRequestIdRef = useRef(0);
  const [initialPreferences] = useState(() => loadCompressionPreferences());
  const [items, setItems] = useState<CompressionItem[]>([]);
  const [format, setFormat] = useState<CompressionFormat>(initialPreferences.format);
  const [quality, setQuality] = useState(initialPreferences.quality);
  const [pngOptimizationLevel, setPngOptimizationLevel] = useState(initialPreferences.pngOptimizationLevel);
  const [targetSizeKiB, setTargetSizeKiB] = useState(initialPreferences.targetSizeKiB);
  const [targetSizeEnabled, setTargetSizeEnabled] = useState(initialPreferences.targetSizeEnabled);
  const [lossless, setLossless] = useState(initialPreferences.lossless);
  const [preset, setPreset] = useState<CompressionPreset>(initialPreferences.preset);
  const [metadataPolicy, setMetadataPolicy] = useState<MetadataPolicy>(initialPreferences.metadataPolicy);
  const [outputLocation, setOutputLocation] = useState<CompressionOutputLocation>(initialPreferences.outputLocation);
  const [outputSubdirectory, setOutputSubdirectory] = useState(initialPreferences.outputSubdirectory);
  const [outputDirectory, setOutputDirectory] = useState("");
  const [overwrite, setOverwrite] = useState(initialPreferences.overwrite);
  const [status, setStatus] = useState<CompressionStatus>("idle");
  const [importBusy, setImportBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [stage, setStage] = useState("");
  const [estimate, setEstimate] = useState<CompressionEstimate>({ inputBytes: 0, estimatedBytes: 0, savingsPercent: 0 });
  const [estimateNote, setEstimateNote] = useState("等待导入图片");
  const [message, setMessage] = useState("");
  const [importErrors, setImportErrors] = useState<CompressionImportError[]>([]);
  const [failures, setFailures] = useState<string[]>([]);
  const [failureDetails, setFailureDetails] = useState<CompressionFailureDetail[]>([]);
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

  const busy = status === "busy";
  const sourceBusy = busy || importBusy;
  const qualityEnabled = supportsCompressionTargetSize(format, lossless);
  const targetSizeActive = targetSizeEnabled && qualityEnabled;
  const targetSizeError = useMemo(() => {
    if (!targetSizeActive || !targetSizeKiB.trim()) return null;
    const value = Number(targetSizeKiB);
    if (!Number.isFinite(value) || value < 1 || value > COMPRESSION_MAX_TARGET_SIZE_KIB) return `目标体积需为 1–${COMPRESSION_MAX_TARGET_SIZE_KIB.toLocaleString()} KiB。`;
    return null;
  }, [targetSizeActive, targetSizeKiB]);
  const maxOutputBytes = targetSizeActive && !targetSizeError && targetSizeKiB.trim() ? Math.round(Number(targetSizeKiB) * 1024) : undefined;
  const options = useMemo<CompressionOptions>(() => ({
    format,
    quality,
    lossless,
    pngOptimizationLevel,
    metadataPolicy,
    outputLocation,
    outputSubdirectory: outputLocation === "subfolder" ? outputSubdirectory.trim() || undefined : undefined,
    outputDirectory: outputLocation === "directory" ? outputDirectory.trim() || undefined : undefined,
    overwrite,
    maxOutputBytes,
    maxCandidates: qualityEnabled && maxOutputBytes ? 8 : undefined,
  }), [format, quality, lossless, qualityEnabled, pngOptimizationLevel, metadataPolicy, outputLocation, outputSubdirectory, outputDirectory, overwrite, maxOutputBytes]);

  const outputLocationError = useMemo(() => getCompressionOutputLocationError(outputLocation, outputSubdirectory, outputDirectory, !isTauriEnvironment() || (items.length > 0 && items.every((item) => Boolean(item.sourcePath)))), [items, outputDirectory, outputLocation, outputSubdirectory]);
  const actualSavedBytes = resultStats.savedBytes;
  const actualSavingsPercent = resultStats.processedInputBytes > 0 ? (actualSavedBytes / resultStats.processedInputBytes) * 100 : 0;
  const selectedItem = items.find((item) => item.id === selectedItemId) ?? null;
  const previewSavedBytes = selectedItem && preview ? selectedItem.size - preview.outputBytes : 0;
  const previewSavingsPercent = selectedItem && preview && selectedItem.size > 0 ? (previewSavedBytes / selectedItem.size) * 100 : 0;

  const queueCompressionDimensions = (item: CompressionItem) => {
    void Promise.resolve().then(() => readCompressionDimensions(item.file)).then((dimensions) => {
      setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, dimensions } : candidate));
    }).catch((error) => {
      setImportErrors((current) => [...current, { id: `dimensions-${item.id}`, fileName: item.file.name, message: errorMessage(error) }]);
    });
  };

  useEffect(() => {
    if (!active) return;
    const fallback = estimateFallback(items, options);
    setEstimate(fallback);
    setEstimateNote(items.length === 0 ? "等待导入图片" : "本地预估，执行前由原生预检复核");
  }, [active, format, items, options]);

  useEffect(() => {
    saveCompressionPreferences({
      format,
      quality,
      pngOptimizationLevel,
      targetSizeEnabled: targetSizeActive,
      targetSizeKiB,
      lossless,
      preset,
      metadataPolicy,
      outputLocation,
      outputSubdirectory,
      overwrite,
    });
  }, [format, lossless, metadataPolicy, outputLocation, outputSubdirectory, overwrite, pngOptimizationLevel, preset, quality, targetSizeActive, targetSizeKiB]);

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
    const supportedFiles = filterCompressionFiles(files);
    const unsupportedFiles = files.filter((file) => !supportedFiles.includes(file));
    const next = toBrowserItems(files);
    if (next.length === 0) {
      setImportErrors(unsupportedFiles.map((file, index) => ({ id: `browser-${file.name}-${file.lastModified}-${file.size}-${index}`, fileName: file.name, message: "格式不受支持，仅支持 PNG、JPEG、WebP、BMP、GIF。" })));
      setMessage("没有找到支持的图片格式（PNG、JPEG、WebP、BMP、GIF）。");
      setStatus("error");
      return;
    }
    const replacement = replaceItemId ? next[0] : null;
    const replacingExisting = Boolean(replacement && items.some((item) => item.id === replaceItemId));
    const appendedItems = replacingExisting ? [] : next.filter((item) => !items.some((current) => current.id === item.id));
    const hydratedItems = replacingExisting && replacement ? [{ ...replacement, id: replaceItemId as string }] : appendedItems;
    setItems((current) => {
      if (replacingExisting && replacement) {
        return current.map((item) => item.id === replaceItemId ? { ...replacement, id: replaceItemId } : item);
      }
      const existing = new Set(current.map((item) => item.id));
      return [...current, ...appendedItems.filter((item) => !existing.has(item.id))];
    });
    hydratedItems.forEach(queueCompressionDimensions);
    if (replacingExisting) setSelectedItemId(replaceItemId);
    setMessage(replacingExisting ? "已替换当前图片。" : "");
    setImportErrors(unsupportedFiles.map((file, index) => ({ id: `browser-${file.name}-${file.lastModified}-${file.size}-${index}`, fileName: file.name, message: "格式不受支持，仅支持 PNG、JPEG、WebP、BMP、GIF。" })));
    setFailures([]);
    setFailureDetails([]);
    setSkipReasons([]);
    setResultStats({ total: 0, succeeded: 0, skipped: 0, failed: 0, inputBytes: 0, processedInputBytes: 0, outputBytes: 0, savedBytes: 0, targetMet: null, selectedQualities: [] });
    setStatus("ready");
  };

  const importNativeFiles = async (nativeFiles: NativeImageFile[], replaceItemId: string | null = null, directorySkipped: string[] = []) => {
    setImportErrors([]);
    const imported: CompressionItem[] = [];
    const skipped: string[] = [];
    for (const nativeFile of nativeFiles) {
      try {
        imported.push(nativeFileToItem(nativeFile));
      } catch {
        skipped.push(nativeFile.fileName);
      }
    }
    if (imported.length > 0) {
      const replacement = replaceItemId ? imported[0] : null;
      const replacingExisting = Boolean(replacement && items.some((item) => item.id === replaceItemId));
      setItems((current) => {
        if (replacingExisting && replacement) {
          return current.map((item) => item.id === replaceItemId ? { ...replacement, id: replaceItemId } : item);
        }
        return [...current, ...imported];
      });
      const itemForDimensions = replacingExisting && replacement ? [{ ...replacement, id: replaceItemId as string }] : imported;
      itemForDimensions.forEach(queueCompressionDimensions);
      if (replacingExisting) {
        setSelectedItemId(replaceItemId);
        setMessage(nativeFiles.length > 1 ? "已替换当前图片（仅使用所选文件中的第一张）。" : "已替换当前图片。");
      }
      setSkipReasons([]);
      setResultStats({ total: 0, succeeded: 0, skipped: 0, failed: 0, inputBytes: 0, processedInputBytes: 0, outputBytes: 0, savedBytes: 0, targetMet: null, selectedQualities: [] });
      setStatus("ready");
    }
    const importFailureNames = [...directorySkipped, ...skipped];
    if (importFailureNames.length > 0) {
      setMessage(`有 ${importFailureNames.length} 个文件导入失败，已跳过。`);
      setImportErrors(importFailureNames.map((fileName, index) => ({ id: `native-${fileName}-${index}`, fileName, message: "读取失败或被文件夹扫描跳过。" })));
      setFailures([]);
      setFailureDetails([]);
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
    if (items.some((item) => !item.sourcePath)) {
      setMessage("当前列表包含浏览器导入文件，请在桌面应用中重新选择图片后执行压缩。");
      setStatus("error");
      return;
    }
    setStatus("busy");
    setMessage("");
    setStage("preflight");
    const queue = failures.length > 0 ? items.filter((item) => failures.includes(item.file.name)) : items;
    setFailures([]);
    setFailureDetails([]);
    setSkipReasons([]);
    cancelRequestedRef.current = false;
    setResultStats({ total: queue.length, succeeded: 0, skipped: 0, failed: 0, inputBytes: queue.reduce((sum, item) => sum + item.size, 0), processedInputBytes: 0, outputBytes: 0, savedBytes: 0, targetMet: null, selectedQualities: [] });
    setProgress({ current: 0, total: queue.length });
    const failedNames: string[] = [];
    let lastError = "";
    for (const [index, item] of queue.entries()) {
      setCurrentFileName(item.file.name);
      setStage("preflight");
      const jobId = `compression-${Date.now()}-${index}`;
      try {
        const nativeFile: NativeImageFile = { path: item.sourcePath as string, fileName: item.file.name, data: Array.from(new Uint8Array(await item.file.arrayBuffer())) };
        const request = createCompressionRequest(nativeFile, options, jobId);
        const preflight = await preflightCompression(request);
        if (preflight.overwritesExisting && !options.overwrite) {
          setResultStats((current) => ({ ...current, skipped: current.skipped + 1 }));
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
          setResultStats((current) => ({ ...current, skipped: current.skipped + 1, targetMet: result.targetMet ?? (options.maxOutputBytes === undefined ? current.targetMet : false) }));
          setSkipReasons((current) => [...current, `${item.file.name}：${result.skippedReason || "原生压缩策略跳过，未发布输出"}`]);
          setMessage(`已跳过 ${item.file.name}：${result.skippedReason || "未发布输出"}`);
        } else {
          const successfulOutputPath = getSuccessfulCompressionOutputPath(result.status, result.outputPath);
          if (successfulOutputPath) setLastSuccessfulOutputPath(successfulOutputPath);
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
        setFailureDetails((current) => [...current, { fileName: item.file.name, message: detail }]);
        lastError = detail;
        setResultStats((current) => ({ ...current, failed: current.failed + 1 }));
        if (cancelRequestedRef.current) {
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
    if (failedNames.length > 0) {
      setFailures(failedNames);
      setStage(cancelRequestedRef.current ? "cancelled" : "failed");
      setMessage(cancelRequestedRef.current ? "已取消当前任务，其余文件未处理。" : `部分任务完成，请查看统计。${lastError ? ` ${lastError}` : ""}`);
      setStatus("error");
    } else {
      setStatus("success");
      setStage("completed");
      setMessage("处理完成，请查看成功、跳过和节省统计。");
    }
  };

  const removeItem = (id: string) => {
    if (sourceBusy) return;
    const removedItem = items.find((item) => item.id === id);
    if (!removedItem) return;
    setItems((current) => current.filter((item) => item.id !== id));
    setFailures([]);
    setFailureDetails([]);
    setSkipReasons([]);
    setResultStats({ total: 0, succeeded: 0, skipped: 0, failed: 0, inputBytes: 0, processedInputBytes: 0, outputBytes: 0, savedBytes: 0, targetMet: null, selectedQualities: [] });
    setMessage("");
    setStatus(items.length > 1 ? "ready" : "idle");
  };

  const clearItems = () => {
    if (sourceBusy) return;
    setItems([]);
    setSelectedItemId(null);
    setFailures([]);
    setFailureDetails([]);
    setImportErrors([]);
    setSkipReasons([]);
    setResultStats({ total: 0, succeeded: 0, skipped: 0, failed: 0, inputBytes: 0, processedInputBytes: 0, outputBytes: 0, savedBytes: 0, targetMet: null, selectedQualities: [] });
    setMessage("");
    setStatus("idle");
  };

  const applyPreset = (nextPreset: CompressionPreset) => {
    setPreset(nextPreset);
    if (nextPreset === "custom") return;
    const values = getCompressionPreset(nextPreset);
    setQuality(values.quality);
    setPngOptimizationLevel(values.pngOptimizationLevel);
  };

  const copySuccessfulOutputPath = async () => {
    if (!lastSuccessfulOutputPath) return;
    try {
      if (!navigator.clipboard) throw new Error("当前环境不支持复制，请手动选择输出路径。");
      await navigator.clipboard.writeText(lastSuccessfulOutputPath);
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

  const openSuccessfulOutputFolder = async () => {
    if (!lastSuccessfulOutputPath) return;
    try {
      await revealImageOutput(lastSuccessfulOutputPath);
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
            <small>支持 PNG / JPEG / WebP / BMP / GIF；输出格式为 PNG / JPEG / WebP</small>
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
          <label className="compression-field"><span>输出格式</span><select value={format} onChange={(event) => { const nextFormat = event.target.value as CompressionFormat; setFormat(nextFormat); setLossless(nextFormat !== "jpg"); if (nextFormat !== "jpg") setTargetSizeEnabled(false); }} disabled={busy}>{COMPRESSION_FORMATS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="compression-field"><span>PNG 优化级别</span><select value={pngOptimizationLevel} onChange={(event) => { setPngOptimizationLevel(Number(event.target.value)); setPreset("custom"); }} disabled={busy || format !== "png"}>{[0, 1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>{level}</option>)}</select><small className="compression-field-hint">{format === "png" ? "0 最快，6 压缩更积极；默认 2" : "仅 PNG 有效，当前格式不可用"}</small></label>
          <label className="compression-field"><span className="compression-label-row"><span>质量（JPEG/WebP 有损）</span><strong>{qualityEnabled ? quality : "—"}</strong></span><input type="range" min="1" max="100" value={quality} onChange={(event) => { setQuality(Number(event.target.value)); setPreset("custom"); }} disabled={busy || !qualityEnabled} /></label>
          <label className="compression-check"><input type="checkbox" checked={format === "png" || (format === "webp" && lossless)} onChange={(event) => { if (format === "webp") { setLossless(event.target.checked); if (event.target.checked) setTargetSizeEnabled(false); setPreset("custom"); } }} disabled={busy || format !== "webp"} /><span><strong>{format === "webp" ? "WebP 无损编码" : format === "png" ? "PNG 无损编码" : "JPEG 有损编码"}</strong><small>{format === "jpg" ? "JPEG 使用质量滑块进行有损编码" : format === "webp" ? lossless ? "当前为无损 WebP；关闭后使用有损质量" : "当前为有损 WebP；质量滑块控制编码质量" : "PNG 始终无损，使用优化级别控制编码效率"}</small></span></label>
          <label className="compression-check"><input type="checkbox" checked={targetSizeActive} onChange={(event) => setTargetSizeEnabled(event.target.checked)} disabled={busy || !qualityEnabled} /><span><strong>启用目标体积控制</strong><small>{format === "jpg" ? "启用后输入最大输出体积；核心最多尝试 8 个 JPEG 质量候选" : format === "webp" && !lossless ? "启用后输入最大输出体积；核心最多尝试 8 个 WebP 质量候选" : "PNG 和无损 WebP 不支持目标体积控制"}</small></span></label>
          <label className="compression-field"><span className="compression-label-row"><span>最大输出体积（JPEG/WebP 有损）</span><strong>{targetSizeActive && targetSizeKiB ? `${targetSizeKiB} KiB` : "—"}</strong></span><input type="number" min="1" max={COMPRESSION_MAX_TARGET_SIZE_KIB} step="1" value={targetSizeKiB} onChange={(event) => setTargetSizeKiB(event.target.value)} placeholder="启用后输入 KiB" disabled={busy || !qualityEnabled || !targetSizeActive} aria-invalid={Boolean(targetSizeError)} /><small className="compression-field-hint">{format === "jpg" ? `JPEG 质量候选范围为 1–${COMPRESSION_MAX_TARGET_SIZE_KIB.toLocaleString()} KiB` : format === "webp" && !lossless ? `WebP 质量候选范围为 1–${COMPRESSION_MAX_TARGET_SIZE_KIB.toLocaleString()} KiB` : "PNG 和无损 WebP 不支持目标体积控制"}</small></label>
          {targetSizeError ? <p className="compression-field-error" role="alert">{targetSizeError}</p> : null}
          <label className="compression-field"><span>元数据策略</span><select value={metadataPolicy} onChange={(event) => setMetadataPolicy(event.target.value as MetadataPolicy)} disabled={busy}><option value="strip">移除元数据（推荐）</option><option value="preserve" disabled>保留元数据（核心待支持）</option></select></label>
          <label className="compression-field"><span>输出位置</span><select value={outputLocation} onChange={(event) => setOutputLocation(event.target.value as CompressionOutputLocation)} disabled={busy}><option value="source">源文件夹</option><option value="subfolder">源文件夹子目录</option><option value="directory">指定目录</option></select></label>
          {outputLocation === "subfolder" ? <label className="compression-field"><span>子目录名称</span><input value={outputSubdirectory} onChange={(event) => setOutputSubdirectory(event.target.value)} placeholder="例如 compressed" spellCheck={false} aria-invalid={Boolean(outputLocationError)} disabled={busy} /></label> : null}
          {outputLocation === "directory" ? <label className="compression-field"><span>输出目录</span><input value={outputDirectory} onChange={(event) => setOutputDirectory(event.target.value)} placeholder="例如 D:\\Export" spellCheck={false} aria-invalid={Boolean(outputLocationError)} disabled={busy} /></label> : null}
          {outputLocationError ? <p className="compression-field-error" role="alert">{outputLocationError}</p> : null}
          <label className="compression-check"><input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} disabled={busy} /><span><strong>允许覆盖同名文件</strong><small>关闭时同名目标会拒绝写入</small></span></label>
        </aside>
      </div>

      <section className="compression-card compression-preview-card" aria-live="polite" aria-label="压缩预览">
        <div className="compression-card-heading"><div><span className="compression-card-kicker">03 / PREVIEW</span><h2>真实压缩预览</h2></div><span className="compression-count">{selectedItem?.file.name ?? "未选择图片"}</span></div>
        {selectedItem ? <div className="compression-preview-grid">
          <figure className="compression-preview-pane"><figcaption>原图<span>{formatCompressionBytes(selectedItem.size)}</span></figcaption><div className="compression-preview-stage">{originalPreviewUrl ? <img src={originalPreviewUrl} alt={`原图 ${selectedItem.file.name}`} /> : null}</div></figure>
          <figure className="compression-preview-pane"><figcaption>压缩后{preview ? <span>{formatCompressionBytes(preview.outputBytes)}</span> : null}</figcaption><div className="compression-preview-stage">{previewUrl ? <img src={previewUrl} alt={`压缩预览 ${selectedItem.file.name}`} /> : previewBusy ? <LoaderCircle size={20} className="compression-spin" aria-label="正在生成预览" /> : <span className="compression-preview-placeholder">{previewError || "等待预览"}</span>}</div></figure>
        </div> : <p className="compression-empty">选择一张图片后查看原图与真实压缩结果。</p>}
        {preview ? <div className="compression-preview-stats"><span>尺寸 {preview.width} × {preview.height}</span><span>输出 {formatCompressionBytes(preview.outputBytes)}</span><span className={previewSavedBytes >= 0 ? "compression-saving" : "compression-failure"}>{previewSavedBytes >= 0 ? `节省 ${formatCompressionBytes(previewSavedBytes)} · ${previewSavingsPercent.toFixed(0)}%` : `增加 ${formatCompressionBytes(Math.abs(previewSavedBytes))}`}</span>{maxOutputBytes ? <span className={preview.targetMet ? "compression-saving" : "compression-failure"}>目标 {preview.targetMet ? "已达成" : "未达成"}</span> : null}{typeof preview.selectedQuality === "number" ? <span>选中质量 {preview.selectedQuality}</span> : null}{preview.status === "skipped" ? <span className="compression-failure">预览跳过：{preview.skippedReason || "未发布输出"}</span> : null}</div> : null}
      </section>

      <section className="compression-card compression-summary-card" aria-live="polite">
        <div className="compression-summary-stat"><span>原始大小</span><strong>{formatCompressionBytes(estimate.inputBytes)}</strong></div>
        <div className="compression-summary-stat"><span>预计输出</span><strong>{formatCompressionBytes(estimate.estimatedBytes)}</strong></div>
        <div className="compression-summary-stat"><span>预计节省</span><strong className="compression-saving">{estimate.savingsPercent.toFixed(0)}%</strong></div>
        <span className="compression-estimate-note">{estimateNote}</span>
      </section>

      <section className="compression-card compression-result-card" aria-label="压缩结果统计">
        <div className="compression-summary-stat"><span>成功</span><strong>{resultStats.succeeded}</strong></div>
        <div className="compression-summary-stat"><span>跳过</span><strong>{resultStats.skipped}</strong></div>
        <div className="compression-summary-stat"><span>失败</span><strong className={resultStats.failed > 0 ? "compression-failure" : undefined}>{resultStats.failed}</strong></div>
        <div className="compression-summary-stat"><span>实际节省</span><strong className="compression-saving">{formatCompressionBytes(actualSavedBytes)} · {actualSavingsPercent.toFixed(0)}%</strong></div>
        {maxOutputBytes ? <div className="compression-summary-stat"><span>目标体积</span><strong className={resultStats.targetMet === false ? "compression-failure" : "compression-saving"}>{resultStats.targetMet === null ? "待处理" : resultStats.targetMet ? "已达成" : "未达成"}</strong></div> : null}
        {resultStats.selectedQualities.length > 0 ? <div className="compression-summary-stat"><span>实际质量</span><strong>{resultStats.selectedQualities.join(" / ")}</strong></div> : null}
        <span className="compression-estimate-note">输出 {formatCompressionBytes(resultStats.outputBytes)} / 已处理输入 {formatCompressionBytes(resultStats.processedInputBytes)}</span>
        {lastSuccessfulOutputPath ? <div className="compression-output-actions" aria-label="最近成功输出"><div className="compression-output-path"><span>最近成功输出</span><code>{lastSuccessfulOutputPath}</code></div><div className="compression-output-buttons"><button type="button" className="compression-secondary-button" onClick={() => { void copySuccessfulOutputPath(); }}>复制输出路径</button><button type="button" className="compression-secondary-button" onClick={() => { void openSuccessfulOutputFolder(); }}>打开输出文件夹</button></div></div> : null}
        {failureDetails.length > 0 ? <div className="compression-failure-details" role="alert" aria-label="失败详情"><div className="compression-failure-heading"><strong>失败详情（{failureDetails.length}）</strong><button type="button" className="compression-secondary-button" onClick={() => { void copyFailureDetails(); }}>复制失败详情</button></div><ul>{failureDetails.map((detail) => <li key={`${detail.fileName}:${detail.message}`}><strong>{detail.fileName}</strong><span>{detail.message}</span></li>)}</ul></div> : null}
        {skipReasons.length > 0 ? <div className="compression-skip-details"><strong>跳过原因</strong>{skipReasons.map((reason) => <span key={reason}>{reason}</span>)}</div> : null}
      </section>

      <footer className="compression-footer">
        <div className={`compression-status compression-status-${status}`} role={status === "error" ? "alert" : "status"}>
          {status === "busy" ? <LoaderCircle size={15} className="compression-spin" aria-hidden="true" /> : status === "success" ? <CheckCircle2 size={15} aria-hidden="true" /> : status === "error" ? <AlertCircle size={15} aria-hidden="true" /> : null}
          <span>{message || (status === "busy" ? `正在处理 ${progress.current}/${progress.total}${stage ? ` · ${stage}` : ""}` : status === "success" ? "任务已完成" : "准备就绪")}</span>
          {busy ? <span className="compression-current-file" aria-live="polite">当前文件：{currentFileName || "准备中"}{stage ? ` · 阶段：${stage}` : ""}</span> : null}
          {failures.length > 0 && status === "error" ? <button type="button" className="compression-retry-button" onClick={() => { void runCompression(); }} disabled={busy}><RefreshCw size={13} aria-hidden="true" /> 重试失败项</button> : null}
          {busy ? <button type="button" className="compression-retry-button" onClick={() => { void cancelActiveCompression(); }}><AlertCircle size={13} aria-hidden="true" /> 取消当前任务</button> : null}
        </div>
        <div className="compression-progress" aria-label="压缩进度"><span style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }} /></div>
        <button type="button" className="compression-primary-button" onClick={() => { void runCompression(); }} disabled={busy || items.length === 0 || Boolean(outputLocationError) || Boolean(targetSizeError)}>{busy ? <LoaderCircle size={16} className="compression-spin" aria-hidden="true" /> : <FileDown size={16} aria-hidden="true" />} {busy ? "正在压缩" : "开始压缩"}</button>
      </footer>
    </section>
  );
}
