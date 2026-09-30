import { describe, expect, it, vi } from "vitest";
import { formatUpdateError, isUpdateDownloadCancellation } from "./useUpdateCheck";

describe("update error presentation", () => {
  it("does not expose raw technical English errors", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(formatUpdateError(new Error("connection reset by peer"), "download")).toBe("更新下载安装包失败，请重试。");
    vi.restoreAllMocks();
  });

  it("preserves actionable localized backend errors", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(formatUpdateError("更新安装包校验失败，请重新检查更新。", "download")).toBe("更新下载安装包失败：更新安装包校验失败，请重新检查更新。");
    vi.restoreAllMocks();
  });

  it("recognizes cancellation rejects as a non-error terminal state", () => {
    expect(isUpdateDownloadCancellation("更新下载已取消。")).toBe(true);
    expect(isUpdateDownloadCancellation(new Error("network reset"))).toBe(false);
  });
});
