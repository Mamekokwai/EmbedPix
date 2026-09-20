import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const gifCss = readFileSync(new URL("./features/gif-maker.css", import.meta.url), "utf8");
const converterCss = readFileSync(new URL("./features/image-converter.css", import.meta.url), "utf8");
const gifView = readFileSync(new URL("../features/gif-maker/GifMakerView.tsx", import.meta.url), "utf8");
const converterView = readFileSync(new URL("../features/image-converter/ImageConverter.tsx", import.meta.url), "utf8");

const VIEWPORT_MATRIX = [
  { name: "compact portrait", width: 320, height: 480 },
  { name: "small portrait", width: 360, height: 500 },
  { name: "tablet portrait", width: 480, height: 640 },
  { name: "regular desktop", width: 1280, height: 800 },
] as const;

describe("compact layout viewport contract", () => {
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

  it("does not reintroduce a horizontal scrolling frame list", () => {
    expect(gifCss).not.toMatch(/\.gif-frame-list \{[^}]*overflow-x: auto;/s);
    expect(gifCss).toMatch(/\.gif-frame-list \{[^}]*overflow-x: hidden; overflow-y: auto;/s);
  });
});
