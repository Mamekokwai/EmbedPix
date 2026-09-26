import { describe, expect, it } from "vitest";
import { planBatchConversions } from "./batchConversionPlan";

const items = [
  { name: "board.png", width: 320, height: 240 },
  { name: "sensor.jpg", width: 640, height: 480 },
];

describe("batch conversion plan", () => {
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
