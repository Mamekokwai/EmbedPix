import { describe, expect, it } from "vitest";
import { resolveUpdateProgress } from "./UpdateView";

describe("update progress model", () => {
  it("formats a determinate download with bytes and percentage", () => {
    expect(resolveUpdateProgress("downloading", 512, 1024)).toEqual({
      percent: 50,
      indeterminate: false,
      label: "512 B / 1.0 KB",
      valueText: "50%",
    });
  });

  it("uses an indeterminate bar when the server omits total size", () => {
    expect(resolveUpdateProgress("downloading", 2048, null)).toEqual({
      percent: null,
      indeterminate: true,
      label: "已下载 2.0 KB",
      valueText: null,
    });
  });

  it("keeps a completed package visibly complete", () => {
    expect(resolveUpdateProgress("downloaded", 123, 123)).toMatchObject({
      percent: 100,
      indeterminate: false,
      valueText: "100%",
    });
  });

  it("shows indeterminate progress while installing", () => {
    expect(resolveUpdateProgress("installing", null, null)).toMatchObject({
      percent: null,
      indeterminate: true,
    });
  });
});
