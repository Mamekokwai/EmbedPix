import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import type { UpdateInfo } from "./updateGateway";

export class UpdateRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateRuntimeError";
  }
}

export function parseUpdateCheckResult(value: unknown): UpdateInfo {
  if (!value || typeof value !== "object") {
    throw new UpdateRuntimeError("更新服务返回了无效数据。");
  }
  const result = value as Record<string, unknown>;
  if (typeof result.currentVersion !== "string"
    || typeof result.latestVersion !== "string"
    || typeof result.releaseUrl !== "string"
    || typeof result.updateAvailable !== "boolean") {
    throw new UpdateRuntimeError("更新服务没有返回完整的版本信息。");
  }

  const nullableString = (key: string): string | null => {
    const value = result[key];
    return value === null || typeof value === "string" ? value : null;
  };
  const nullableSize = result.assetSizeBytes;
  if (nullableSize !== null && nullableSize !== undefined
    && (typeof nullableSize !== "number" || !Number.isSafeInteger(nullableSize) || nullableSize < 0)) {
    throw new UpdateRuntimeError("更新服务返回了无效的安装包大小。");
  }

  return {
    currentVersion: result.currentVersion,
    latestVersion: result.latestVersion,
    releaseNotes: nullableString("releaseNotes"),
    releaseDate: nullableString("releaseDate"),
    releaseUrl: result.releaseUrl,
    assetDownloadUrl: nullableString("assetDownloadUrl"),
    assetSha256: nullableString("assetSha256"),
    assetSizeBytes: nullableSize === undefined ? null : nullableSize as number | null,
    updateAvailable: result.updateAvailable,
  };
}

export async function checkUpdate(currentVersion: string): Promise<UpdateInfo> {
  const payload = await invoke<unknown>("check_update", { currentVersion });
  return parseUpdateCheckResult(payload);
}

export interface UpdateDownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
}

export interface DownloadedUpdate {
  path: string;
  sizeBytes: number;
}

export async function downloadUpdate(
  assetUrl: string,
  expectedSha256: string,
  version: string,
): Promise<DownloadedUpdate> {
  return invoke<DownloadedUpdate>("download_update", {
    assetUrl,
    expectedSha256,
    version,
  });
}

export async function installUpdate(
  packagePath: string,
  expectedSha256: string,
  version: string,
): Promise<void> {
  await invoke("install_update", { packagePath, expectedSha256, version });
}

export async function onUpdateDownloadProgress(
  handler: (progress: UpdateDownloadProgress) => void,
): Promise<() => void> {
  return listen<unknown>("update-download-progress", (event: Event<unknown>) => {
    if (!isUpdateDownloadProgress(event.payload)) {
      console.warn("Ignored invalid update download progress payload", event.payload);
      return;
    }
    handler(event.payload);
  });
}

function isUpdateDownloadProgress(value: unknown): value is UpdateDownloadProgress {
  if (!value || typeof value !== "object") return false;
  const progress = value as Partial<UpdateDownloadProgress>;
  return typeof progress.downloadedBytes === "number"
    && Number.isSafeInteger(progress.downloadedBytes)
    && progress.downloadedBytes >= 0
    && (progress.totalBytes === null
      || (typeof progress.totalBytes === "number"
        && Number.isSafeInteger(progress.totalBytes)
        && progress.totalBytes >= 0));
}
