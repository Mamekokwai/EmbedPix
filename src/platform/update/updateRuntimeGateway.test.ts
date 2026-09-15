import { describe, expect, it } from "vitest";
import { parseUpdateCheckResult } from "./updateRuntimeGateway";

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
