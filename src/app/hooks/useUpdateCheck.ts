import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkForUpdates,
  CURRENT_VERSION,
  type UpdateInfo,
} from "../../platform/update/updateGateway";
import {
  checkUpdate,
  downloadUpdate,
  installUpdate,
  onUpdateDownloadProgress,
} from "../../platform/update/updateRuntimeGateway";

const STARTUP_CHECK_DELAYS_MS = [3_500, 15_000, 60_000] as const;
const LAST_AUTO_CHECK_DAY_KEY = "embedpix.update.last-auto-check-day";

export type UpdateErrorStage = "check" | "download" | "install";

export type UpdateCheckState =
  | { status: "idle"; currentVersion: string; info: null; error: null; errorStage: null; downloadPath: null; downloadedBytes: null; totalBytes: null }
  | { status: "checking"; currentVersion: string; info: null; error: null; errorStage: null; downloadPath: null; downloadedBytes: null; totalBytes: null }
  | { status: "complete"; currentVersion: string; info: UpdateInfo; error: null; errorStage: null; downloadPath: null; downloadedBytes: null; totalBytes: null }
  | { status: "downloading"; currentVersion: string; info: UpdateInfo; error: null; errorStage: null; downloadPath: null; downloadedBytes: number; totalBytes: number | null }
  | { status: "downloaded"; currentVersion: string; info: UpdateInfo; error: null; errorStage: null; downloadPath: string; downloadedBytes: number; totalBytes: number | null }
  | { status: "installing"; currentVersion: string; info: UpdateInfo; error: null; errorStage: null; downloadPath: string; downloadedBytes: number | null; totalBytes: number | null }
  | { status: "error"; currentVersion: string; info: UpdateInfo | null; error: string; errorStage: UpdateErrorStage; downloadPath: string | null; downloadedBytes: number | null; totalBytes: number | null };

