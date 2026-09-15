import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import { isTrustedReleasePageUrl, type UpdateInfo } from "./updateGateway";

const UPDATE_PROGRESS_EVENT = "update-download-progress";
const UPDATE_PROGRESS_SNAPSHOT_COMMAND = "get_update_download_progress";

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
    releaseUrl: isTrustedReleasePageUrl(result.releaseUrl) ? result.releaseUrl : null,
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
  status: string;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
}

export interface DownloadedUpdate {
  path: string;
  sizeBytes: number;
}

export async function downloadUpdate(
  assetUrl: string,
  expectedSha256: string,
  version: string,
  expectedSize: number | null,
): Promise<DownloadedUpdate> {
  return invoke<DownloadedUpdate>("download_update", {
    assetUrl,
    expectedSha256,
    version,
    expectedSize,
  });
}

export async function installUpdate(
  packagePath: string,
  expectedSha256: string,
  version: string,
  expectedSize: number | null,
  userConfirmed: boolean,
): Promise<void> {
  await invoke("install_update", {
    packagePath,
    expectedSha256,
    version,
    expectedSize,
    userConfirmed,
  });
}

export async function getUpdateDownloadProgress(): Promise<UpdateDownloadProgress> {
  return invoke<UpdateDownloadProgress>(UPDATE_PROGRESS_SNAPSHOT_COMMAND);
}

export async function onUpdateDownloadProgress(
  handler: (progress: UpdateDownloadProgress) => void,
): Promise<() => void> {
  return listen<unknown>(UPDATE_PROGRESS_EVENT, (event: Event<unknown>) => {
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
  return typeof progress.status === "string"
    && typeof progress.downloadedBytes === "number"
    && Number.isSafeInteger(progress.downloadedBytes)
    && progress.downloadedBytes >= 0
    && (progress.totalBytes === null
      || (typeof progress.totalBytes === "number"
        && Number.isSafeInteger(progress.totalBytes)
        && progress.totalBytes >= 0))
    && (progress.error === null || typeof progress.error === "string");
}
