import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Film,
  ImagePlus,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import ThemeSelect from "../../shared/components/ThemeSelect";
import { exportGif, pickGifOutput } from "../../platform/gif/gifGateway";
import { advanceGifPlayback, clampFrameDuration, getGifFrameOrder, GifImportQueue, MAX_TOTAL_PIXELS, readGifBatch, resolveGifCanvasSize, validateGifFiles, validateGifPixels } from "./gifMakerLogic";
import type { GifCanvasSize } from "./gifMakerLogic";
import "../../styles/features/gif-maker.css";

export type GifFitMode = "contain" | "stretch";
export type GifBackground = "transparent" | "white" | "black";
export type GifLoopMode = "infinite" | "finite";

export interface GifFrameModel {
  id: string;
  file: File;
  previewUrl: string;
  name: string;
  width: number;
  height: number;
  durationMs: number;
}

type GifStatus =
  | { kind: "idle" | "ready" | "success"; text: string }
  | { kind: "importing" | "exporting"; text: string }
  | { kind: "error"; text: string };

const DEFAULT_DURATION = 100;
const DEFAULT_FILE_NAME = "embedpix-animation.gif";
const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/bmp,.png,.jpg,.jpeg,.webp,.bmp";

function isImageFile(file: File): boolean {
  return /\.(bmp|jpe?g|png|webp)$/iu.test(file.name) && !file.type.startsWith("video/");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请检查图片和参数后重试。";
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取这张图片，请选择有效的图片文件。"));
    image.src = url;
  });
}

function readImageFrame(file: File, id: string): Promise<GifFrameModel> {
  const previewUrl = URL.createObjectURL(file);
  return loadImage(previewUrl)
    .then((image) => ({
      id,
      file,
      previewUrl,
      name: file.name,
      width: image.naturalWidth,
      height: image.naturalHeight,
      durationMs: DEFAULT_DURATION,
    }))
    .catch((error) => {
      URL.revokeObjectURL(previewUrl);
      throw error;
    });
}

function drawGifFrame(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  canvasSize: GifCanvasSize,
  fitMode: GifFitMode,
  background: GifBackground,
) {
  context.clearRect(0, 0, canvasSize.width, canvasSize.height);
  if (background !== "transparent") {
    context.fillStyle = background === "black" ? "#000000" : "#ffffff";
    context.fillRect(0, 0, canvasSize.width, canvasSize.height);
  }

  if (fitMode === "stretch") {
    context.drawImage(image, 0, 0, canvasSize.width, canvasSize.height);
    return;
  }

  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const scale = Math.min(canvasSize.width / sourceWidth, canvasSize.height / sourceHeight);
  const drawWidth = Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = Math.max(1, Math.round(sourceHeight * scale));
  context.drawImage(
    image,
    Math.round((canvasSize.width - drawWidth) / 2),
    Math.round((canvasSize.height - drawHeight) / 2),
    drawWidth,
    drawHeight,
  );
}

async function canvasToBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("无法生成 GIF 帧数据，请重试。");
  return new Uint8Array(await blob.arrayBuffer());
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
    <label className="gif-field" htmlFor={id}>
      <span>{label}</span>
      <ThemeSelect id={id} value={value} options={options} onChange={onChange} aria-label={label} />
    </label>
  );
}

function EmptyFrames({ onImport }: { onImport: () => void }) {
  return (
    <div className="gif-empty-frames">
      <ImagePlus size={24} aria-hidden="true" />
      <strong>还没有动画帧</strong>
      <span>导入多张图片，按顺序组成 GIF。</span>
      <button className="quiet-button" type="button" onClick={onImport}>
        <Upload size={15} aria-hidden="true" />导入图片
      </button>
    </div>
  );
}

