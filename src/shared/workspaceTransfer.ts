import type { GifMakerPreferences } from "../features/gif-maker/gifMakerPreferences";
import type { ImageConverterDefaults } from "../platform/preferences/appPreferences";
import type { OutputLocation } from "../features/image-converter/types";

export const WORKSPACE_SCHEMA = "embedpix.workspace" as const;
export const WORKSPACE_VERSION = 1 as const;
const MAX_JSON_BYTES = 1 * 1024 * 1024;

export function formatWorkspaceTransferError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const mappings: ReadonlyArray<[string, string]> = [
    ["workspace snapshot is not valid JSON", "工作区快照不是有效 JSON"],
    ["workspace snapshot exceeds 1 MiB", "工作区快照超过 1 MiB 限制"],
    ["unsupported workspace schema or version", "工作区 schema 或版本不受支持"],
    ["workspace type is invalid", "工作区类型无效"],
    ["workspace snapshot must be an object", "工作区快照必须是对象"],
    ["workspace contains unsupported fields", "工作区包含不支持的字段"],
    ["sources must be an array", "sources 必须是数组"],
    ["frames must be an array", "frames 必须是数组"],
    ["fileName is invalid", "fileName 无效"],
    ["source kind is invalid", "source kind 无效"],
    ["outputLocation is invalid", "outputLocation 无效"],
    ["namingTemplate is unsafe", "namingTemplate 不安全"],
    ["source fps is out of range", "source fps 超出有效范围"],
    ["is unsafe", "不安全"],
    ["is out of range", "超出有效范围"],
    ["must be an object", "必须是对象"],
    ["contains unsupported fields", "包含不支持的字段"],
    ["path may no longer exist", "路径可能已不存在"],
  ];
  for (const [prefix, label] of mappings) {
    const index = message.indexOf(prefix);
    if (index >= 0) return `${message.slice(0, index)}${label}${message.slice(index + prefix.length)}`;
  }
  const frameMismatch = /^GIF frame metadata count \((\d+)\) does not match source count \((\d+)\)$/u.exec(message);
  if (frameMismatch) return `GIF 帧元数据数量（${frameMismatch[1]}）与源数量（${frameMismatch[2]}）不匹配`;
  return message || "工作区导入失败，请检查文件后重试。";
}

export interface WorkspaceSource { path: string; fileName: string; kind?: "image" | "video"; width?: number; height?: number; sizeBytes?: number; durationMs?: number; fps?: number; }
export interface WorkspaceFrame { index: number; durationMs: number; width?: number; height?: number; sizeBytes?: number; }
export interface ImageWorkspaceSnapshot { type: "image"; parameters: ImageConverterDefaults; outputLocation: OutputLocation; outputDirectory?: string; outputSubdirectory?: string; namingTemplate?: string; sources: WorkspaceSource[]; }
export interface GifWorkspaceSnapshot { type: "gif"; parameters: GifMakerPreferences; outputLocation: string; outputDirectory?: string; outputSubdirectory?: string; namingTemplate?: string; sources: WorkspaceSource[]; frames: WorkspaceFrame[]; }
export type WorkspaceSnapshot = ImageWorkspaceSnapshot | GifWorkspaceSnapshot;
export interface WorkspaceTransferDocument { schema: typeof WORKSPACE_SCHEMA; version: typeof WORKSPACE_VERSION; workspaces: WorkspaceSnapshot[]; }
export interface WorkspaceRestoreIssue { workspaceIndex: number; kind: "missing-path" | "frame-metadata-mismatch" | "unrecoverable-field"; path?: string; field?: string; message: string; }
export interface WorkspaceRestoreResult { workspaces: WorkspaceSnapshot[]; issues: WorkspaceRestoreIssue[]; }

