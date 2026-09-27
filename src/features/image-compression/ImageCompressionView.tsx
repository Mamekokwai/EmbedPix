import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { AlertCircle, CheckCircle2, FileDown, FolderOpen, Images, LoaderCircle, RefreshCw, Trash2, Upload } from "lucide-react";
import "../../styles/features/image-compression.css";
import { cancelCompression, compressImage, createCompressionRequest, getCompressionProgress, pickCompressionDirectory, pickCompressionFiles, preflightCompression, previewCompression } from "../../platform/compression/compressionGateway";
import { isTauriEnvironment } from "../../platform/image/imageExportGateway";
import type { NativeImageFile } from "../../platform/image/imageExportGateway";
import {
  COMPRESSION_FORMATS,
  estimateFallback,
  filterCompressionFiles,
  formatCompressionBytes,
  getCompressionOutputLocationError,
} from "./imageCompressionLogic";
import type { CompressionEstimate, CompressionFormat, CompressionItem, CompressionOptions, CompressionOutputLocation, MetadataPolicy } from "./types";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function previewMimeType(format: string): string {
  return format === "jpeg" || format === "jpg" ? "image/jpeg" : format === "png" ? "image/png" : "image/webp";
}

export default function ImageCompressionView({ active = true }: ImageCompressionViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewRequestIdRef = useRef(0);
  const [items, setItems] = useState<CompressionItem[]>([]);
  const [format, setFormat] = useState<CompressionFormat>("webp");
  const [quality, setQuality] = useState(82);
  const [lossless, setLossless] = useState(false);
  const [metadataPolicy, setMetadataPolicy] = useState<MetadataPolicy>("strip");
  const [outputLocation, setOutputLocation] = useState<CompressionOutputLocation>("source");
  const [outputSubdirectory, setOutputSubdirectory] = useState("");
  const [outputDirectory, setOutputDirectory] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [status, setStatus] = useState<CompressionStatus>("idle");
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [stage, setStage] = useState("");
  const [estimate, setEstimate] = useState<CompressionEstimate>({ inputBytes: 0, estimatedBytes: 0, savingsPercent: 0 });
  const [estimateNote, setEstimateNote] = useState("等待导入图片");
  const [message, setMessage] = useState("");
  const [failures, setFailures] = useState<string[]>([]);
  const [skipReasons, setSkipReasons] = useState<string[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [preview, setPreview] = useState<CompressionPreview | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [originalPreviewUrl, setOriginalPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [resultStats, setResultStats] = useState<CompressionResultStats>({ total: 0, succeeded: 0, skipped: 0, failed: 0, inputBytes: 0, processedInputBytes: 0, outputBytes: 0, savedBytes: 0 });
  const activeJobIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);

  const busy = status === "busy";
  const options = useMemo<CompressionOptions>(() => ({
    format,
    quality,
    lossless,
    metadataPolicy,
    outputLocation,
    outputSubdirectory: outputLocation === "subfolder" ? outputSubdirectory.trim() || undefined : undefined,
    outputDirectory: outputLocation === "directory" ? outputDirectory.trim() || undefined : undefined,
    overwrite,
  }), [format, quality, lossless, metadataPolicy, outputLocation, outputSubdirectory, outputDirectory, overwrite]);

  const outputLocationError = useMemo(() => getCompressionOutputLocationError(outputLocation, outputSubdirectory, outputDirectory, !isTauriEnvironment() || (items.length > 0 && items.every((item) => Boolean(item.sourcePath)))), [items, outputDirectory, outputLocation, outputSubdirectory]);
  const actualSavedBytes = resultStats.savedBytes;
  const actualSavingsPercent = resultStats.processedInputBytes > 0 ? (actualSavedBytes / resultStats.processedInputBytes) * 100 : 0;
  const selectedItem = items.find((item) => item.id === selectedItemId) ?? null;

  useEffect(() => {
    if (!active) return;
    const fallback = estimateFallback(items, format === "jpg" ? options : { ...options, lossless: true });
    setEstimate(fallback);
    setEstimateNote(items.length === 0 ? "等待导入图片" : "本地预估，执行前由原生预检复核");
  }, [active, format, items, options]);

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

  const addBrowserFiles = (files: File[]) => {
    const next = toBrowserItems(files);
    if (next.length === 0) {
      setMessage("没有找到支持的图片格式（PNG、JPEG、WebP、BMP、GIF）。");
      setStatus("error");
      return;
    }
    setItems((current) => {
      const existing = new Set(current.map((item) => item.id));
      return [...current, ...next.filter((item) => !existing.has(item.id))];
    });
    setMessage("");
    setFailures([]);
    setSkipReasons([]);
    setResultStats({ total: 0, succeeded: 0, skipped: 0, failed: 0, inputBytes: 0, processedInputBytes: 0, outputBytes: 0, savedBytes: 0 });
    setStatus("ready");
  };

  const importNativeFiles = async (nativeFiles: NativeImageFile[]) => {
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
      setItems((current) => [...current, ...imported]);
      setSkipReasons([]);
      setResultStats({ total: 0, succeeded: 0, skipped: 0, failed: 0, inputBytes: 0, processedInputBytes: 0, outputBytes: 0, savedBytes: 0 });
      setStatus("ready");
    }
    if (skipped.length > 0) {
      setMessage(`有 ${skipped.length} 个文件读取失败，已跳过。`);
      setFailures(skipped);
      setStatus(imported.length > 0 ? "ready" : "error");
    }
  };

  const chooseFiles = async () => {
    if (busy) return;
    if (!isTauriEnvironment()) {
      fileInputRef.current?.click();
      return;
    }
    try {
      await importNativeFiles(await pickCompressionFiles());
    } catch (error) {
      setMessage(errorMessage(error));
      setStatus("error");
    }
  };

  const chooseDirectory = async () => {
    if (busy) return;
    if (!isTauriEnvironment()) {
      setMessage("导入文件夹仅在桌面应用中可用；当前预览环境可使用“选择图片”后多选文件。");
      setStatus("error");
      return;
    }
    try {
      await importNativeFiles(await pickCompressionDirectory());
    } catch (error) {
      setMessage(errorMessage(error));
      setStatus("error");
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    addBrowserFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!busy) addBrowserFiles(Array.from(event.dataTransfer.files));
  };

  const monitorCompressionProgress = async (jobId: string) => {
    while (activeJobIdRef.current === jobId) {
      try {
        const next = await getCompressionProgress(jobId);
        setStage(next.stage);
        if (next.error) setMessage(next.error);
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
    setSkipReasons([]);
    cancelRequestedRef.current = false;
    setResultStats({ total: queue.length, succeeded: 0, skipped: 0, failed: 0, inputBytes: queue.reduce((sum, item) => sum + item.size, 0), processedInputBytes: 0, outputBytes: 0, savedBytes: 0 });
    setProgress({ current: 0, total: queue.length });
    const failedNames: string[] = [];
    let lastError = "";
    for (const [index, item] of queue.entries()) {
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
          setResultStats((current) => ({ ...current, skipped: current.skipped + 1 }));
          setSkipReasons((current) => [...current, `${item.file.name}：${result.skippedReason || "原生压缩策略跳过，未发布输出"}`]);
          setMessage(`已跳过 ${item.file.name}：${result.skippedReason || "未发布输出"}`);
        } else {
          setResultStats((current) => ({ ...current, succeeded: current.succeeded + 1, processedInputBytes: current.processedInputBytes + result.inputBytes, outputBytes: current.outputBytes + result.outputBytes, savedBytes: current.savedBytes + result.savedBytes }));
        }
      } catch (error) {
        activeJobIdRef.current = null;
        const detail = errorMessage(error);
        failedNames.push(item.file.name);
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
    if (busy) return;
    setItems((current) => current.filter((item) => item.id !== id));
    setStatus(items.length > 1 ? "ready" : "idle");
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
            <span className="compression-count">{items.length} 个文件</span>
          </div>
          <div
            className={`compression-drop-zone${dragging ? " compression-drop-zone-dragging" : ""}${busy ? " compression-drop-zone-disabled" : ""}`}
            onDragEnter={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            role="button"
            tabIndex={busy ? -1 : 0}
            aria-disabled={busy}
            onKeyDown={(event) => { if (!busy && (event.key === "Enter" || event.key === " ")) void chooseFiles(); }}
            onClick={() => { void chooseFiles(); }}
          >
            <span className="compression-drop-icon"><Upload size={22} aria-hidden="true" /></span>
            <strong>拖放图片到这里</strong>
            <span>或点击选择多个文件</span>
            <small>支持 PNG / JPEG / WebP / BMP / GIF；输出格式为 PNG / JPEG / WebP</small>
          </div>
          <input ref={fileInputRef} className="visually-hidden" type="file" accept="image/*,.bmp,.gif,.webp" multiple onChange={handleFileChange} disabled={busy} />
          <div className="compression-source-actions">
            <button type="button" className="compression-secondary-button" onClick={() => { void chooseFiles(); }} disabled={busy}><Images size={15} aria-hidden="true" /> 选择图片</button>
            <button type="button" className="compression-secondary-button" onClick={() => { void chooseDirectory(); }} disabled={busy}><FolderOpen size={15} aria-hidden="true" /> 导入文件夹</button>
          </div>
          <div className="compression-list" aria-label="待压缩图片列表">
            {items.length === 0 ? <p className="compression-empty">导入后将在这里显示文件、原始大小与来源。</p> : items.map((item) => (
              <div className={`compression-item${selectedItemId === item.id ? " compression-item-selected" : ""}`} key={item.id} role="button" tabIndex={busy ? -1 : 0} aria-pressed={selectedItemId === item.id} onClick={() => { if (!busy) setSelectedItemId(item.id); }} onKeyDown={(event) => { if (!busy && (event.key === "Enter" || event.key === " ")) setSelectedItemId(item.id); }}>
                <div className="compression-item-icon"><Images size={15} aria-hidden="true" /></div>
                <div className="compression-item-copy"><strong>{item.file.name}</strong><span>{formatCompressionBytes(item.size)}{item.sourcePath ? " · 桌面文件" : " · 浏览器文件"}</span></div>
                <button type="button" className="compression-icon-button" aria-label={`移除 ${item.file.name}`} onClick={() => removeItem(item.id)} disabled={busy}><Trash2 size={15} aria-hidden="true" /></button>
              </div>
            ))}
          </div>
        </div>

        <aside className="compression-card compression-settings-card">
          <div className="compression-card-heading"><div><span className="compression-card-kicker">02 / OPTIONS</span><h2>压缩参数</h2></div></div>
          <label className="compression-field"><span>输出格式</span><select value={format} onChange={(event) => { const nextFormat = event.target.value as CompressionFormat; setFormat(nextFormat); if (nextFormat === "jpg") setLossless(false); }} disabled={busy}>{COMPRESSION_FORMATS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="compression-field"><span className="compression-label-row"><span>质量（仅 JPEG）</span><strong>{format === "jpg" ? quality : "—"}</strong></span><input type="range" min="1" max="100" value={quality} onChange={(event) => setQuality(Number(event.target.value))} disabled={busy || lossless || format !== "jpg"} /></label>
          <label className="compression-check"><input type="checkbox" checked={lossless} onChange={(event) => setLossless(event.target.checked)} disabled={busy || format === "jpg"} /><span><strong>PNG/WebP 无损模式</strong><small>{format === "jpg" ? "JPEG 不支持无损模式" : format === "webp" ? "当前核心 WebP 编码固定为无损" : "PNG 编码天然无损"}</small></span></label>
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
        {preview ? <div className="compression-preview-stats"><span>尺寸 {preview.width} × {preview.height}</span><span>输出 {formatCompressionBytes(preview.outputBytes)}</span><span className={preview.savedBytes >= 0 ? "compression-saving" : "compression-failure"}>{preview.savedBytes >= 0 ? `节省 ${formatCompressionBytes(preview.savedBytes)} · ${preview.savingsPercent.toFixed(0)}%` : `增加 ${formatCompressionBytes(Math.abs(preview.savedBytes))}`}</span></div> : null}
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
        <span className="compression-estimate-note">输出 {formatCompressionBytes(resultStats.outputBytes)} / 已处理输入 {formatCompressionBytes(resultStats.processedInputBytes)}</span>
        {skipReasons.length > 0 ? <div className="compression-skip-details"><strong>跳过原因</strong>{skipReasons.map((reason) => <span key={reason}>{reason}</span>)}</div> : null}
      </section>

      <footer className="compression-footer">
        <div className={`compression-status compression-status-${status}`} role={status === "error" ? "alert" : "status"}>
          {status === "busy" ? <LoaderCircle size={15} className="compression-spin" aria-hidden="true" /> : status === "success" ? <CheckCircle2 size={15} aria-hidden="true" /> : status === "error" ? <AlertCircle size={15} aria-hidden="true" /> : null}
          <span>{message || (status === "busy" ? `正在处理 ${progress.current}/${progress.total}${stage ? ` · ${stage}` : ""}` : status === "success" ? "任务已完成" : "准备就绪")}</span>
          {failures.length > 0 && status === "error" ? <button type="button" className="compression-retry-button" onClick={() => { void runCompression(); }} disabled={busy}><RefreshCw size={13} aria-hidden="true" /> 重试失败项</button> : null}
          {busy ? <button type="button" className="compression-retry-button" onClick={() => { void cancelActiveCompression(); }}><AlertCircle size={13} aria-hidden="true" /> 取消当前任务</button> : null}
        </div>
        <div className="compression-progress" aria-label="压缩进度"><span style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }} /></div>
        <button type="button" className="compression-primary-button" onClick={() => { void runCompression(); }} disabled={busy || items.length === 0 || Boolean(outputLocationError)}>{busy ? <LoaderCircle size={16} className="compression-spin" aria-hidden="true" /> : <FileDown size={16} aria-hidden="true" />} {busy ? "正在压缩" : "开始压缩"}</button>
      </footer>
    </section>
  );
}
