import type { OutputFormat, OutputLocation } from "./types";

export type BatchNameToken = "name" | "ext" | "width" | "height" | "index";

export interface BatchConversionItem {
  name: string;
  width: number;
  height: number;
  sourcePath?: string | null;
}

export interface BatchConversionPlanOptions {
  template: string;
  outputFormat: OutputFormat;
  outputLocation: OutputLocation;
  outputDirectory?: string;
  outputSubdirectory?: string;
  autoSequence?: boolean;
}

export interface BatchConversionPlanItem extends BatchConversionItem {
  index: number;
  targetPath: string;
}

export interface BatchConversionPlan {
  items: BatchConversionPlanItem[];
  targetPaths: string[];
  duplicateTargets: string[];
}

const TOKEN_PATTERN = /\{(name|ext|width|height|index)\}/gu;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const RESERVED_DEVICE_PATTERN = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function extension(format: OutputFormat): string {
  if (format === "rgb565") return "bin";
  if (format === "c-array") return "h";
  return format;
}

function separator(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

function rejectUnsafe(value: string, label: string): void {
  if (!value || CONTROL_PATTERN.test(value)) throw new Error(`${label} contains empty or control characters`);
  if (/[\\/]/u.test(value) || value === "." || value === ".." || value.includes("..")) {
    throw new Error(`${label} cannot contain path separators or traversal`);
  }
}

function validateFileName(fileName: string): void {
  rejectUnsafe(fileName, "generated file name");
  if (RESERVED_DEVICE_PATTERN.test(fileName)) throw new Error(`generated file name uses a reserved device name: ${fileName}`);
}

function sourceStem(name: string): string {
  const fileName = name.split(/[\\/]/u).pop() ?? name;
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function joinPath(directory: string, child: string): string {
  const trimmed = directory.trim().replace(/[\\/]+$/u, "");
  if (!trimmed) return child;
  return `${trimmed}${separator(directory)}${child}`;
}

function sourceDirectory(path: string | null | undefined): string {
  const value = path?.trim() ?? "";
  const separatorIndex = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return separatorIndex >= 0 ? value.slice(0, separatorIndex) : "";
}

function renderTemplate(template: string, item: BatchConversionItem, index: number, format: OutputFormat): string {
  if (!template.trim() || CONTROL_PATTERN.test(template)) throw new Error("template contains empty or control characters");
  if (/[\\/]/u.test(template)) throw new Error("template cannot contain path separators");
  const rendered = template.replace(TOKEN_PATTERN, (_, token: BatchNameToken) => {
    if (token === "name") return sourceStem(item.name);
    if (token === "ext") return extension(format);
    if (token === "width") return String(item.width);
    if (token === "height") return String(item.height);
    return String(index);
  });
  if (rendered.includes("{")) throw new Error(`unsupported template token in ${template}`);
  validateFileName(rendered);
  return rendered;
}

export function planBatchConversions(items: ReadonlyArray<BatchConversionItem>, options: BatchConversionPlanOptions): BatchConversionPlan {
  if (!items.length) return { items: [], targetPaths: [], duplicateTargets: [] };
  if (options.outputLocation === "directory" && !options.outputDirectory?.trim()) throw new Error("outputDirectory is required for directory output");
  if (options.outputLocation === "subfolder") rejectUnsafe(options.outputSubdirectory?.trim() ?? "", "outputSubdirectory");
  const used = new Map<string, number>();
  const planned: BatchConversionPlanItem[] = [];
  for (const [position, item] of items.entries()) {
    if (!Number.isSafeInteger(item.width) || item.width < 1 || !Number.isSafeInteger(item.height) || item.height < 1) throw new Error(`item ${position + 1} has invalid dimensions`);
    const index = position + 1;
    const baseName = renderTemplate(options.template, item, index, options.outputFormat);
    let fileName = baseName;
    const sourceDir = sourceDirectory(item.sourcePath);
    const targetDirectory = options.outputLocation === "directory"
      ? options.outputDirectory!.trim()
      : options.outputLocation === "subfolder"
        ? joinPath(sourceDir, options.outputSubdirectory!.trim())
        : sourceDir;
    let target = joinPath(targetDirectory, fileName);
    const key = target.replace(/[\\/]+/gu, "/").toLocaleLowerCase();
    const count = used.get(key) ?? 0;
    if (count > 0) {
      if (!options.autoSequence) throw new Error(`duplicate target path: ${target}`);
      const dot = fileName.lastIndexOf(".");
      const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
      const suffix = dot > 0 ? fileName.slice(dot) : "";
      fileName = `${stem}_${count + 1}${suffix}`;
      validateFileName(fileName);
      target = joinPath(targetDirectory, fileName);
    }
    used.set(target.replace(/[\\/]+/gu, "/").toLocaleLowerCase(), count + 1);
    planned.push({ ...item, index, targetPath: target });
  }
  const targetPaths = planned.map((item) => item.targetPath);
  return { items: planned, targetPaths, duplicateTargets: targetPaths.filter((path, index) => targetPaths.findIndex((other) => other.toLocaleLowerCase() === path.toLocaleLowerCase()) !== index) };
}