const IMAGE_PARAMETER_KEYS = ["defaultOutputFormat", "defaultJpegQuality", "defaultBitDepth", "defaultByteOrder", "defaultChannelOrder", "defaultRowOrder", "defaultRowAlignment", "defaultCArrayName", "defaultBackgroundColor", "keepAspectRatio"] as const;
const GIF_PARAMETER_KEYS = ["canvasPreset", "canvasWidth", "canvasHeight", "keepAspectRatio", "fitMode", "contentAlignment", "contentMargins", "globalDuration", "batchDuration", "firstFrameHoldDuration", "lastFrameHoldDuration", "playbackSpeed", "background", "customBackgroundColor", "loopMode", "loopCount", "encodingQuality", "colorCount", "ditherMode", "gifPreset", "targetSizeKiB", "maxSizeKiB", "autoCompress", "mergeIdenticalFrames", "overwriteExisting", "outputFormat", "videoFps", "videoEveryNthFrame", "videoMaxFrames", "videoCropPreset", "videoRotation", "videoReverse"] as const;
const SOURCE_KEYS = ["path", "fileName", "kind", "width", "height", "sizeBytes", "durationMs", "fps"] as const;
const FRAME_KEYS = ["index", "durationMs", "width", "height", "sizeBytes"] as const;
const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function whitelist(value: Record<string, unknown>, keys: readonly string[], label: string): void { if (Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some((key) => !keys.includes(key) || BAD_KEYS.has(key))) throw new Error(`${label} contains unsupported fields`); }
function integer(value: unknown, min: number, max: number, label: string): void { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is out of range`); }
function safePath(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value) || /^(?:blob:|data:)/iu.test(value)) throw new Error(`${label} is unsafe`); return value; }
function optionalPath(value: unknown, label: string): string | undefined { return value === undefined ? undefined : safePath(value, label); }
function validateSource(value: unknown): WorkspaceSource { const item = record(value, "source"); whitelist(item, SOURCE_KEYS, "source"); safePath(item.path, "source path"); if (typeof item.fileName !== "string" || !item.fileName.trim()) throw new Error("source fileName is invalid"); if (item.kind !== undefined && item.kind !== "image" && item.kind !== "video") throw new Error("source kind is invalid"); for (const key of ["width", "height", "sizeBytes", "durationMs"] as const) if (item[key] !== undefined) integer(item[key], 0, Number.MAX_SAFE_INTEGER, `source ${key}`); if (item.fps !== undefined) { if (typeof item.fps !== "number" || !Number.isFinite(item.fps) || item.fps <= 0 || item.fps > 240) throw new Error("source fps is out of range"); } return item as unknown as WorkspaceSource; }
function validateFrame(value: unknown): WorkspaceFrame { const item = record(value, "frame"); whitelist(item, FRAME_KEYS, "frame"); integer(item.index, 0, 200, "frame index"); integer(item.durationMs, 10, 60000, "frame duration"); for (const key of ["width", "height", "sizeBytes"] as const) if (item[key] !== undefined) integer(item[key], 0, Number.MAX_SAFE_INTEGER, `frame ${key}`); return item as unknown as WorkspaceFrame; }
function validateParameters(value: unknown, type: "image" | "gif"): ImageConverterDefaults | GifMakerPreferences { const parameters = record(value, `${type} parameters`); const keys = type === "image" ? IMAGE_PARAMETER_KEYS : GIF_PARAMETER_KEYS; whitelist(parameters, keys, `${type} parameters`); return parameters as unknown as ImageConverterDefaults | GifMakerPreferences; }
function transferableParameters(value: ImageConverterDefaults | GifMakerPreferences, type: "image" | "gif"): ImageConverterDefaults | GifMakerPreferences { const source = value as unknown as Record<string, unknown>; const keys = type === "image" ? IMAGE_PARAMETER_KEYS : GIF_PARAMETER_KEYS; return Object.fromEntries(keys.map((key) => [key, source[key]])) as unknown as ImageConverterDefaults | GifMakerPreferences; }

export function exportWorkspaceSnapshot(workspaces: readonly WorkspaceSnapshot[]): string {
  const sanitized = workspaces.map((workspace) => {
    const item = record(workspace, "workspace");
    if (item.type !== "image" && item.type !== "gif") throw new Error("workspace type is invalid");
    whitelist(item, item.type === "image" ? ["type", "parameters", "outputLocation", "outputDirectory", "outputSubdirectory", "namingTemplate", "sources"] : ["type", "parameters", "outputLocation", "outputDirectory", "outputSubdirectory", "namingTemplate", "sources", "frames"], "workspace");
    const parameters = validateParameters(transferableParameters(item.parameters as ImageConverterDefaults | GifMakerPreferences, item.type), item.type);
    if (typeof item.outputLocation !== "string" || !item.outputLocation.trim()) throw new Error("outputLocation is invalid");
    optionalPath(item.outputDirectory, "outputDirectory"); optionalPath(item.outputSubdirectory, "outputSubdirectory");
    if (item.namingTemplate !== undefined && (typeof item.namingTemplate !== "string" || /[\u0000-\u001f\u007f]/u.test(item.namingTemplate) || /[\\/]/u.test(item.namingTemplate))) throw new Error("namingTemplate is unsafe");
    if (!Array.isArray(item.sources)) throw new Error("sources must be an array");
    const sources = item.sources.map(validateSource);
    const frames = item.type === "gif" ? (Array.isArray(item.frames) ? item.frames.map(validateFrame) : (() => { throw new Error("frames must be an array"); })()) : undefined;
    return frames ? { ...item, parameters, sources, frames } : { ...item, parameters, sources };
  });
  const document: WorkspaceTransferDocument = { schema: WORKSPACE_SCHEMA, version: WORKSPACE_VERSION, workspaces: sanitized as WorkspaceSnapshot[] };
  const serialized = JSON.stringify(document);
  if (new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) throw new Error("workspace snapshot exceeds 1 MiB");
  return serialized;
}

export function importWorkspaceSnapshot(serialized: string): WorkspaceRestoreResult {
  if (new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) throw new Error("workspace snapshot exceeds 1 MiB");
  if (/"(?:__proto__|prototype|constructor)"\s*:/u.test(serialized)) throw new Error("workspace contains unsupported fields");
  let parsed: unknown; try { parsed = JSON.parse(serialized); } catch { throw new Error("workspace snapshot is not valid JSON"); }
  const document = record(parsed, "workspace snapshot");
  if (document.schema !== WORKSPACE_SCHEMA || document.version !== WORKSPACE_VERSION || !Array.isArray(document.workspaces)) throw new Error("unsupported workspace schema or version");
  const issues: WorkspaceRestoreIssue[] = []; const workspaces: WorkspaceSnapshot[] = [];
  document.workspaces.forEach((value, workspaceIndex) => {
    try {
      const item = record(value, "workspace");
      if (item.type !== "image" && item.type !== "gif") throw new Error("workspace type is invalid");
      whitelist(item, item.type === "image" ? ["type", "parameters", "outputLocation", "outputDirectory", "outputSubdirectory", "namingTemplate", "sources"] : ["type", "parameters", "outputLocation", "outputDirectory", "outputSubdirectory", "namingTemplate", "sources", "frames"], "workspace");
      validateParameters(item.parameters, item.type);
      if (typeof item.outputLocation !== "string" || !item.outputLocation.trim()) throw new Error("outputLocation is invalid");
      optionalPath(item.outputDirectory, "outputDirectory"); optionalPath(item.outputSubdirectory, "outputSubdirectory");
      if (item.namingTemplate !== undefined && (typeof item.namingTemplate !== "string" || /[\u0000-\u001f\u007f]/u.test(item.namingTemplate) || /[\\/]/u.test(item.namingTemplate))) throw new Error("namingTemplate is unsafe");
      const sources = Array.isArray(item.sources) ? item.sources.map(validateSource) : (() => { throw new Error("sources must be an array"); })();
      const snapshot = item.type === "gif" ? { ...item, sources, frames: Array.isArray(item.frames) ? item.frames.map(validateFrame) : [] } : { ...item, sources };
      workspaces.push(snapshot as WorkspaceSnapshot);
      sources.forEach((source, sourceIndex) => { if (source.path.startsWith("/missing/") || source.path.startsWith("missing:")) issues.push({ workspaceIndex, kind: "missing-path", path: source.path, message: `source ${sourceIndex + 1} path may no longer exist` }); });
      if (item.type === "gif" && Array.isArray(item.frames) && item.frames.length !== sources.length) issues.push({ workspaceIndex, kind: "frame-metadata-mismatch", message: `GIF frame metadata count (${item.frames.length}) does not match source count (${sources.length})` });
    } catch (error) { issues.push({ workspaceIndex, kind: "unrecoverable-field", field: "workspace", message: error instanceof Error ? error.message : String(error) }); }
  });
  return { workspaces, issues };
}

// Compatibility helpers keep lightweight page integrations on the same strict snapshot contract.
export function exportWorkspace(bundle: { kind: "image" | "gif"; parameters: Record<string, unknown>; sourcePaths: string[]; sourceKind?: "image" | "video"; sourceMetadata?: Partial<WorkspaceSource>; frames?: WorkspaceFrame[]; outputLocation?: string; outputDirectory?: string; outputSubdirectory?: string; namingTemplate?: string }): string {
  const parameters = bundle.kind === "image" ? {
    defaultOutputFormat: bundle.parameters.outputFormat ?? "bmp", defaultJpegQuality: bundle.parameters.jpegQuality ?? 85, defaultBitDepth: bundle.parameters.bitDepth ?? 24,
    defaultByteOrder: bundle.parameters.byteOrder ?? "little", defaultChannelOrder: bundle.parameters.channelOrder ?? "rgb", defaultRowOrder: bundle.parameters.rowOrder ?? "top-down", defaultRowAlignment: bundle.parameters.rowAlignment ?? 1,
    defaultCArrayName: bundle.parameters.cArrayName ?? "image_data", defaultBackgroundColor: bundle.parameters.backgroundColor ?? "#FFFFFF", keepAspectRatio: bundle.parameters.keepAspectRatio ?? true,
  } : bundle.parameters as unknown as GifMakerPreferences;
  const snapshot = bundle.kind === "image"
    ? { type: "image" as const, parameters, outputLocation: (bundle.outputLocation ?? "source") as OutputLocation, outputDirectory: bundle.outputDirectory, outputSubdirectory: bundle.outputSubdirectory, namingTemplate: bundle.namingTemplate, sources: bundle.sourcePaths.map((path) => ({ path, fileName: path.split(/[\\/]/u).pop() ?? path })) }
    : { type: "gif" as const, parameters, outputLocation: bundle.outputLocation ?? "path", outputDirectory: bundle.outputDirectory, outputSubdirectory: bundle.outputSubdirectory, namingTemplate: bundle.namingTemplate, sources: bundle.sourcePaths.map((path) => ({ path, fileName: path.split(/[\\/]/u).pop() ?? path, ...bundle.sourceMetadata, ...(bundle.sourceKind ? { kind: bundle.sourceKind } : {}) })), frames: bundle.frames ?? [] };
  return exportWorkspaceSnapshot([snapshot as WorkspaceSnapshot]);
}

export function importWorkspace(serialized: string, kind: "image" | "gif"): { parameters: Record<string, unknown>; sourcePaths: string[]; sourceKind?: "image" | "video"; sourceMetadata?: WorkspaceSource; frames: WorkspaceFrame[]; outputLocation: string; outputDirectory?: string; outputSubdirectory?: string; namingTemplate?: string; issues: WorkspaceRestoreIssue[] } {
  const result = importWorkspaceSnapshot(serialized);
  const workspace = result.workspaces.find((item) => item.type === kind);
  if (!workspace) throw new Error("工作区文件类型不匹配。");
  return { parameters: workspace.parameters as unknown as Record<string, unknown>, sourcePaths: workspace.sources.map((source) => source.path), sourceKind: workspace.sources[0]?.kind, sourceMetadata: workspace.sources[0], frames: workspace.type === "gif" ? workspace.frames : [], outputLocation: workspace.outputLocation, outputDirectory: workspace.outputDirectory, outputSubdirectory: workspace.outputSubdirectory, namingTemplate: workspace.namingTemplate, issues: result.issues };
}