export default function GifMakerView({ active = true }: { active?: boolean }) {
  const [frames, setFrames] = useState<GifFrameModel[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [canvasWidth, setCanvasWidth] = useState(320);
  const [canvasHeight, setCanvasHeight] = useState(240);
  const [keepAspectRatio, setKeepAspectRatio] = useState(true);
  const [fitMode, setFitMode] = useState<GifFitMode>("contain");
  const [background, setBackground] = useState<GifBackground>("transparent");
  const [globalDuration, setGlobalDuration] = useState(DEFAULT_DURATION);
  const [loopMode, setLoopMode] = useState<GifLoopMode>("infinite");
  const [loopCount, setLoopCount] = useState(3);
  const [fileName, setFileName] = useState(DEFAULT_FILE_NAME);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<GifStatus>({ kind: "idle", text: "等待导入图片" });
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<"timing" | "canvas" | "export" | null>("timing");
  const [locked, setLocked] = useState(false);
  const [pendingImports, setPendingImports] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceFrameIdRef = useRef<string | null>(null);
  const frameIdRef = useRef(0);
  const importQueueRef = useRef(new GifImportQueue());
  const lockedRef = useRef(false);
  const pendingRef = useRef(0);
  const initializedRef = useRef(false);
  const ratioRef = useRef<GifCanvasSize>({ width: 320, height: 240 });
  const repeatRef = useRef(0);
  const framesRef = useRef<GifFrameModel[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  framesRef.current = frames;

  useEffect(() => () => {
    importQueueRef.current.cancel();
    framesRef.current.forEach((frame) => URL.revokeObjectURL(frame.previewUrl));
  }, []);

  const selectedFrame = frames[selectedIndex] ?? null;
  const canvasSize = useMemo(
    () => ({ width: canvasWidth, height: canvasHeight }),
    [canvasHeight, canvasWidth],
  );

  useEffect(() => { if (!active) setIsPlaying(false); }, [active]);

  useEffect(() => {
    if (!frames.length) {
      setSelectedIndex(0);
      setIsPlaying(false);
      return;
    }
    setSelectedIndex((current) => Math.min(current, frames.length - 1));
  }, [frames.length]);

  useEffect(() => {
    if (!active || !isPlaying || frames.length < 2) return undefined;
    const timer = window.setTimeout(() => {
      const next = advanceGifPlayback(selectedIndex, frames.length, repeatRef.current, loopMode, loopCount);
      repeatRef.current = next.repeats;
      setSelectedIndex(next.index);
      if (next.stopped) setIsPlaying(false);
    }, frames[selectedIndex]?.durationMs ?? DEFAULT_DURATION);
    return () => window.clearTimeout(timer);
  }, [active, frames, isPlaying, selectedIndex, loopCount, loopMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!active || !canvas || !selectedFrame) return;
    let cancelled = false;
    canvas.width = canvasSize.width;
    canvas.height = canvasSize.height;
    void loadImage(selectedFrame.previewUrl).then((image) => {
      if (cancelled) return;
      const context = canvas.getContext("2d");
      if (context) drawGifFrame(context, image, canvasSize, fitMode, background);
    }).catch(() => {
      if (!cancelled) setError("预览帧读取失败，请重新导入图片。");
    });
    return () => { cancelled = true; };
  }, [active, background, canvasSize, fitMode, selectedFrame]);

  const openFileDialog = (frameId: string | null = null) => {
    if (lockedRef.current) return;
    replaceFrameIdRef.current = frameId;
    fileInputRef.current?.click();
  };

  const importFiles = async (inputFiles: File[], replaceFrameId: string | null = null) => {
    if (lockedRef.current || !inputFiles.length) return;
    const imageFiles = inputFiles.filter(isImageFile);
    if (imageFiles.length !== inputFiles.length) {
      setError("请选择 PNG、JPEG、BMP 或 WEBP 静态图片；不支持视频和 GIF 拆帧。");
      setStatus({ kind: "error", text: "导入失败" });
      return;
    }
    const filesToRead = replaceFrameId ? imageFiles.slice(0, 1) : imageFiles;
    pendingRef.current += 1;
    setPendingImports(pendingRef.current);
    setIsPlaying(false);
    setError(null);
    setStatus({ kind: "importing", text: `正在读取 ${filesToRead.length} 张图片…` });
    try {
      await importQueueRef.current.run(async (isCurrent) => {
        const retained = framesRef.current.filter((frame) => frame.id !== replaceFrameId);
        validateGifFiles([...retained.map((frame) => frame.file), ...filesToRead]);
        let pixels = retained.reduce((sum, frame) => sum + frame.width * frame.height, 0);
        const loadedFrames = await readGifBatch(filesToRead, async (file) => {
          const frame = await readImageFrame(file, `gif-frame-${++frameIdRef.current}`);
          try {
            validateGifPixels(frame, 1);
            pixels += frame.width * frame.height;
            if (pixels > MAX_TOTAL_PIXELS) throw new Error("素材累计像素超过 64 Mi，请减少图片或先缩小原图。");
            return { ...frame, durationMs: globalDuration };
          } catch (loadError) { URL.revokeObjectURL(frame.previewUrl); throw loadError; }
        }, (frame) => URL.revokeObjectURL(frame.previewUrl), isCurrent);
        if (!isCurrent() || !loadedFrames.length) return;
        const current = framesRef.current;
        const index = current.findIndex((frame) => frame.id === replaceFrameId);
        if (replaceFrameId && index < 0) {
          loadedFrames.forEach((frame) => URL.revokeObjectURL(frame.previewUrl));
          return;
        }
        if (!initializedRef.current) {
          initializedRef.current = true;
          ratioRef.current = loadedFrames[0];
          setCanvasWidth(loadedFrames[0].width);
          setCanvasHeight(loadedFrames[0].height);
        }
        const next = replaceFrameId ? current.map((frame, i) => i === index ? { ...loadedFrames[0], durationMs: frame.durationMs } : frame) : [...current, ...loadedFrames];
        if (index >= 0) URL.revokeObjectURL(current[index].previewUrl);
        framesRef.current = next;
        setFrames(next);
        setSelectedIndex(replaceFrameId ? index : current.length);
        setStatus({ kind: "ready", text: `已加入 ${loadedFrames.length} 张图片` });
      });
    } catch (loadError) {
      setError(getErrorMessage(loadError));
      setStatus({ kind: "error", text: "导入失败" });
    } finally {
      pendingRef.current -= 1;
      setPendingImports(pendingRef.current);
    }
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    const replaceFrameId = replaceFrameIdRef.current;
    replaceFrameIdRef.current = null;
    event.target.value = "";
    void importFiles(selectedFiles, replaceFrameId);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    void importFiles(Array.from(event.dataTransfer.files));
  };

  const removeFrame = (index: number) => {
    if (lockedRef.current) return;
    setIsPlaying(false);
    const frame = frames[index];
    if (!frame) return;
    URL.revokeObjectURL(frame.previewUrl);
    framesRef.current = frames.filter((_, frameIndex) => frameIndex !== index);
    setFrames(framesRef.current);
    setSelectedIndex((current) => Math.max(0, Math.min(current - (index < current ? 1 : 0), frames.length - 2)));
    setStatus({ kind: "ready", text: "已移除一帧" });
  };

  const moveFrame = (index: number, direction: -1 | 1) => {
    if (lockedRef.current) return;
    setIsPlaying(false);
    const targetIndex = getGifFrameOrder(frames.length, index, direction);
    if (targetIndex === index || targetIndex < 0) return;
    setFrames((current) => {
      const next = [...current];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
    setSelectedIndex(targetIndex);
  };

  const reverseFrames = () => {
    if (lockedRef.current) return;
    setIsPlaying(false);
    setFrames((current) => [...current].reverse());
    setSelectedIndex((current) => Math.max(0, frames.length - current - 1));
  };

  const clearFrames = () => {
    if (lockedRef.current) return;
    importQueueRef.current.cancel();
    frames.forEach((frame) => URL.revokeObjectURL(frame.previewUrl));
    framesRef.current = [];
    setFrames([]);
    setSelectedIndex(0);
    setIsPlaying(false);
    setOutputPath(null);
    setStatus({ kind: "idle", text: "等待导入图片" });
    setError(null);
  };

  const updateCanvasWidth = (value: number) => {
    initializedRef.current = true;
    const next = resolveGifCanvasSize(ratioRef.current, value, canvasHeight, keepAspectRatio);
    setCanvasWidth(next.width);
    setCanvasHeight(next.height);
  };

  const updateCanvasHeight = (value: number) => {
    initializedRef.current = true;
    const next = resolveGifCanvasSize({ width: ratioRef.current.height, height: ratioRef.current.width }, value, canvasWidth, keepAspectRatio);
    setCanvasHeight(next.width);
    setCanvasWidth(next.height);
  };

  const updateAllDurations = (value: number) => {
    const duration = clampFrameDuration(value);
    setGlobalDuration(duration);
    setFrames((current) => current.map((frame) => ({ ...frame, durationMs: duration })));
  };

  const updateSelectedDuration = (value: number) => {
    const duration = clampFrameDuration(value);
    setFrames((current) => current.map((frame, index) => index === selectedIndex ? { ...frame, durationMs: duration } : frame));
  };

  const chooseOutput = async () => {
    if (lockedRef.current) return;
    lockedRef.current = true;
    setLocked(true);
    setIsPlaying(false);
    try {
      const chosen = await pickGifOutput(fileName.trim() || DEFAULT_FILE_NAME);
      if (chosen) {
        setOutputPath(chosen);
        setError(null);
        setStatus({ kind: "ready", text: "已选择 GIF 保存位置" });
      }
    } catch (chooseError) {
      setError(getErrorMessage(chooseError));
      setStatus({ kind: "error", text: "无法选择保存位置" });
    } finally {
      lockedRef.current = false;
      setLocked(false);
    }
  };

  const exportAnimation = async () => {
    if (lockedRef.current || pendingRef.current) return;
    if (!frames.length) {
      setError("请先导入至少一张图片。");
      return;
    }
    if (!fileName.trim()) {
      setError("请输入 GIF 文件名。");
      return;
    }
    if (!outputPath) {
      setError("请先选择 GIF 保存位置。");
      return;
    }
    setError(null);
    lockedRef.current = true;
    setLocked(true);
    setIsPlaying(false);
    setStatus({ kind: "exporting", text: `正在渲染 ${frames.length} 帧…` });
    try {
      validateGifPixels(canvasSize, frames.length);
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = canvasSize.width;
      exportCanvas.height = canvasSize.height;
      const context = exportCanvas.getContext("2d");
      if (!context) throw new Error("当前环境无法创建 GIF 画布。");
      const exportFrames = [];
      for (const frame of frames) {
        let data: Uint8Array;
        if (fitMode === "stretch" && background === "transparent") {
          data = new Uint8Array(await frame.file.arrayBuffer());
        } else {
          const image = await loadImage(frame.previewUrl);
          drawGifFrame(context, image, canvasSize, fitMode, background);
          data = await canvasToBytes(exportCanvas);
        }
        exportFrames.push({ data, durationMs: clampFrameDuration(frame.durationMs) });
        validateGifFiles(exportFrames.map((entry) => ({ size: entry.data.byteLength })));
      }
      const result = await exportGif({
        outputPath,
        width: canvasSize.width,
        height: canvasSize.height,
        loopMode,
        loopCount: loopMode === "finite" ? Math.max(1, Math.round(loopCount)) : 0,
        frames: exportFrames,
      });
      setStatus({ kind: "success", text: `GIF 已导出：${result}` });
    } catch (exportError) {
      setError(getErrorMessage(exportError));
      setStatus({ kind: "error", text: "GIF 导出失败" });
    } finally {
      lockedRef.current = false;
      setLocked(false);
    }
  };

  const sourceHint = selectedFrame ? `${selectedFrame.width} × ${selectedFrame.height} px` : "导入后自动读取尺寸";
  const canMoveLeft = selectedIndex > 0;
  const canMoveRight = selectedIndex >= 0 && selectedIndex < frames.length - 1;

  return (
    <div className="gif-maker-view page-view">
      <header className="page-header gif-maker-header">
        <div className="page-header-icon"><Film size={19} aria-hidden="true" /></div>
        <div className="page-header-copy">
          <p className="page-eyebrow">GIF MAKER</p>
          <h1>GIF 制作</h1>
          <p>把图片序列整理成适合界面演示和嵌入式资源预览的轻量动画。</p>
        </div>
        <div className="gif-header-note"><span className="status-dot" />仅支持图片序列</div>
      </header>

      <fieldset className="page-content gif-maker-content" disabled={locked} aria-label="GIF 制作工作区" aria-busy={locked || pendingImports > 0}>
        <div className="gif-maker-toolbar">
          <button className="primary-button" type="button" onClick={() => openFileDialog()}>
            <Upload size={16} aria-hidden="true" />导入图片序列
          </button>
          <span>多选 / 拖放追加 · 最多 200 帧，32 MiB / 帧，总计 128 MiB</span>
          {pendingImports > 0 ? <button className="quiet-button" type="button" onClick={clearFrames}>取消导入并清空</button> : null}
          <input ref={fileInputRef} className="gif-hidden-input" type="file" accept={IMAGE_ACCEPT} multiple onChange={handleInputChange} />
        </div>

        <div className="gif-workspace-grid">
          <section className="gif-card gif-assets-card" aria-labelledby="gif-assets-title">
            <div className="gif-card-heading">
              <div><p className="gif-card-kicker">01 / ASSETS</p><h2 id="gif-assets-title">素材帧</h2></div>
              {frames.length ? <span className="gif-count-badge">{frames.length} 帧</span> : null}
            </div>
            <div
              className={`gif-drop-zone${isDragging ? " gif-drop-zone-active" : ""}`}
              role="button"
              tabIndex={locked ? -1 : 0}
              aria-disabled={locked}
              onClick={() => openFileDialog()}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openFileDialog(); } }}
              onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
              onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              aria-label="拖放图片或选择图片"
            >
              <Upload size={20} aria-hidden="true" />
              <strong>{isDragging ? "松开以添加图片" : "拖放图片到这里"}</strong>
              <span>或点击选择多个文件</span>
            </div>
            {frames.length ? (
              <>
                <div className="gif-frame-toolbar">
                  <span>帧顺序</span>
                  <div>
                    <button className="icon-button" type="button" aria-label="倒序" title="倒序" onClick={reverseFrames}><RotateCcw size={15} aria-hidden="true" /></button>
                    <button className="icon-button" type="button" aria-label="清空帧" title="清空帧" onClick={clearFrames}><Trash2 size={15} aria-hidden="true" /></button>
                  </div>
                </div>
                <div className="gif-frame-list" aria-label="GIF 帧列表">
                  {frames.map((frame, index) => (
                    <div className={`gif-frame-row${selectedIndex === index ? " gif-frame-row-selected" : ""}`} key={frame.id}>
                      <button className="gif-frame-select" type="button" onClick={() => { setIsPlaying(false); setSelectedIndex(index); }} aria-pressed={selectedIndex === index} aria-label={`选择第 ${index + 1} 帧：${frame.name}`}>
                        <span className="gif-frame-number">{String(index + 1).padStart(2, "0")}</span>
                        <img src={frame.previewUrl} alt="" />
                        <span className="gif-frame-meta"><strong>{frame.name}</strong><small>{frame.width} × {frame.height} · {frame.durationMs} ms</small></span>
                      </button>
                      <div className="gif-frame-actions">
                        <button className="icon-button" type="button" aria-label={`第 ${index + 1} 帧上移`} title="上移" disabled={!canMoveLeft || selectedIndex !== index} onClick={() => moveFrame(index, -1)}><ArrowUp size={14} aria-hidden="true" /></button>
                        <button className="icon-button" type="button" aria-label={`第 ${index + 1} 帧下移`} title="下移" disabled={!canMoveRight || selectedIndex !== index} onClick={() => moveFrame(index, 1)}><ArrowDown size={14} aria-hidden="true" /></button>
                        <button className="icon-button" type="button" aria-label={`更换第 ${index + 1} 帧`} title="更换此帧" onClick={() => openFileDialog(frame.id)}><RotateCcw size={14} aria-hidden="true" /></button>
                        <button className="icon-button" type="button" aria-label={`移除第 ${index + 1} 帧`} title="移除" onClick={() => removeFrame(index)}><X size={14} aria-hidden="true" /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : <EmptyFrames onImport={() => openFileDialog()} />}
          </section>

          <div className="gif-main-column">
            <section className="gif-card gif-preview-card" aria-labelledby="gif-preview-title">
              <div className="gif-card-heading">
                <div><p className="gif-card-kicker">02 / PREVIEW</p><h2 id="gif-preview-title">动画预览</h2></div>
                <div className="gif-playback-controls">
                <button className="icon-button" type="button" aria-label="上一帧" disabled={!canMoveLeft} onClick={() => { setIsPlaying(false); setSelectedIndex(selectedIndex - 1); }}><ArrowLeft size={15} /></button>
                <button className="quiet-button gif-play-button" type="button" disabled={frames.length < 2 || pendingImports > 0} onClick={() => { repeatRef.current = 0; if (!isPlaying) setSelectedIndex(0); setIsPlaying((playing) => !playing); }}>
                  {isPlaying ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}{isPlaying ? "暂停" : "播放"}
                </button>
                <button className="icon-button" type="button" aria-label="下一帧" disabled={!canMoveRight} onClick={() => { setIsPlaying(false); setSelectedIndex(selectedIndex + 1); }}><ArrowRight size={15} /></button>
                </div>
              </div>
              <div className={`gif-canvas-stage gif-background-${background}`}>
                {selectedFrame ? <canvas ref={canvasRef} className="gif-preview-canvas" aria-label={`第 ${selectedIndex + 1} 帧预览`} /> : <div className="gif-preview-empty"><Film size={28} aria-hidden="true" /><span>导入图片后预览动画</span></div>}
              </div>
              <div className="gif-preview-footer"><span>{frames.length ? `第 ${selectedIndex + 1} / ${frames.length} 帧` : "未选择帧"}</span><span>{sourceHint}</span><span>{canvasSize.width} × {canvasSize.height} px 画布</span></div>
            </section>

          </div>
        </div>

        <section className="gif-card gif-settings-card" aria-label="GIF 参数">
          <div className="gif-group-tabs">
            {([['timing', '帧时长'], ['canvas', '画布'], ['export', '导出设置']] as const).map(([id, label]) => (
              <button key={id} id={`gif-group-${id}`} className={`quiet-button${group === id ? ' gif-group-active' : ''}`} type="button" aria-expanded={group === id} aria-controls={`gif-panel-${id}`} onClick={() => setGroup(group === id ? null : id)}>{label}</button>
            ))}
            <span>再次点击折叠</span>
          </div>
          {group === "timing" ? <div id="gif-panel-timing" role="region" aria-labelledby="gif-group-timing">
              <div className="gif-settings-grid">
                <label className="gif-field"><span>全局帧时长 · 应用全部帧</span><div className="gif-input-with-suffix"><input type="number" min="10" max="60000" step="10" value={globalDuration} onChange={(event) => updateAllDurations(Number(event.target.value))} /><small>ms</small></div></label>
                <label className="gif-field"><span>当前帧时长</span><div className="gif-input-with-suffix"><input type="number" min="10" max="60000" step="10" value={selectedFrame?.durationMs ?? DEFAULT_DURATION} disabled={!selectedFrame} onChange={(event) => updateSelectedDuration(Number(event.target.value))} /><small>ms</small></div></label>
              </div>
              <p className="gif-help-text">10–60000 ms，向下取整到 10 ms；总时长 {(frames.reduce((sum, frame) => sum + frame.durationMs, 0) / 1000).toFixed(2)} 秒 / 轮。</p>
          </div> : null}
          {group === "canvas" ? <div id="gif-panel-canvas" role="region" aria-labelledby="gif-group-canvas">
              <div className="gif-settings-grid">
                <div className="gif-field"><span>画布尺寸</span><div className="gif-dimensions-row"><label><span className="sr-only">宽度</span><input aria-label="画布宽度" type="number" min="1" max="4096" value={canvasWidth} onChange={(event) => updateCanvasWidth(Number(event.target.value))} /></label><span>×</span><label><span className="sr-only">高度</span><input aria-label="画布高度" type="number" min="1" max="4096" value={canvasHeight} onChange={(event) => updateCanvasHeight(Number(event.target.value))} /></label></div></div>
                <label className="gif-check-row"><input type="checkbox" checked={keepAspectRatio} onChange={(event) => { ratioRef.current = canvasSize; setKeepAspectRatio(event.target.checked); }} /><span><strong>保持画布比例</strong><small>锁定当前画布，与选帧无关</small></span></label>
                <SelectField id="gif-fit-mode" label="缩放方式" value={fitMode} options={[{ value: "contain" as const, label: "适应画布（保持比例）" }, { value: "stretch" as const, label: "拉伸填满画布" }]} onChange={setFitMode} />
                <SelectField id="gif-background" label="背景" value={background} options={[{ value: "transparent" as const, label: "透明" }, { value: "white" as const, label: "白色" }, { value: "black" as const, label: "黑色" }]} onChange={setBackground} />
              </div>
              <p className="gif-help-text">{fitMode === "contain" ? "等比居中并按所选背景补边，转为 PNG 帧后导出。" : background === "transparent" ? "原图交由后端拉伸至画布尺寸，预览同样拉伸。" : "拉伸并合成所选背景，转为 PNG 帧后导出。"}</p>
          </div> : null}
          {group === "export" ? <div id="gif-panel-export" role="region" aria-labelledby="gif-group-export">
          <div className="gif-export-grid">
            <label className="gif-field"><span>文件名</span><input value={fileName} maxLength={120} onChange={(event) => { setFileName(event.target.value); setOutputPath(null); }} placeholder={DEFAULT_FILE_NAME} /></label>
            <SelectField id="gif-loop-mode" label="循环方式" value={loopMode} options={[{ value: "infinite" as const, label: "无限循环" }, { value: "finite" as const, label: "有限重复" }]} onChange={(value) => { setIsPlaying(false); setLoopMode(value); }} />
            <label className="gif-field"><span>额外重复次数{loopMode === "finite" ? ` · 共播放 ${loopCount + 1} 次` : ""}</span><div className="gif-input-with-suffix"><input type="number" min="1" max="65535" value={loopCount} disabled={loopMode === "infinite"} onChange={(event) => { setIsPlaying(false); setLoopCount(Math.min(65535, Math.max(1, Math.floor(Number(event.target.value)) || 1))); }} /><small>次</small></div></label>
            <div className="gif-output-picker"><span className="gif-field-label">保存位置</span><div className="gif-output-row"><span title={outputPath ?? undefined}>{outputPath ?? "尚未选择保存位置"}</span><button className="quiet-button" type="button" onClick={() => void chooseOutput()}>选择位置</button></div></div>
          </div>
          <p className="gif-help-text">桌面端保存；默认不覆盖同名文件，请选择新文件名。</p>
          </div> : null}
        </section>
      </fieldset>
      <div className="gif-export-footer">
        {error ? <p className="gif-error-message" role="alert">{error}</p> : <p className={`gif-status gif-status-${status.kind}`} role="status">{status.text}</p>}
        <button className="export-button gif-export-button" type="button" disabled={!frames.length || locked || pendingImports > 0} onClick={() => { if (!outputPath) { setGroup("export"); void chooseOutput(); } else { void exportAnimation(); } }}><Film size={17} aria-hidden="true" />{status.kind === "exporting" ? "处理中…" : outputPath ? "导出 GIF" : "选择保存位置"}</button>
      </div>
    </div>
  );
}
