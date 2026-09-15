import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  downloadUpdate,
  getUpdateDownloadProgress,
  installUpdate,
  parseUpdateCheckResult,
} from "./updateRuntimeGateway";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const validResult = {
  currentVersion: "0.1.1",
  latestVersion: "0.2.0",
  releaseNotes: "修复更新流程。",
  releaseDate: "2026-09-15T00:00:00Z",
  releaseUrl: "https://github.com/Mamekokwai/EmbedPix/releases/tag/v0.2.0",
  assetDownloadUrl: "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.2.0/EmbedPix_0.2.0_x64-setup.exe",
  assetSha256: `sha256:${"a".repeat(64)}`,
  assetSizeBytes: 4096,
  updateAvailable: true,
};

describe("update runtime DTO", () => {
  it("maps the Tauri camelCase check result to the shared update model", () => {
    expect(parseUpdateCheckResult(validResult)).toEqual(validResult);
  });

  it("normalizes omitted nullable fields for a release without an installer", () => {
    expect(parseUpdateCheckResult({
      ...validResult,
      releaseNotes: null,
      releaseDate: null,
      assetDownloadUrl: null,
      assetSha256: null,
      assetSizeBytes: null,
      updateAvailable: false,
    })).toMatchObject({
      releaseNotes: null,
      releaseDate: null,
      assetDownloadUrl: null,
      assetSha256: null,
      assetSizeBytes: null,
      updateAvailable: false,
    });
  });

  it("rejects incomplete or unsafe DTO shapes before they reach the UI", () => {
    expect(() => parseUpdateCheckResult({ ...validResult, latestVersion: 2 })).toThrow("完整的版本信息");
    expect(() => parseUpdateCheckResult({ ...validResult, assetSizeBytes: -1 })).toThrow("安装包大小");
  });
});

describe("update runtime commands", () => {
  it("passes the backend download contract in camelCase", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ path: "cached.exe", sizeBytes: 4096 });

    await downloadUpdate("https://github.com/Mamekokwai/EmbedPix/releases/download/v0.2.0/EmbedPix_0.2.0_x64-setup.exe", validResult.assetSha256, "0.2.0", 4096);

    expect(invoke).toHaveBeenCalledWith("download_update", {
      assetUrl: "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.2.0/EmbedPix_0.2.0_x64-setup.exe",
      expectedSha256: validResult.assetSha256,
      version: "0.2.0",
      expectedSize: 4096,
    });
  });

  it("requires an explicit confirmation flag for installation", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);

    await installUpdate("cached.exe", validResult.assetSha256, "0.2.0", 4096, true);

    expect(invoke).toHaveBeenCalledWith("install_update", {
      packagePath: "cached.exe",
      expectedSha256: validResult.assetSha256,
      version: "0.2.0",
      expectedSize: 4096,
      userConfirmed: true,
    });
  });

  it("uses the Rust progress snapshot command", async () => {
    const progress = { status: "downloading", downloadedBytes: 128, totalBytes: 4096, error: null };
    vi.mocked(invoke).mockResolvedValueOnce(progress);

    await expect(getUpdateDownloadProgress()).resolves.toEqual(progress);
    expect(invoke).toHaveBeenCalledWith("get_update_download_progress");
  });
});