function isTauriRuntime(): boolean {
  return typeof window !== "undefined"
    && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function errorText(error: unknown, stage: UpdateErrorStage): string {
  console.error(`[update] ${stage} operation failed`, error);
  if (stage === "check") {
    return error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "无法检查更新，请稍后重试。";
  }
  if (stage === "download") return "更新下载安装包失败，请重试。";
  return "启动更新安装程序失败，请重试。";
}

function makeIdleState(): UpdateCheckState {
  return {
    status: "idle",
    currentVersion: CURRENT_VERSION,
    info: null,
    error: null,
    errorStage: null,
    downloadPath: null,
    downloadedBytes: null,
    totalBytes: null,
  };
}

function localDayKey(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function readLastAutoCheckDay(): string | null {
  try {
    return window.localStorage.getItem(LAST_AUTO_CHECK_DAY_KEY);
  } catch {
    return null;
  }
}

function writeLastAutoCheckDay(): void {
  try {
    window.localStorage.setItem(LAST_AUTO_CHECK_DAY_KEY, localDayKey());
  } catch {
    // Storage can be unavailable in a restricted WebView; the check remains useful for this run.
  }
}

export function useUpdateCheck() {
  const [state, setState] = useState<UpdateCheckState>(makeIdleState);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void onUpdateDownloadProgress((progress) => {
      if (cancelled || stateRef.current.status !== "downloading") return;
      const next: UpdateCheckState = {
        ...stateRef.current,
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
      } as UpdateCheckState;
      stateRef.current = next;
      setState(next);
    })
      .then((dispose) => {
        if (cancelled) dispose();
        else cleanup = dispose;
      })
      .catch((error) => {
        if (!cancelled) console.warn("[update] progress subscription unavailable", error);
      });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  const runCheck = useCallback(async (options: { silent?: boolean } = {}) => {
    const current = stateRef.current;
    if (current.status === "checking" || current.status === "downloading" || current.status === "installing") return current;
    const checking: UpdateCheckState = {
      status: "checking",
      currentVersion: current.currentVersion,
      info: null,
      error: null,
      errorStage: null,
      downloadPath: null,
      downloadedBytes: null,
      totalBytes: null,
    };
    stateRef.current = checking;
    setState(checking);
    try {
      const info = isTauriRuntime()
        ? await checkUpdate(current.currentVersion)
        : await checkForUpdates();
      const complete: UpdateCheckState = { status: "complete", currentVersion: info.currentVersion, info, error: null, errorStage: null, downloadPath: null, downloadedBytes: null, totalBytes: null };
      stateRef.current = complete;
      setState(complete);
      return complete;
    } catch (error) {
      const failed: UpdateCheckState = { status: "error", currentVersion: current.currentVersion, info: null, error: errorText(error, "check"), errorStage: "check", downloadPath: null, downloadedBytes: null, totalBytes: null };
      stateRef.current = failed;
      setState(failed);
      if (options.silent) return failed;
      return failed;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const wait = (delayMs: number) => new Promise<void>((resolve) => {
      window.setTimeout(resolve, delayMs);
    });

    const runStartupCheck = async () => {
      if (readLastAutoCheckDay() === localDayKey()) return;

      for (const delayMs of STARTUP_CHECK_DELAYS_MS) {
        await wait(delayMs);
        if (cancelled) return;

        const current = stateRef.current;
        if (current.status !== "idle" && current.status !== "error") return;

        const result = await runCheck({ silent: true });
        if (cancelled) return;
        if (result.status !== "error") {
          writeLastAutoCheckDay();
          return;
        }
      }
    };

    void runStartupCheck();
    return () => {
      cancelled = true;
    };
  }, [runCheck]);

  const runDownload = useCallback(async () => {
    const current = stateRef.current;
    const canRetry = current.status === "error" && current.errorStage === "download";
    if ((!canRetry && current.status !== "complete") || !current.info?.updateAvailable) return current;
    if (!current.info.assetDownloadUrl || !current.info.assetSha256) {
      const failed: UpdateCheckState = { status: "error", currentVersion: current.currentVersion, info: current.info, error: "当前版本没有可用的受信任安装包。", errorStage: "download", downloadPath: null, downloadedBytes: null, totalBytes: current.info.assetSizeBytes };
      stateRef.current = failed;
      setState(failed);
      return failed;
    }
    const downloading: UpdateCheckState = { status: "downloading", currentVersion: current.currentVersion, info: current.info, error: null, errorStage: null, downloadPath: null, downloadedBytes: 0, totalBytes: current.info.assetSizeBytes };
    stateRef.current = downloading;
    setState(downloading);
    try {
      const packageInfo = await downloadUpdate(
        current.info.assetDownloadUrl,
        current.info.assetSha256,
        current.info.latestVersion,
        current.info.assetSizeBytes,
      );
      const downloaded: UpdateCheckState = { ...downloading, status: "downloaded", downloadPath: packageInfo.path, downloadedBytes: packageInfo.sizeBytes, totalBytes: packageInfo.sizeBytes };
      stateRef.current = downloaded;
      setState(downloaded);
      return downloaded;
    } catch (error) {
      const failed: UpdateCheckState = { ...downloading, status: "error", error: errorText(error, "download"), errorStage: "download", downloadPath: null };
      stateRef.current = failed;
      setState(failed);
      return failed;
    }
  }, []);

  const runInstall = useCallback(async () => {
    const current = stateRef.current;
    if ((current.status !== "downloaded" && !(current.status === "error" && current.errorStage === "install"))
      || typeof current.downloadPath !== "string"
      || !current.info
      || typeof current.info.assetSha256 !== "string"
      || !current.info.latestVersion) return current;
    const updateInfo = current.info;
    const packagePath = current.downloadPath;
    const expectedSha256 = updateInfo.assetSha256;
    if (typeof expectedSha256 !== "string") return current;
    const installing: UpdateCheckState = {
      status: "installing",
      currentVersion: current.currentVersion,
      info: updateInfo,
      error: null,
      errorStage: null,
      downloadPath: packagePath,
      downloadedBytes: current.downloadedBytes,
      totalBytes: current.totalBytes,
    };
    stateRef.current = installing;
    setState(installing);
    try {
      await installUpdate(
        packagePath,
        expectedSha256,
        updateInfo.latestVersion,
        updateInfo.assetSizeBytes,
        true,
      );
      return installing;
    } catch (error) {
      const failed: UpdateCheckState = { ...installing, status: "error", error: errorText(error, "install"), errorStage: "install" };
      stateRef.current = failed;
      setState(failed);
      return failed;
    }
  }, []);

  return { state, runCheck, runDownload, runInstall };
}
