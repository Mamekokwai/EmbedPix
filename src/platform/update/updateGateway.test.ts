import { afterEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  checkForUpdates,
  compareVersions,
  isTrustedReleaseAssetUrl,
  isTrustedReleaseAssetUrlForTarget,
  isTrustedReleasePageUrl,
  openReleasePage,
} from "./updateGateway";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function response(payload: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => payload } as Response;
}

describe("update gateway", () => {
  it("compares release versions without treating a v prefix as meaningful", () => {
    expect(compareVersions("v1.2.0", "1.1.9")).toBe(1);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.1.9", "1.2.0")).toBe(-1);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("not-a-version", "1.0.0")).toBe(0);
  });

  it("maps a valid GitHub release and detects a newer version", async () => {
    const result = await checkForUpdates(
      async () => response({
        tag_name: "v0.2.0",
        body: "新增 RGB565 导出。",
        published_at: "2026-09-15T00:00:00Z",
        html_url: "https://github.com/Mamekokwai/EmbedPix/releases/tag/v0.2.0",
        assets: [{
          name: "EmbedPix_0.2.0_x64-setup.exe",
          browser_download_url: "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.2.0/EmbedPix_0.2.0_x64-setup.exe",
          digest: `sha256:${"a".repeat(64)}`,
          size: 1024,
        }],
      }),
      "0.1.0",
    );

    expect(result).toMatchObject({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      releaseNotes: "新增 RGB565 导出。",
      updateAvailable: true,
      assetDownloadUrl: "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.2.0/EmbedPix_0.2.0_x64-setup.exe",
      assetSha256: `sha256:${"a".repeat(64)}`,
      assetSizeBytes: 1024,
    });
  });

  it("accepts only the matching EmbedPix installer asset URL", () => {
    expect(isTrustedReleaseAssetUrl(
      "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.2.0/EmbedPix_0.2.0_x64-setup.exe",
      "0.2.0",
    )).toBe(true);
    expect(isTrustedReleaseAssetUrl(
      "https://github.com/other/repo/releases/download/v0.2.0/EmbedPix_0.2.0_x64-setup.exe",
      "0.2.0",
    )).toBe(false);
    expect(isTrustedReleaseAssetUrl(
      "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.2.1/EmbedPix_0.2.1_x64-setup.exe?download=1",
      "0.2.0",
    )).toBe(false);
  });

  it("matches platform and architecture-specific release assets", () => {
    expect(isTrustedReleaseAssetUrlForTarget(
      "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.2.0/EmbedPix_0.2.0_aarch64.dmg",
      "0.2.0",
      "macos-arm64",
    )).toBe(true);
    expect(isTrustedReleaseAssetUrlForTarget(
      "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.2.0/EmbedPix_0.2.0_amd64.AppImage",
      "0.2.0",
      "linux-x64",
    )).toBe(true);
    expect(isTrustedReleaseAssetUrlForTarget(
      "https://github.com/Mamekokwai/EmbedPix/releases/download/v0.2.0/EmbedPix_0.2.0_x64-setup.exe",
      "0.2.0",
      "linux-x64",
    )).toBe(false);
  });

  it("accepts only the EmbedPix release page and version tag URLs", () => {
    expect(isTrustedReleasePageUrl("https://github.com/Mamekokwai/EmbedPix/releases")).toBe(true);
    expect(isTrustedReleasePageUrl("https://github.com/Mamekokwai/EmbedPix/releases/tag/v0.2.0")).toBe(true);
    expect(isTrustedReleasePageUrl("https://github.com/other/repo/releases/tag/v0.2.0")).toBe(false);
    expect(isTrustedReleasePageUrl("https://github.com/Mamekokwai/EmbedPix/releases?redirect=https://evil.example")).toBe(false);
    expect(isTrustedReleasePageUrl("javascript:window.alert(1)")).toBe(false);
  });

  it("opens a trusted release page in a browser tab", async () => {
    const open = vi.fn().mockReturnValue({ closed: false });
    vi.stubGlobal("window", { open });

    await openReleasePage(" https://github.com/Mamekokwai/EmbedPix/releases/tag/v0.2.0 ");

    expect(open).toHaveBeenCalledWith(
      "https://github.com/Mamekokwai/EmbedPix/releases/tag/v0.2.0",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("reports missing or blocked release page openings", async () => {
    await expect(openReleasePage(null)).rejects.toThrow("发布页地址不可用");

    vi.stubGlobal("window", { open: vi.fn().mockReturnValue(null) });
    await expect(openReleasePage("https://github.com/Mamekokwai/EmbedPix/releases"))
      .rejects.toThrow("检查浏览器弹窗权限");
  });

  it("uses the Tauri opener in the desktop runtime", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(openUrl).mockResolvedValueOnce(undefined);

    await openReleasePage("https://github.com/Mamekokwai/EmbedPix/releases");

    expect(openUrl).toHaveBeenCalledWith("https://github.com/Mamekokwai/EmbedPix/releases");
  });

  it("rejects invalid payloads and server failures with stable error kinds", async () => {
    await expect(checkForUpdates(async () => response({ tag_name: "preview" }), "0.1.0"))
      .rejects.toMatchObject({ kind: "invalid-response" });
    await expect(checkForUpdates(async () => response({}, false, 503), "0.1.0"))
      .rejects.toMatchObject({ kind: "server" });
    await expect(checkForUpdates(async () => { throw new Error("offline"); }, "0.1.0"))
      .rejects.toMatchObject({ kind: "network" });
  });
});
