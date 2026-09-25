import { describe, expect, it, vi } from "vitest";
import { formatExportFailureDetails, formatExportQueueProgress, formatExportQueueSummary, runExportQueue } from "./imageExportQueue";

describe("image export queue", () => {
  it("continues after a failed item and records retryable failures", async () => {
    const exportItem = vi.fn(async (item: { file: { name: string } }) => {
      if (item.file.name === "bad.png") throw new Error("编码失败");
    });
    const items = ["ok.png", "bad.png", "last.png"].map((name) => ({ file: { name } }));
    const result = await runExportQueue(items, exportItem);

    expect(exportItem).toHaveBeenCalledTimes(3);
    expect(result.succeeded.map((item) => item.file.name)).toEqual(["ok.png", "last.png"]);
    expect(result.failed.map(({ item }) => item.file.name)).toEqual(["bad.png"]);
    expect(result.skipped).toEqual([]);
    expect(formatExportQueueProgress({ item: items[0], index: 1, total: 3, succeeded: 0, failed: 0, skipped: 0 })).toContain("正在导出 1/3");
  });

  it("retries only failed items without exporting successful items again", async () => {
    const attempts = new Map<string, number>();
    const exportItem = vi.fn(async (item: { file: { name: string } }) => {
      const attempt = (attempts.get(item.file.name) ?? 0) + 1;
      attempts.set(item.file.name, attempt);
      if (item.file.name === "bad.png" && attempt === 1) throw new Error("编码失败");
    });
    const items = ["ok.png", "bad.png", "last.png"].map((name) => ({ file: { name } }));

    const firstRun = await runExportQueue(items, exportItem);
    const retryRun = await runExportQueue(firstRun.failed.map(({ item }) => item), exportItem);

    expect(retryRun.failed).toEqual([]);
    expect(retryRun.succeeded.map((item) => item.file.name)).toEqual(["bad.png"]);
    expect(exportItem.mock.calls.map(([item]) => item.file.name)).toEqual([
      "ok.png", "bad.png", "last.png", "bad.png",
    ]);
    expect(formatExportFailureDetails(firstRun.failed.map(({ item, error }) => ({
      fileName: item.file.name,
      message: error instanceof Error ? error.message : "导出失败，请重试。",
    })))).toBe("bad.png：编码失败");
  });

  it("stops before the next item when cancellation is requested", async () => {
    let cancel = false;
    const exportItem = vi.fn(async (item: { file: { name: string } }) => {
      if (item.file.name === "first.png") cancel = true;
    });
    const items = ["first.png", "second.png", "third.png"].map((name) => ({ file: { name } }));
    const result = await runExportQueue(items, exportItem, { shouldCancel: () => cancel });

    expect(exportItem).toHaveBeenCalledTimes(1);
    expect(result.succeeded.map((item) => item.file.name)).toEqual(["first.png"]);
    expect(result.skipped.map((item) => item.file.name)).toEqual(["second.png", "third.png"]);
    expect(result.cancelled).toBe(true);
    expect(formatExportQueueSummary(result)).toBe("已取消：成功 1，失败 0，跳过 2");
  });

  it("pauses only between atomic items and resumes without re-exporting success", async () => {
    let paused = true;
    let releaseResume!: () => void;
    const resume = new Promise<void>((resolve) => { releaseResume = resolve; });
    const exportItem = vi.fn(async () => undefined);
    const items = ["first.png", "second.png"].map((name) => ({ file: { name } }));
    const run = runExportQueue(items, exportItem, {
      shouldPause: () => paused,
      waitForResume: () => resume,
    });
    await Promise.resolve();
    expect(exportItem).not.toHaveBeenCalled();
    paused = false;
    releaseResume();
    const result = await run;
    expect(exportItem).toHaveBeenCalledTimes(2);
    expect(result.succeeded).toEqual(items);
  });

  it("keeps complete failure filenames and reasons copyable", () => {
    expect(formatExportFailureDetails([
      { fileName: "very-long-image-name.bmp", message: "编码失败" },
      { fileName: "second.png", message: "输出目录不可用" },
    ])).toBe("very-long-image-name.bmp：编码失败\nsecond.png：输出目录不可用");
  });
});
