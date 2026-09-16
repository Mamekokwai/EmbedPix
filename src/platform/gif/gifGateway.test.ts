import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { estimateAnimationSize, estimateGifSize, exportApng, exportGif, exportPngSequence, exportWebpAnimation, pickAnimationOutput, pickGifOutput, pickGifSequenceOutput, revealGifOutput } from "./gifGateway";
import type { GifExportRequest } from "./gifGateway";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

function request(): GifExportRequest {
  return {
    outputPath: "E:\\导出\\动画.gif", width: 3, height: 2,
    loopMode: "finite", loopCount: 2,
    frames: [
      { data: new Uint8Array([0, 127, 128, 255]), durationMs: 19 },
      { data: new Uint8Array([255, 1]), durationMs: 25 },
    ],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("GIF desktop gateway", () => {
  it("preserves the camelCase contract, frame order, byte values and input buffers", async () => {
    const input = request();
    vi.mocked(invoke).mockResolvedValueOnce(input.outputPath);
    await expect(exportGif(input)).resolves.toBe(input.outputPath);
    expect(invoke).toHaveBeenCalledWith("export_gif", {
      request: { ...input, overwriteExisting: false, encodingSpeed: 1, colorCount: 256, ditherMode: "none", frames: [
        { data: [0, 127, 128, 255], durationMs: 19 },
        { data: [255, 1], durationMs: 25 },
      ] },
    });
    expect(input.frames[0].data).toEqual(new Uint8Array([0, 127, 128, 255]));
    expect(input.frames[1].data).toBeInstanceOf(Uint8Array);
    expect(input).not.toHaveProperty("overwriteExisting");
  });

  it("serializes a GIF size estimate without an output path or overwrite flag", async () => {
    const input = request();
    vi.mocked(invoke).mockResolvedValueOnce({ bytes: 1234 });
    await expect(estimateGifSize(input)).resolves.toEqual({ bytes: 1234 });
    expect(invoke).toHaveBeenCalledWith("estimate_gif_size", {
      request: {
        width: input.width,
        height: input.height,
        loopMode: input.loopMode,
        loopCount: input.loopCount,
        encodingSpeed: 1,
        colorCount: 256,
        ditherMode: "none",
        frames: [
          { data: [0, 127, 128, 255], durationMs: 19 },
          { data: [255, 1], durationMs: 25 },
        ],
      },
    });
  });

  it.each(["webp", "apng"] as const)("serializes a %s animation size estimate without output metadata", async (format) => {
    const input = { ...request(), outputPath: "E:\\不应写入\\动画." + format, outputLocation: "directory" as const, outputDirectory: "E:\\不应写入" };
    vi.mocked(invoke).mockResolvedValueOnce({ bytes: 4321 });
    await expect(estimateAnimationSize(format, input)).resolves.toEqual({ bytes: 4321 });
    expect(invoke).toHaveBeenCalledWith("estimate_animation_size", {
      format,
      request: {
        width: input.width,
        height: input.height,
        loopMode: input.loopMode,
        loopCount: input.loopCount,
        frames: [
          { data: [0, 127, 128, 255], durationMs: 19 },
          { data: [255, 1], durationMs: 25 },
        ],
      },
    });
  });

  it("opens the PNG sequence directory picker without adding a file argument", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("E:\\导出");
    await expect(pickGifSequenceOutput()).resolves.toBe("E:\\导出");
    expect(invoke).toHaveBeenCalledWith("pick_gif_sequence_output");
  });

  it("reveals a completed export path through the desktop opener", async () => {
    vi.mocked(revealItemInDir).mockResolvedValueOnce(undefined);
    await expect(revealGifOutput("E:\\导出\\动画.gif")).resolves.toBeUndefined();
    expect(revealItemInDir).toHaveBeenCalledWith("E:\\导出\\动画.gif");
  });

  it("serializes PNG sequence frames and defaults to non-overwrite output", async () => {
    const input = {
      outputDir: "E:\\导出",
      baseName: "screen",
      frames: request().frames,
    };
    vi.mocked(invoke).mockResolvedValueOnce(["E:\\导出\\screen-001.png"]);
    await expect(exportPngSequence(input)).resolves.toEqual(["E:\\导出\\screen-001.png"]);
    expect(invoke).toHaveBeenCalledWith("export_png_sequence", {
      request: {
        outputDir: input.outputDir,
        baseName: input.baseName,
        overwriteExisting: false,
        frames: [
          { data: [0, 127, 128, 255], durationMs: 19 },
          { data: [255, 1], durationMs: 25 },
        ],
      },
    });
  });

  it("serializes unified PNG sequence output locations without deriving paths", async () => {
    const input = {
      outputLocation: "subfolder" as const,
      sourcePath: "E:\\源素材\\第一帧.png",
      outputSubdirectory: "导出",
      baseName: "screen",
      frames: request().frames,
    };
    vi.mocked(invoke).mockResolvedValueOnce(["E:\\源素材\\导出\\screen-001.png"]);
    await expect(exportPngSequence(input)).resolves.toEqual(["E:\\源素材\\导出\\screen-001.png"]);
    expect(invoke).toHaveBeenCalledWith("export_png_sequence", {
      request: {
        outputLocation: "subfolder",
        sourcePath: "E:\\源素材\\第一帧.png",
        outputSubdirectory: "导出",
        baseName: "screen",
        overwriteExisting: false,
        frames: [
          { data: [0, 127, 128, 255], durationMs: 19 },
          { data: [255, 1], durationMs: 25 },
        ],
      },
    });
  });

  it("passes explicit PNG sequence overwrite preference", async () => {
    const input = { outputDir: "E:\\导出", baseName: "screen", frames: request().frames, overwriteExisting: true };
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await expect(exportPngSequence(input)).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith("export_png_sequence", { request: expect.objectContaining({ overwriteExisting: true }) });
  });

  it.each([false, true])("passes explicit overwriteExisting=%s", async (overwriteExisting) => {
    const input = { ...request(), overwriteExisting, loopMode: "infinite" as const, loopCount: 0 };
    vi.mocked(invoke).mockResolvedValueOnce(input.outputPath);
    await exportGif(input);
    expect(invoke).toHaveBeenCalledWith("export_gif", { request: expect.objectContaining({
      overwriteExisting, loopMode: "infinite", loopCount: 0,
    }) });
  });

  it("passes secure source-folder output metadata without deriving an output path", async () => {
    const input = { ...request(), outputPath: undefined, outputLocation: "source" as const, sourcePath: "E:\\源素材\\第一帧.png" };
    vi.mocked(invoke).mockResolvedValueOnce("E:\\源素材\\动画.gif");
    await expect(exportGif(input)).resolves.toBe("E:\\源素材\\动画.gif");
    expect(invoke).toHaveBeenCalledWith("export_gif", { request: expect.objectContaining({
      outputLocation: "source",
      sourcePath: "E:\\源素材\\第一帧.png",
    }) });
    expect(vi.mocked(invoke).mock.calls[0]?.[1]).not.toHaveProperty("request.outputPath", undefined);
  });

  it.each([2, 16, 32] as const)("preserves %s color GIF settings", async (colorCount) => {
    const input = { ...request(), colorCount };
    vi.mocked(invoke).mockResolvedValueOnce(input.outputPath);

    await exportGif(input);

    expect(invoke).toHaveBeenCalledWith("export_gif", { request: expect.objectContaining({ colorCount }) });
  });

  it.each(["E:\\动画.gif", null])("returns the selected output or cancellation: %s", async (result) => {
    vi.mocked(invoke).mockResolvedValueOnce(result);
    await expect(pickGifOutput("动画.gif")).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledWith("pick_gif_output", { suggestedName: "动画.gif" });
  });

  it.each([["webp", "pick_animation_output"], ["apng", "pick_animation_output"]] as const)("passes %s animation picker requests", async (format, command) => {
    vi.mocked(invoke).mockResolvedValueOnce("E:\\动画." + format);
    await expect(pickAnimationOutput(format, "动画." + format)).resolves.toBe("E:\\动画." + format);
    expect(invoke).toHaveBeenCalledWith(command, { format, suggestedName: "动画." + format });
  });

  it.each([[exportWebpAnimation, "export_webp_animation"], [exportApng, "export_apng"]] as const)("serializes animation export requests", async (exportAnimation, command) => {
    const input = { outputPath: "E:\\动画", width: 3, height: 2, loopMode: "infinite" as const, loopCount: 0, frames: request().frames };
    vi.mocked(invoke).mockResolvedValueOnce(input.outputPath);
    await expect(exportAnimation(input)).resolves.toBe(input.outputPath);
    expect(invoke).toHaveBeenCalledWith(command, { request: {
      ...input, overwriteExisting: false, frames: [
        { data: [0, 127, 128, 255], durationMs: 19 },
        { data: [255, 1], durationMs: 25 },
      ],
    } });
  });

  it.each([undefined, {}])("rejects browser-only environments without invoking Rust", async (browser) => {
    vi.stubGlobal("window", browser);
    await expect(exportGif(request())).rejects.toThrow("桌面应用");
    await expect(pickGifOutput("test.gif")).rejects.toThrow("桌面应用");
    await expect(revealGifOutput("E:\\动画.gif")).rejects.toThrow("桌面应用");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects empty paths before invoking the opener", async () => {
    await expect(revealGifOutput("  ")).rejects.toThrow("导出路径为空");
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it.each(["旧文件受保护", new Error("旧文件受保护"), { unknown: true }])("normalizes backend errors: %s", async (error) => {
    const expected = typeof error === "string" || error instanceof Error ? "旧文件受保护" : "GIF 导出失败";
    vi.mocked(invoke).mockRejectedValueOnce(error);
    await expect(exportGif(request())).rejects.toThrow(expected);
    vi.mocked(invoke).mockRejectedValueOnce(error);
    await expect(pickGifOutput("test.gif")).rejects.toThrow(expected);
  });
});
