import type { OutputFormat, OutputLocation } from "./types";

export type BatchNameToken = "name" | "ext" | "width" | "height" | "index";

/** 关掉「重命名」时用的模板：输出名就是源图片的文件名，只把扩展名换成输出格式。 */
export const DEFAULT_FILE_NAME_TEMPLATE = "{name}.{ext}";

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

export function formatBatchConversionPlanError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const mappings: ReadonlyArray<[string, string]> = [
    ["template contains empty or control characters", "模板包含空内容或控制字符"],
    ["outputSubdirectory contains empty or control characters", "子文件夹为空或包含控制字符"],
    ["contains empty or control characters", "包含空内容或控制字符"],
    ["outputSubdirectory cannot contain traversal", "子文件夹不能出现 . 或 .. 路径段"],
    ["outputSubdirectory cannot end with a dot or space", "子文件夹每一段不能以点或空格结尾"],
    ["generated file name cannot contain traversal", "生成的文件名不能出现 .. 路径段"],
    ["generated file name cannot contain path separators", "生成的文件名不能包含路径分隔符"],
    ["cannot contain path separators or traversal", "不能包含路径分隔符或目录穿越"],
    ["cannot contain path separators", "不能包含路径分隔符"],
    ["generated file name uses a reserved device name", "生成的文件名使用了系统保留设备名"],
    ["outputSubdirectory uses a reserved device name", "子文件夹使用了系统保留设备名"],
    ["uses a reserved device name", "使用了系统保留设备名"],
    ["generated file name contains characters Windows does not allow", "生成的文件名包含 Windows 不允许的字符"],
    ["outputSubdirectory contains characters Windows does not allow", "子文件夹包含 Windows 不允许的字符"],
    ["contains characters Windows does not allow", "包含 Windows 不允许的字符"],
    ["generated file name cannot end with a dot or space", "生成的文件名不能以点或空格结尾"],
    ["cannot end with a dot or space", "不能以点或空格结尾"],
    ["generated file name is too long", "生成的文件名过长"],
    ["unsupported template token", "模板包含不支持的占位符"],
    ["outputDirectory is required", "指定目录输出需要填写输出目录"],
    ["duplicate target path", "目标路径重复"],
    ["has invalid dimensions", "尺寸无效"],
  ];
  for (const [prefix, label] of mappings) {
    const index = message.indexOf(prefix);
    if (index >= 0) return `${message.slice(0, index)}${label}${message.slice(index + prefix.length)}`;
  }
  return message || "批量转换规划失败，请检查参数后重试。";
}

const TOKEN_PATTERN = /\{(name|ext|width|height|index)\}/gu;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const RESERVED_DEVICE_PATTERN = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const WINDOWS_INVALID_PATTERN = /[<>:"|?*]/u;
const MAX_FILE_NAME_LENGTH = 255;

function extension(format: OutputFormat): string {
  if (format === "rgb565") return "bin";
  if (format === "c-array") return "h";
  return format;
}

function separator(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** 输出名一律换成输出格式的扩展名（与 Rust 侧 set_extension 行为一致），否则示例目标和真实文件名会对不上。 */
function withExpectedExtension(fileName: string, format: OutputFormat): string {
  const suffix = extension(format);
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${stem}.${suffix}`;
}

function assertNameSegment(segment: string, label: string): void {
  if (WINDOWS_INVALID_PATTERN.test(segment)) throw new Error(`${label} contains characters Windows does not allow: ${segment}`);
  if (segment.endsWith(".") || segment.endsWith(" ")) throw new Error(`${label} cannot end with a dot or space: ${segment}`);
  if (RESERVED_DEVICE_PATTERN.test(segment)) throw new Error(`${label} uses a reserved device name: ${segment}`);
}

function validateGeneratedName(fileName: string): string {
  if (!fileName || CONTROL_PATTERN.test(fileName)) throw new Error("generated file name contains empty or control characters");
  if (/[\\/]/u.test(fileName)) throw new Error("generated file name cannot contain path separators");
  if (fileName.includes("..")) throw new Error("generated file name cannot contain traversal");
  assertNameSegment(fileName, "generated file name");
  if (fileName.length > MAX_FILE_NAME_LENGTH) throw new Error(`generated file name is too long: ${fileName}`);
  return fileName;
}

/**
 * 子文件夹是相对源文件夹的路径（`out/A` 之类）：分隔符与首尾斜杠等价，逐段按 Windows 规则校验。
 * 返回归一化后的相对路径（用 `/`），与 Rust 侧 normalize_subdirectory 保持一致。
 */
function validateSubdirectory(value: string): string {
  const path = value.trim();
  if (!path || CONTROL_PATTERN.test(path)) throw new Error("outputSubdirectory contains empty or control characters");
  const segments = path.split(/[\\/]+/u).filter((segment) => segment.length > 0);
  if (!segments.length) throw new Error("outputSubdirectory contains empty or control characters");
  for (const segment of segments) {
    if (segment === "." || segment === "..") throw new Error(`outputSubdirectory cannot contain traversal: ${value}`);
    assertNameSegment(segment, "outputSubdirectory");
  }
  return segments.join("/");
}

function sourceStem(name: string): string {
  const fileName = name.split(/[\\/]/u).pop() ?? name;
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function joinPath(directory: string, child: string): string {
  const trimmed = directory.trim().replace(/[\\/]+$/u, "");
  if (!trimmed) return child;
  const target = separator(directory);
  // 子文件夹可以是相对路径（out/A）；按父目录的分隔符统一，免得出现 C:\pics\out/A\board.bmp。
  const normalizedChild = target === "\\" ? child.replace(/[\\/]+/gu, "\\") : child;
  return `${trimmed}${target}${normalizedChild}`;
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
  const fileName = withExpectedExtension(validateGeneratedName(rendered), format);
  if (fileName.length > MAX_FILE_NAME_LENGTH) throw new Error(`generated file name is too long: ${fileName}`);
  return fileName;
}

export function planBatchConversions(items: ReadonlyArray<BatchConversionItem>, options: BatchConversionPlanOptions): BatchConversionPlan {
  if (!items.length) return { items: [], targetPaths: [], duplicateTargets: [] };
  if (options.outputLocation === "directory" && !options.outputDirectory?.trim()) throw new Error("outputDirectory is required for directory output");
  const subdirectory = options.outputLocation === "subfolder" ? validateSubdirectory(options.outputSubdirectory ?? "") : null;
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
      : subdirectory !== null
        ? joinPath(sourceDir, subdirectory)
        : sourceDir;
    let target = joinPath(targetDirectory, fileName);
    const key = target.replace(/[\\/]+/gu, "/").toLocaleLowerCase();
    const count = used.get(key) ?? 0;
    if (count > 0) {
      if (!options.autoSequence) throw new Error(`duplicate target path: ${target}`);
      const dot = fileName.lastIndexOf(".");
      const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
      const suffix = dot > 0 ? fileName.slice(dot) : "";
      fileName = validateGeneratedName(`${stem}_${count + 1}${suffix}`);
      target = joinPath(targetDirectory, fileName);
    }
    used.set(target.replace(/[\\/]+/gu, "/").toLocaleLowerCase(), count + 1);
    planned.push({ ...item, index, targetPath: target });
  }
  const targetPaths = planned.map((item) => item.targetPath);
  return { items: planned, targetPaths, duplicateTargets: targetPaths.filter((path, index) => targetPaths.findIndex((other) => other.toLocaleLowerCase() === path.toLocaleLowerCase()) !== index) };
}
