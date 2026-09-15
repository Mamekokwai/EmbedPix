import packageJson from "../../../package.json";
import { openUrl } from "@tauri-apps/plugin-opener";

export const CURRENT_VERSION = packageJson.version;
export const RELEASES_API_URL = "https://api.github.com/repos/Mamekokwai/EmbedPix/releases/latest";
export const RELEASES_PAGE_URL = "https://github.com/Mamekokwai/EmbedPix/releases";
const RELEASE_ASSET_PREFIX = "https://github.com/Mamekokwai/EmbedPix/releases/download/";

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  releaseNotes: string | null;
  releaseDate: string | null;
  releaseUrl: string | null;
  assetDownloadUrl: string | null;
  assetSha256: string | null;
  assetSizeBytes: number | null;
  updateAvailable: boolean;
}

export type UpdateCheckErrorKind = "network" | "server" | "invalid-response";

export class UpdateCheckError extends Error {
  readonly kind: UpdateCheckErrorKind;

  constructor(kind: UpdateCheckErrorKind, message: string) {
    super(message);
    this.name = "UpdateCheckError";
    this.kind = kind;
  }
}

interface ReleaseResponse {
  tag_name?: unknown;
  body?: unknown;
  published_at?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

interface ReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
  digest?: unknown;
  size?: unknown;
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, "");
}

interface ParsedVersion {
  core: number[];
  prerelease: string[] | null;
}

function parseVersion(value: string): ParsedVersion | null {
  const normalized = normalizeVersion(value);
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/u.exec(normalized);
  if (!match) return null;

  const core = [match[1], match[2] ?? "0", match[3] ?? "0"].map(Number);
  if (!core.every(Number.isSafeInteger)) return null;
  return { core, prerelease: match[4]?.split(".") ?? null };
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return 0;

  for (let index = 0; index < 3; index += 1) {
    if (leftParts.core[index] !== rightParts.core[index]) {
      return leftParts.core[index] > rightParts.core[index] ? 1 : -1;
    }
  }

  if (leftParts.prerelease === null && rightParts.prerelease !== null) return 1;
  if (leftParts.prerelease !== null && rightParts.prerelease === null) return -1;
  if (leftParts.prerelease && rightParts.prerelease) {
    const length = Math.max(leftParts.prerelease.length, rightParts.prerelease.length);
    for (let index = 0; index < length; index += 1) {
      const leftPart = leftParts.prerelease[index];
      const rightPart = rightParts.prerelease[index];
      if (leftPart === undefined) return -1;
      if (rightPart === undefined) return 1;
      if (leftPart === rightPart) continue;
      const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : null;
      const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : null;
      if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber ? 1 : -1;
      if (leftNumber !== null) return -1;
      if (rightNumber !== null) return 1;
      return leftPart > rightPart ? 1 : -1;
    }
  }
  return 0;
}

function parseReleasePayload(payload: unknown): ReleaseResponse & { tag_name: string } {
  if (!payload || typeof payload !== "object") {
    throw new UpdateCheckError("invalid-response", "更新服务返回了无效数据。");
  }

  const release = payload as ReleaseResponse;
  if (typeof release.tag_name !== "string" || !parseVersion(release.tag_name)) {
    throw new UpdateCheckError("invalid-response", "更新服务没有返回有效版本号。");
  }

  return release as ReleaseResponse & { tag_name: string };
}

function parseReleaseAsset(release: ReleaseResponse, latestVersion: string): {
  url: string;
  sha256: string;
  sizeBytes: number | null;
} | null {
  if (!Array.isArray(release.assets)) return null;
  const expectedName = `EmbedPix_${latestVersion}_x64-setup.exe`;
  for (const candidate of release.assets) {
    if (!candidate || typeof candidate !== "object") continue;
    const asset = candidate as ReleaseAsset;
    if (asset.name !== expectedName || typeof asset.browser_download_url !== "string") continue;
    if (!isTrustedReleaseAssetUrl(asset.browser_download_url, latestVersion)) continue;
    if (typeof asset.digest !== "string" || !/^sha256:[0-9a-f]{64}$/iu.test(asset.digest)) continue;
    const sizeBytes = typeof asset.size === "number" && Number.isSafeInteger(asset.size) && asset.size >= 0
      ? asset.size
      : null;
    return {
      url: asset.browser_download_url,
      sha256: asset.digest.toLowerCase(),
      sizeBytes,
    };
  }
  return null;
}

export function isTrustedReleaseAssetUrl(value: string, version: string): boolean {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && !url.search
      && !url.hash
      && segments.length === 6
      && segments[0] === "Mamekokwai"
      && segments[1] === "EmbedPix"
      && segments[2] === "releases"
      && segments[3] === "download"
      && compareVersions(segments[4], version) === 0
      && segments[5] === `EmbedPix_${normalizeVersion(version)}_x64-setup.exe`
      && value.startsWith(RELEASE_ASSET_PREFIX);
  } catch {
    return false;
  }
}

export function isTrustedReleasePageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const shared = url.protocol === "https:"
      && url.hostname === "github.com"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && segments[0] === "Mamekokwai"
      && segments[1] === "EmbedPix"
      && segments[2] === "releases";
    if (!shared) return false;
    if (segments.length === 3) return true;
    return segments.length === 5
      && segments[3] === "tag"
      && parseVersion(segments[4]) !== null;
  } catch {
    return false;
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined"
    && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export async function openReleasePage(releaseUrl: string | null | undefined): Promise<void> {
  const url = typeof releaseUrl === "string" ? releaseUrl.trim() : "";
  if (!url || !isTrustedReleasePageUrl(url)) {
    throw new Error("发布页地址不可用。");
  }
  if (isTauriRuntime()) {
    await openUrl(url);
    return;
  }
  if (typeof window === "undefined") {
    throw new Error("当前环境无法打开发布页。");
  }
  const openedWindow = window.open(url, "_blank", "noopener,noreferrer");
  if (!openedWindow) {
    throw new Error("无法打开发布页，请检查浏览器弹窗权限。");
  }
}

function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, dispose: () => globalThis.clearTimeout(timer) };
}

export async function checkForUpdates(
  fetchImpl: typeof fetch = fetch,
  currentVersion = CURRENT_VERSION,
): Promise<UpdateInfo> {
  const timeout = createTimeoutSignal(8_000);
  let response: Response;
  try {
    response = await fetchImpl(RELEASES_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: timeout.signal,
    });
  } catch {
    throw new UpdateCheckError("network", "无法连接更新服务，请检查网络后重试。");
  } finally {
    timeout.dispose();
  }

  if (!response.ok) {
    throw new UpdateCheckError("server", `更新服务暂时不可用（HTTP ${response.status}）。`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new UpdateCheckError("invalid-response", "无法解析更新服务的返回数据。");
  }

  const release = parseReleasePayload(payload);
  const latestVersion = normalizeVersion(release.tag_name);
  const asset = parseReleaseAsset(release, latestVersion);
  return {
    currentVersion,
    latestVersion,
    releaseNotes: typeof release.body === "string" && release.body.trim() ? release.body.trim() : null,
    releaseDate: typeof release.published_at === "string" ? release.published_at : null,
    releaseUrl: typeof release.html_url === "string" && isTrustedReleasePageUrl(release.html_url)
      ? release.html_url
      : RELEASES_PAGE_URL,
    assetDownloadUrl: asset?.url ?? null,
    assetSha256: asset?.sha256 ?? null,
    assetSizeBytes: asset?.sizeBytes ?? null,
    updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
  };
}
