import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(url: URL): string {
  return readFileSync(url, "utf8").replace(/\r\n?/g, "\n");
}

const gifCss = readSource(new URL("./features/gif-maker.css", import.meta.url));
const converterCss = readSource(new URL("./features/image-converter.css", import.meta.url));
const gifView = readSource(new URL("../features/gif-maker/GifMakerView.tsx", import.meta.url));
const converterView = readSource(new URL("../features/image-converter/ImageConverter.tsx", import.meta.url));

const VIEWPORT_MATRIX = [
  { name: "compact portrait", width: 320, height: 480 },
  { name: "small portrait", width: 360, height: 500 },
  { name: "tablet portrait", width: 480, height: 640 },
  { name: "narrow tall", width: 700, height: 1100 },
  { name: "wide short", width: 900, height: 700 },
  { name: "desktop short", width: 1280, height: 720 },
  { name: "landscape narrow", width: 560, height: 420 },
  { name: "regular desktop", width: 1280, height: 800 },
] as const;

describe("compact layout viewport contract", () => {
  it("normalizes both LF and CRLF source checkouts before matching contracts", () => {
    expect(".a\r\n.b\r.c\n".replace(/\r\n?/g, "\n")).toBe(".a\n.b\n.c\n");
  });

  it.each(VIEWPORT_MATRIX)("defines a deterministic contract for $name ($width×$height)", ({ width, height }) => {
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(gifCss).toContain("overflow-x: hidden");
    expect(gifCss).toMatch(/\.gif-frame-list \{[^}]*flex-direction: column;[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/s);
    expect(gifCss).toContain(".gif-canvas-stage { min-height: 132px;");
    expect(converterCss).toContain(".converter-app {\n  width: min(1180px, 100%);");
    expect(converterCss).toContain("overflow-x: hidden;");
    expect(converterCss).toContain(".preview-content { min-height: 210px; }");
  });

  it("keeps export and cancellation controls represented in both workspaces", () => {
    expect(gifView).toContain("gif-export-button");
    expect(gifView).toContain("cancelVideoExtraction");
    expect(gifView).toContain("getGifCancelButtonLabel");
    expect(converterView).toContain("export-button");
    expect(converterView).toContain("requestExportCancel");
  });

  it("keeps GIF interaction modules, multiselect, and batch duration controls represented", () => {
    expect(gifView).toContain("素材帧");
    expect(gifView).toContain("动画预览");
    expect(gifView).toContain("画布");
    expect(gifView).toContain("帧时长");
    expect(gifView).toContain("导出设置");
    expect(gifView).toContain("selectedFrameIndices");
    expect(gifView).toContain("批量设置选中帧时长");
  });

  it("does not reintroduce a horizontal scrolling frame list", () => {
    expect(gifCss).not.toMatch(/\.gif-frame-list \{[^}]*overflow-x: auto;/s);
    expect(gifCss).toMatch(/\.gif-frame-list \{[^}]*overflow-x: hidden; overflow-y: auto;/s);
  });

  it("keeps one target, limit, and compression control per output-format branch", () => {
    expect((gifView.match(/<span>目标文件大小<\/span>/g) ?? []).length).toBe(3);
    expect((gifView.match(/<span>最大文件大小<\/span>/g) ?? []).length).toBe(3);
    expect((gifView.match(/<strong>自动压缩到目标大小<\/strong>/g) ?? []).length).toBe(3);
    expect(gifCss).toContain(".gif-export-grid { grid-template-columns: minmax(0, 1fr); }");
    expect(gifView).toContain("WebP/APNG 动图使用当前画布和帧时长导出");
    expect(gifView).toContain("PNG 帧序列按当前画布逐帧输出 PNG");
    expect(gifView).toContain("仅调用原生规划，不会修改参数或自动压缩正式导出");
  });

  it("keeps focus styling and text wrapping explicit for narrow and short windows", () => {
    expect(gifCss).toContain(":focus-visible");
    expect(gifCss).toContain("overflow-wrap: anywhere");
    expect(gifCss).toContain("flex-wrap: wrap");
    expect(converterCss).toContain(":focus-visible");
    expect(converterCss).toContain("overflow-wrap: anywhere");
    expect(converterCss).toContain("overflow-x: hidden;");
  });

  it("keeps resource cleanup and failed-item retry paths explicit", () => {
    expect(converterView).toContain("URL.revokeObjectURL(realPreviewUrlRef.current)");
    expect(converterView).toContain("loadedImagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl))");
    expect(converterView).toContain("仅重试失败项");
    expect(converterView).toContain("暂停队列");
    expect(converterView).toContain("继续导出");
    expect(converterView).toContain("原子导出不会被中断");
    expect(gifView).toContain("framesRef.current.forEach((frame) => URL.revokeObjectURL(frame.previewUrl))");
    expect(gifView).toContain("videoImportRequestRef.current += 1");
    expect(gifView).toContain("正在取消导出");
  });

  it("keeps the 700px narrow workspace in normal vertical flow when settings expand", () => {
    expect(gifCss).toContain("@media (max-width: 760px) and (min-height: 621px)");
    expect(gifCss).toContain(".gif-workspace-grid { flex: 0 0 auto; grid-template-rows: 128px minmax(220px, auto); overflow: visible; }");
    expect(gifCss).toContain(".gif-main-column, .gif-preview-card { min-height: 220px; }");
  });
});
