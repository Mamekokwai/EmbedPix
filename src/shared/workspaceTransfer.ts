import type { GifMakerPreferences } from "../features/gif-maker/gifMakerPreferences";
import type { ImageConverterDefaults } from "../platform/preferences/appPreferences";
import type { OutputLocation } from "../features/image-converter/types";

export const WORKSPACE_SCHEMA = "embedpix.workspace" as const;
export const WORKSPACE_VERSION = 1 as const;
const MAX_JSON_BYTES = 1 * 1024 * 1024;

export interface WorkspaceSource { path: string; fileName: string; width?: number; height?: number; sizeBytes?: number; }
export interface WorkspaceFrame { index: number; durationMs: number; width?: number; height?: number; sizeBytes?: number; }
export interface ImageWorkspaceSnapshot { type: "image"; parameters: ImageConverterDefaults; outputLocation: OutputLocation; outputDirectory?: string; outputSubdirectory?: string; namingTemplate?: string; sources: WorkspaceSource[]; }
export interface GifWorkspaceSnapshot { type: "gif"; parameters: GifMakerPreferences; outputLocation: string; outputDirectory?: string; outputSubdirectory?: string; namingTemplate?: string; sources: WorkspaceSource[]; frames: WorkspaceFrame[]; }
export type WorkspaceSnapshot = ImageWorkspaceSnapshot | GifWorkspaceSnapshot;
export interface WorkspaceTransferDocument { schema: typeof WORKSPACE_SCHEMA; version: typeof WORKSPACE_VERSION; workspaces: WorkspaceSnapshot[]; }
export interface WorkspaceRestoreIssue { workspaceIndex: number; kind: "missing-path" | "unrecoverable-field"; path?: string; field?: string; message: string; }
export interface WorkspaceRestoreResult { workspaces: WorkspaceSnapshot[]; issues: WorkspaceRestoreIssue[]; }

const IMAGE_PARAMETER_KEYS = ["defaultOutputFormat", "defaultJpegQuality", "defaultBitDepth", "defaultByteOrder", "defaultChannelOrder", "defaultRowOrder", "defaultRowAlignment", "defaultCArrayName", "defaultBackgroundColor", "keepAspectRatio"] as const;
const GIF_PARAMETER_KEYS = ["canvasPreset", "canvasWidth", "canvasHeight", "keepAspectRatio", "fitMode", "contentAlignment", "contentMargins", "globalDuration", "batchDuration", "firstFrameHoldDuration", "lastFrameHoldDuration", "playbackSpeed", "background", "customBackgroundColor", "loopMode", "loopCount", "encodingQuality", "colorCount", "ditherMode", "gifPreset", "targetSizeKiB", "maxSizeKiB", "autoCompress", "mergeIdenticalFrames", "overwriteExisting", "outputFormat", "videoFps", "videoEveryNthFrame", "videoMaxFrames", "videoCropPreset", "videoRotation", "videoReverse"] as const;
const SOURCE_KEYS = ["path", "fileName", "width", "height", "sizeBytes"] as const;
const FRAME_KEYS = ["index", "durationMs", "width", "height", "sizeBytes"] as const;
const BAD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function record(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value as Record<string, unknown>; }
function whitelist(value: Record<string, unknown>, keys: readonly string[], label: string): void { if (Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some((key) => !keys.includes(key) || BAD_KEYS.has(key))) throw new Error(`${label} contains unsupported fields`); }
function integer(value: unknown, min: number, max: number, label: string): void { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} is out of range`); }
function safePath(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value) || /^(?:blob:|data:)/iu.test(value)) throw new Error(`${label} is unsafe`); return value; }
function optionalPath(value: unknown, label: string): string | undefined { return value === undefined ? undefined : safePath(value, label); }
function validateSource(value: unknown): WorkspaceSource { const item = record(value, "source"); whitelist(item, SOURCE_KEYS, "source"); safePath(item.path, "source path"); if (typeof item.fileName !== "string" || !item.fileName.trim()) throw new Error("source fileName is invalid"); for (const key of ["width", "height", "sizeBytes"] as const) if (item[key] !== undefined) integer(item[key], 0, Number.MAX_SAFE_INTEGER, `source ${key}`); return item as unknown as WorkspaceSource; }
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
    } catch (error) { issues.push({ workspaceIndex, kind: "unrecoverable-field", field: "workspace", message: error instanceof Error ? error.message : String(error) }); }
  });
  return { workspaces, issues };
}

// Compatibility helpers keep lightweight page integrations on the same strict snapshot contract.
export function exportWorkspace(bundle: { kind: "image" | "gif"; parameters: Record<string, unknown>; sourcePaths: string[]; outputLocation?: string; outputDirectory?: string; outputSubdirectory?: string; namingTemplate?: string }): string {
  const parameters = bundle.kind === "image" ? {
    defaultOutputFormat: bundle.parameters.outputFormat ?? "bmp", defaultJpegQuality: bundle.parameters.jpegQuality ?? 85, defaultBitDepth: bundle.parameters.bitDepth ?? 24,
    defaultByteOrder: bundle.parameters.byteOrder ?? "little", defaultChannelOrder: bundle.parameters.channelOrder ?? "rgb", defaultRowOrder: bundle.parameters.rowOrder ?? "top-down", defaultRowAlignment: bundle.parameters.rowAlignment ?? 1,
    defaultCArrayName: bundle.parameters.cArrayName ?? "image_data", defaultBackgroundColor: bundle.parameters.backgroundColor ?? "#FFFFFF", keepAspectRatio: bundle.parameters.keepAspectRatio ?? true,
  } : bundle.parameters as unknown as GifMakerPreferences;
  const snapshot = bundle.kind === "image"
    ? { type: "image" as const, parameters, outputLocation: (bundle.outputLocation ?? "source") as OutputLocation, outputDirectory: bundle.outputDirectory, outputSubdirectory: bundle.outputSubdirectory, namingTemplate: bundle.namingTemplate, sources: bundle.sourcePaths.map((path) => ({ path, fileName: path.split(/[\\/]/u).pop() ?? path })) }
    : { type: "gif" as const, parameters, outputLocation: bundle.outputLocation ?? "path", outputDirectory: bundle.outputDirectory, outputSubdirectory: bundle.outputSubdirectory, namingTemplate: bundle.namingTemplate, sources: bundle.sourcePaths.map((path) => ({ path, fileName: path.split(/[\\/]/u).pop() ?? path })), frames: [] };
  return exportWorkspaceSnapshot([snapshot as WorkspaceSnapshot]);
}

export function importWorkspace(serialized: string, kind: "image" | "gif"): { parameters: Record<string, unknown>; sourcePaths: string[]; outputLocation: string; outputDirectory?: string; outputSubdirectory?: string; namingTemplate?: string } {
  const result = importWorkspaceSnapshot(serialized);
  const workspace = result.workspaces.find((item) => item.type === kind);
  if (!workspace) throw new Error("工作区文件类型不匹配。");
  return { parameters: workspace.parameters as unknown as Record<string, unknown>, sourcePaths: workspace.sources.map((source) => source.path), outputLocation: workspace.outputLocation, outputDirectory: workspace.outputDirectory, outputSubdirectory: workspace.outputSubdirectory, namingTemplate: workspace.namingTemplate };
}
