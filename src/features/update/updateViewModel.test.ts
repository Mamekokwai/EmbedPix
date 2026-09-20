import { describe, expect, it } from "vitest";
import { formatUpdateCheckTime, resolveUpdateProgress, resolveUpdateStatusLabel } from "./UpdateView";
import { makeOfflineState } from "../../app/hooks/useUpdateCheck";

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

describe("offline update state", () => {
  it("shows a dedicated offline label instead of a generic failure", () => {
    expect(resolveUpdateStatusLabel("error", "offline")).toBe("当前离线");
    expect(resolveUpdateStatusLabel("error", "check")).toBe("更新失败");
  });

  it("keeps offline startup retryable without invoking the updater", () => {
    expect(makeOfflineState("0.2.0")).toMatchObject({
      status: "error",
      currentVersion: "0.2.0",
      errorStage: "offline",
      error: "当前处于离线状态，暂不检查更新。恢复网络后可手动重试。",
    });
  });
});

describe("compact update status", () => {
  it("covers the compact status labels used by the single primary action", () => {
    expect([
      resolveUpdateStatusLabel("idle"),
      resolveUpdateStatusLabel("checking"),
      resolveUpdateStatusLabel("up-to-date"),
      resolveUpdateStatusLabel("available"),
      resolveUpdateStatusLabel("downloading"),
      resolveUpdateStatusLabel("error", "install"),
    ]).toEqual(["尚未检查更新", "正在检查更新…", "已是最新版本", "发现新版本", "正在下载更新…", "更新失败"]);
  });

  it("formats the last check time without leaking a placeholder date", () => {
    expect(formatUpdateCheckTime(null)).toBe("—");
    expect(formatUpdateCheckTime(new Date(2026, 0, 2, 9, 5))).toMatch(/09:05|上午09:05/);
  });
});
