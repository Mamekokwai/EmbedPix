import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { exportGif, pickGifOutput } from "./gifGateway";
import type { GifExportRequest } from "./gifGateway";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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
      request: { ...input, overwriteExisting: false, frames: [
        { data: [0, 127, 128, 255], durationMs: 19 },
        { data: [255, 1], durationMs: 25 },
      ] },
    });
    expect(input.frames[0].data).toEqual(new Uint8Array([0, 127, 128, 255]));
    expect(input.frames[1].data).toBeInstanceOf(Uint8Array);
    expect(input).not.toHaveProperty("overwriteExisting");
  });

  it.each([false, true])("passes explicit overwriteExisting=%s", async (overwriteExisting) => {
    const input = { ...request(), overwriteExisting, loopMode: "infinite" as const, loopCount: 0 };
    vi.mocked(invoke).mockResolvedValueOnce(input.outputPath);
    await exportGif(input);
    expect(invoke).toHaveBeenCalledWith("export_gif", { request: expect.objectContaining({
      overwriteExisting, loopMode: "infinite", loopCount: 0,
    }) });
  });

  it.each(["E:\\动画.gif", null])("returns the selected output or cancellation: %s", async (result) => {
    vi.mocked(invoke).mockResolvedValueOnce(result);
    await expect(pickGifOutput("动画.gif")).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledWith("pick_gif_output", { suggestedName: "动画.gif" });
  });

  it.each([undefined, {}])("rejects browser-only environments without invoking Rust", async (browser) => {
    vi.stubGlobal("window", browser);
    await expect(exportGif(request())).rejects.toThrow("桌面应用");
    await expect(pickGifOutput("test.gif")).rejects.toThrow("桌面应用");
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["旧文件受保护", new Error("旧文件受保护"), { unknown: true }])("normalizes backend errors: %s", async (error) => {
    const expected = typeof error === "string" || error instanceof Error ? "旧文件受保护" : "GIF 导出失败";
    vi.mocked(invoke).mockRejectedValueOnce(error);
    await expect(exportGif(request())).rejects.toThrow(expected);
    vi.mocked(invoke).mockRejectedValueOnce(error);
    await expect(pickGifOutput("test.gif")).rejects.toThrow(expected);
  });
});
