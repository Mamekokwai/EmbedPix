import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";

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
