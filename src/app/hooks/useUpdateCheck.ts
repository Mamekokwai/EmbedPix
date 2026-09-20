import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkForUpdates,
  CURRENT_VERSION,
  openReleasePage as openReleasePageInBrowser,
  UpdateCheckError,
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

export type UpdateErrorStage = "check" | "download" | "install" | "offline";

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

export function isNetworkAvailable(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function errorText(error: unknown, stage: UpdateErrorStage): string {
  console.error(`[update] ${stage} operation failed`, error);
  const detail = error instanceof Error
    ? error.message.trim()
    : typeof error === "string"
      ? error.trim()
      : "";
  if (stage === "check") {
    return detail || "无法检查更新，请稍后重试。";
  }
  if (stage === "download") return detail ? `更新下载安装包失败：${detail}` : "更新下载安装包失败，请重试。";
  return detail ? `启动更新安装程序失败：${detail}` : "启动更新安装程序失败，请重试。";
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

export function makeOfflineState(currentVersion = CURRENT_VERSION): UpdateCheckState {
  return {
    status: "error",
    currentVersion,
    info: null,
    error: "当前处于离线状态，暂不检查更新。恢复网络后可手动重试。",
    errorStage: "offline",
    downloadPath: null,
    downloadedBytes: null,
    totalBytes: null,
  };
}

function isOfflineCheckError(error: unknown): boolean {
  if (!isNetworkAvailable()) return true;
  if (error instanceof UpdateCheckError && error.kind === "network") return true;
  if (!(error instanceof Error)) return false;
  return /failed to fetch|load failed|network request|network error|offline|网络|连接/u.test(error.message);
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
  const [state, setState] = useState<UpdateCheckState>(() => isNetworkAvailable() ? makeIdleState() : makeOfflineState());
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
    if (!isNetworkAvailable()) {
      const offline = makeOfflineState(current.currentVersion);
      stateRef.current = offline;
      setState(offline);
      return offline;
    }
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
      const offline = isOfflineCheckError(error);
      const failed: UpdateCheckState = offline
        ? makeOfflineState(current.currentVersion)
        : { status: "error", currentVersion: current.currentVersion, info: null, error: errorText(error, "check"), errorStage: "check", downloadPath: null, downloadedBytes: null, totalBytes: null };
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
      if (!isNetworkAvailable()) return;
      if (readLastAutoCheckDay() === localDayKey()) return;

      for (const delayMs of STARTUP_CHECK_DELAYS_MS) {
        await wait(delayMs);
        if (cancelled) return;
        if (!isNetworkAvailable()) return;

        const current = stateRef.current;
        if (current.status !== "idle" && current.status !== "error") return;

        const result = await runCheck({ silent: true });
        if (cancelled) return;
        if (result.status === "error" && result.errorStage === "offline") return;
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

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    let cancelled = false;
    const handleOffline = () => {
      const current = stateRef.current;
      if (cancelled || current.status === "checking" || current.status === "downloading" || current.status === "installing") return;
      if (current.status === "idle" || (current.status === "error" && current.errorStage === "check")) {
        const offline = makeOfflineState(current.currentVersion);
        stateRef.current = offline;
        setState(offline);
      }
    };
    window.addEventListener("offline", handleOffline);
    return () => {
      cancelled = true;
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const runDownload = useCallback(async () => {
    const current = stateRef.current;
    const canRetry = current.status === "error" && current.errorStage === "download";
    if ((!canRetry && current.status !== "complete") || !current.info?.updateAvailable) return current;
    if (!current.info.assetDownloadUrl || !current.info.assetSha256) {
      const failed: UpdateCheckState = { status: "error", currentVersion: current.currentVersion, info: current.info, error: "当前平台没有可用的受信任自动安装包，请打开发布页手动下载并安装。", errorStage: "download", downloadPath: null, downloadedBytes: null, totalBytes: current.info.assetSizeBytes };
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

  const runOpenReleasePage = useCallback(async (releaseUrl: string | null | undefined) => {
    await openReleasePageInBrowser(releaseUrl);
  }, []);

  return { state, runCheck, runDownload, runInstall, openReleasePage: runOpenReleasePage };
}
