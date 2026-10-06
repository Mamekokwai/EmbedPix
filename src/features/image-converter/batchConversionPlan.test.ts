import { describe, expect, it } from "vitest";
import { DEFAULT_FILE_NAME_TEMPLATE, formatBatchConversionPlanError, planBatchConversions } from "./batchConversionPlan";
import type { OutputFormat } from "./types";

const items = [
  { name: "board.png", width: 320, height: 240 },
  { name: "sensor.jpg", width: 640, height: 480 },
];

const directoryOptions = { outputFormat: "bmp" as const, outputLocation: "directory" as const, outputDirectory: "E:\\out" };

const planTarget = (template: string, name = "board.png") =>
  planBatchConversions([{ name, width: 1, height: 1 }], { ...directoryOptions, template }).targetPaths[0];

describe("batch conversion plan", () => {
  it("formats stable planning errors and preserves unknown details", () => {
    expect(formatBatchConversionPlanError(new Error("template contains empty or control characters"))).toBe("模板包含空内容或控制字符");
    expect(formatBatchConversionPlanError("generated file name uses a reserved device name: CON.png")).toBe("生成的文件名使用了系统保留设备名: CON.png");
    expect(formatBatchConversionPlanError("duplicate target path: E:\\out\\a.png")).toBe("目标路径重复: E:\\out\\a.png");
    expect(formatBatchConversionPlanError("future planning error")).toBe("future planning error");
  });

  it("formats the rename robustness errors too", () => {
    expect(formatBatchConversionPlanError(new Error("generated file name contains characters Windows does not allow: a?.bmp"))).toBe("生成的文件名包含 Windows 不允许的字符: a?.bmp");
    expect(formatBatchConversionPlanError(new Error("generated file name cannot end with a dot or space: a."))).toBe("生成的文件名不能以点或空格结尾: a.");
    expect(formatBatchConversionPlanError(new Error("generated file name is too long: aaa"))).toBe("生成的文件名过长: aaa");
    expect(formatBatchConversionPlanError(new Error("outputSubdirectory cannot contain traversal: out/../x"))).toBe("子文件夹不能出现 . 或 .. 路径段: out/../x");
    expect(formatBatchConversionPlanError(new Error("outputSubdirectory uses a reserved device name: out/CON"))).toBe("子文件夹使用了系统保留设备名: out/CON");
  });

  it("renders safe name, format, dimensions and index tokens", () => {
    const plan = planBatchConversions(items, { template: "{index}_{name}_{width}x{height}.{ext}", outputFormat: "rgb565", outputLocation: "directory", outputDirectory: "E:\\out" });
    expect(plan.targetPaths).toEqual(["E:\\out\\1_board_320x240.bin", "E:\\out\\2_sensor_640x480.bin"]);
  });

  it("rejects traversal, separators, controls and reserved names", () => {
    expect(() => planBatchConversions(items, { template: "../{name}.png", outputFormat: "png", outputLocation: "directory", outputDirectory: "E:\\out" })).toThrow("separators");
    expect(() => planBatchConversions(items, { template: "CON.png", outputFormat: "png", outputLocation: "directory", outputDirectory: "E:\\out" })).toThrow("reserved");
    expect(() => planBatchConversions(items, { template: "{name}\u0000.png", outputFormat: "png", outputLocation: "directory", outputDirectory: "E:\\out" })).toThrow("control");
  });

  it("detects duplicate targets and can sequence them safely", () => {
    const options = { template: "same.png", outputFormat: "png" as const, outputLocation: "directory" as const, outputDirectory: "E:\\out" };
    expect(() => planBatchConversions(items, options)).toThrow("duplicate");
    const plan = planBatchConversions(items, { ...options, autoSequence: true });
    expect(plan.targetPaths).toEqual(["E:\\out\\same.png", "E:\\out\\same_2.png"]);
  });

  it("requires the directory boundary and validates dimensions", () => {
    expect(() => planBatchConversions(items, { template: "{name}.png", outputFormat: "png", outputLocation: "directory" })).toThrow("outputDirectory");
    expect(() => planBatchConversions([{ ...items[0], width: 0 }], { template: "{name}.png", outputFormat: "png", outputLocation: "directory", outputDirectory: "E:\\out" })).toThrow("dimensions");
  });
});

describe("rename robustness", () => {
  it("keeps the default template as the source name plus the output extension", () => {
    expect(DEFAULT_FILE_NAME_TEMPLATE).toBe("{name}.{ext}");
    expect(planBatchConversions(items, { ...directoryOptions, template: DEFAULT_FILE_NAME_TEMPLATE }).targetPaths).toEqual(["E:\\out\\board.bmp", "E:\\out\\sensor.bmp"]);
  });

  it("derives the stem from awkward source names", () => {
    const paths = ["archive.tar.png", "noext", ".hidden", "C:\\pics\\中文 图.png", "weird."].map((name) => planTarget("{name}.{ext}", name));
    expect(paths).toEqual([
      "E:\\out\\archive.tar.bmp",
      "E:\\out\\noext.bmp",
      "E:\\out\\.hidden.bmp",
      "E:\\out\\中文 图.bmp",
      "E:\\out\\weird.bmp",
    ]);
  });

  it("forces the output extension the same way the native side does", () => {
    expect(planTarget("{name}")).toBe("E:\\out\\board.bmp");
    expect(planTarget("{name}.png")).toBe("E:\\out\\board.bmp");
    expect(planTarget("{name}.tar.gz")).toBe("E:\\out\\board.tar.bmp");
    expect(planTarget("{ext}_{name}")).toBe("E:\\out\\bmp_board.bmp");
    expect(planTarget("fixed-name")).toBe("E:\\out\\fixed-name.bmp");
  });

  it("maps every output format to its extension", () => {
    const formats: ReadonlyArray<OutputFormat> = ["bmp", "png", "jpg", "webp", "tiff", "ico", "rgb565", "c-array"];
    const paths = formats.map((outputFormat) => planBatchConversions([{ name: "a.png", width: 1, height: 1 }], { ...directoryOptions, outputFormat, template: "{name}.{ext}" }).targetPaths[0]);
    expect(paths).toEqual(["E:\\out\\a.bmp", "E:\\out\\a.png", "E:\\out\\a.jpg", "E:\\out\\a.webp", "E:\\out\\a.tiff", "E:\\out\\a.ico", "E:\\out\\a.bin", "E:\\out\\a.h"]);
  });

  it("rejects empty, whitespace and control characters in the template", () => {
    for (const template of ["", "   ", "{name}\n", "{name}\t", "\u0000{name}.{ext}", "{name}\u007f.{ext}"]) {
      expect(() => planTarget(template)).toThrow(/empty or control/);
    }
  });

  it("rejects path separators and traversal in the template", () => {
    for (const template of ["../{name}", "..\\{name}", "out/{name}", "out\\{name}", "{name}.."]) {
      expect(() => planTarget(template)).toThrow(/separators|traversal/);
    }
  });

  it("rejects unsupported placeholder tokens", () => {
    for (const template of ["{foo}", "{}", "{NAME}", "{ name }", "{{name}}", "{name}{", "{{}", "{index"]) {
      expect(() => planTarget(template)).toThrow(/unsupported template token/);
    }
  });

  it("rejects characters Windows forbids, trailing dots and spaces", () => {
    for (const template of ["{name}?.{ext}", "{name}*.{ext}", "{name}:{ext}", "{name}\u0022.{ext}", "{name}<{ext}", "{name}|{ext}"]) {
      expect(() => planTarget(template)).toThrow(/Windows/);
    }
    expect(() => planTarget("{name}.{ext}.")).toThrow(/dot or space/);
    expect(() => planTarget("{name}.{ext} ")).toThrow(/dot or space/);
    // 非法字符也可能来自源文件名，不只是模板
    expect(() => planTarget("{name}.{ext}", "a?b.png")).toThrow(/Windows/);
  });

  it("rejects reserved device names from both the template and the source name", () => {
    expect(() => planTarget("CON.{ext}")).toThrow(/reserved/);
    expect(() => planTarget("{name}.{ext}", "con.png")).toThrow(/reserved/);
    expect(() => planTarget("{name}.{ext}", "lpt9.png")).toThrow(/reserved/);
    expect(() => planTarget("{name}.{ext}", "nul")).toThrow(/reserved/);
    expect(planTarget("{name}.{ext}", "console.png")).toBe("E:\\out\\console.bmp");
  });

  it("rejects generated names longer than the filesystem allows", () => {
    expect(() => planTarget("{name}.{ext}", `${"a".repeat(300)}.png`)).toThrow(/too long/);
    expect(planTarget("{name}.{ext}", `${"a".repeat(250)}.png`)).toBe(`E:\\out\\${"a".repeat(250)}.bmp`);
  });

  it("keeps duplicate detection case-insensitive and aligned with the forced extension", () => {
    const names = ["Board.png", "board.png"];
    expect(() => planBatchConversions(names.map((name) => ({ name, width: 1, height: 1 })), { ...directoryOptions, template: "{name}.{ext}" })).toThrow("duplicate");
    // 模板不带扩展名、强制补上之后就撞在一起的情况也要报出来
    expect(() => planBatchConversions([{ name: "board.png", width: 1, height: 1 }, { name: "board.bmp", width: 1, height: 1 }], { ...directoryOptions, template: "{name}" })).toThrow("duplicate");
  });

  it("accepts nested relative subdirectories and still rejects traversal", () => {
    const subfolderOptions = { template: "{name}.{ext}", outputFormat: "bmp" as const, outputLocation: "subfolder" as const };
    const item = { name: "board.png", width: 1, height: 1, sourcePath: "C:\\pics\\board.png" };
    const nested = (outputSubdirectory: string) => planBatchConversions([item], { ...subfolderOptions, outputSubdirectory }).targetPaths[0];

    expect(nested("out/A")).toBe("C:\\pics\\out\\A\\board.bmp");
    expect(nested("out/A/")).toBe("C:\\pics\\out\\A\\board.bmp");
    expect(nested("out\\A")).toBe("C:\\pics\\out\\A\\board.bmp");
    expect(nested("out//A//")).toBe("C:\\pics\\out\\A\\board.bmp");

    for (const bad of ["", "   "]) expect(() => nested(bad)).toThrow(/outputSubdirectory/);
    for (const bad of ["..", "out/../x", "C:\\abs", "out/CON", "out/A.", "out/A /x"]) expect(() => nested(bad)).toThrow(/outputSubdirectory/);
    // 整个值首尾的空格会被 trim 掉（与 Rust 侧一致），不算非法
    expect(nested("out/A ")).toBe("C:\\pics\\out\\A\\board.bmp");
  });

  it("numbers a long batch without producing colliding targets", () => {
    const many = Array.from({ length: 12 }, (_, position) => ({ name: `img${position + 1}.png`, width: 800 + position, height: 600 + position }));
    const plan = planBatchConversions(many, { ...directoryOptions, template: "{index}-{name}-{width}x{height}.{ext}" });

    expect(plan.targetPaths).toHaveLength(12);
    expect(new Set(plan.targetPaths.map((path) => path.toLocaleLowerCase())).size).toBe(12);
    expect(plan.targetPaths[0]).toBe("E:\\out\\1-img1-800x600.bmp");
    expect(plan.targetPaths[11]).toBe("E:\\out\\12-img12-811x611.bmp");
    expect(plan.duplicateTargets).toEqual([]);
  });

  it("returns an empty plan for an empty batch", () => {
    expect(planBatchConversions([], { ...directoryOptions, template: "{name}.{ext}" })).toEqual({ items: [], targetPaths: [], duplicateTargets: [] });
  });

  it("rejects invalid dimensions before rendering names", () => {
    for (const width of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => planBatchConversions([{ name: "a.png", width, height: 10 }], { ...directoryOptions, template: "{name}.{ext}" })).toThrow(/dimensions/);
    }
  });
});
