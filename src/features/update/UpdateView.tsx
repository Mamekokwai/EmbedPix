import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  Info,
  RefreshCw,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import "../../styles/features/update.css";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export type UpdateErrorStage = "check" | "download" | "install" | "offline";

export interface UpdateViewProps {
  currentVersion: string;
  latestVersion?: string;
  status: UpdateStatus;
  releaseNotes?: string;
  releaseUrl?: string | null;
  assetAvailable?: boolean;
  errorStage?: UpdateErrorStage;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  errorMessage?: string;
  installHealthMessage?: string;
  onCheckForUpdates: () => void | Promise<void>;
  onDownloadUpdate: () => void | Promise<void>;
  onInstallUpdate: () => void | Promise<void>;
  onOpenReleasePage: () => void | Promise<void>;
  embedded?: boolean;
  className?: string;
}

interface StatusMeta {
  label: string;
  className: string;
}

const STATUS_META: Record<UpdateStatus, StatusMeta> = {
  idle: { label: "尚未检查更新", className: "update-status-idle" },
  checking: { label: "正在检查更新…", className: "update-status-checking" },
  "up-to-date": { label: "已是最新版本", className: "update-status-success" },
  available: { label: "发现新版本", className: "update-status-available" },
  downloading: { label: "正在下载更新…", className: "update-status-available" },
  downloaded: { label: "更新包已下载", className: "update-status-success" },
  installing: { label: "正在安装更新…", className: "update-status-available" },
  error: { label: "更新失败", className: "update-status-error" },
};

export function resolveUpdateStatusLabel(status: UpdateStatus, errorStage?: UpdateErrorStage): string {
  return status === "error" && errorStage === "offline" ? "当前离线" : STATUS_META[status].label;
}

export function formatUpdateCheckTime(value: Date | null): string {
  if (!value || Number.isNaN(value.getTime())) return "—";
  return value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 || amount >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function resolveUpdateProgress(
  status: UpdateStatus,
  downloadedBytes: number | null | undefined,
  totalBytes: number | null | undefined,
) {
  const hasDownloaded = typeof downloadedBytes === "number" && Number.isFinite(downloadedBytes);
  const hasTotal = typeof totalBytes === "number" && Number.isFinite(totalBytes) && totalBytes > 0;
  const percent = hasDownloaded && hasTotal
    ? Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)))
    : null;

  if (status === "downloading") {
    return {
      percent,
      indeterminate: percent === null,
      label: hasDownloaded && hasTotal
        ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
        : hasDownloaded
          ? `已下载 ${formatBytes(downloadedBytes)}`
          : "正在获取进度",
      valueText: percent === null ? null : `${percent}%`,
    };
  }

  if (status === "downloaded") {
    return { percent: 100, indeterminate: false, label: "更新包已下载，确认后重启安装。", valueText: "100%" };
  }

  if (status === "installing") {
    return { percent: null, indeterminate: true, label: "正在安装更新，应用将很快重启", valueText: null };
  }

  return null;
}

function StatusIcon({ status, offline }: { status: UpdateStatus; offline: boolean }) {
  if (offline) return <WifiOff size={16} aria-hidden="true" />;
  if (status === "up-to-date" || status === "downloaded") {
    return <CheckCircle2 size={16} aria-hidden="true" />;
  }
  if (status === "error") return <TriangleAlert size={16} aria-hidden="true" />;
  if (status === "checking" || status === "downloading" || status === "installing") {
    return <RefreshCw className="update-status-icon-spinning" size={16} aria-hidden="true" />;
  }
  return <Info size={16} aria-hidden="true" />;
}

function UpdateProgressBar({
  progress,
}: {
  progress: ReturnType<typeof resolveUpdateProgress>;
}) {
  if (!progress) return null;
  const resolvedPercent = progress.percent ?? 0;
  return (
    <div className="update-progress" aria-label={progress.label}>
      <div className="update-progress-label">
        <span>{progress.label}</span>
        {progress.valueText ? <strong>{progress.valueText}</strong> : null}
      </div>
      <div
        className="update-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.indeterminate ? undefined : resolvedPercent}
        aria-valuetext={progress.valueText ?? progress.label}
      >
        {progress.indeterminate ? (
          <span className="update-progress-indeterminate" />
        ) : (
          <span className="update-progress-value" style={{ width: `${resolvedPercent}%` }} />
        )}
      </div>
    </div>
  );
}

export default function UpdateView({
  currentVersion,
  status,
  releaseNotes,
  releaseUrl,
  assetAvailable = false,
  errorStage,
  installHealthMessage,
  downloadedBytes,
  totalBytes,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  onOpenReleasePage,
  embedded = false,
  className,
}: UpdateViewProps) {
  const [releaseOpenError, setReleaseOpenError] = useState<string | null>(null);
  const [releaseExpanded, setReleaseExpanded] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const meta = STATUS_META[status];
  const progress = resolveUpdateProgress(status, downloadedBytes, totalBytes);
  const busy = status === "checking" || status === "downloading" || status === "installing";
  const offline = status === "error" && errorStage === "offline";
  const viewClassName = ["update-view", embedded ? "update-view-embedded" : "page-view", className].filter(Boolean).join(" ");

  useEffect(() => {
    if (status !== "idle" && status !== "checking" && status !== "downloading" && status !== "installing") {
      setLastCheckedAt(new Date());
    }
  }, [status]);

  const handlePrimaryAction = () => {
    if (busy) return;
    if (status === "available" && assetAvailable) {
      void onDownloadUpdate();
      return;
    }
    if (status === "downloaded" || (status === "error" && errorStage === "install")) {
      void onInstallUpdate();
      return;
    }
    if (status === "error" && errorStage === "download" && assetAvailable) {
      void onDownloadUpdate();
      return;
    }
    if (status !== "available") void onCheckForUpdates();
  };

  const handleOpenReleasePage = async () => {
    if (!releaseUrl) {
      setReleaseOpenError("当前没有可用的发布页地址。");
      return;
    }
    try {
      await onOpenReleasePage();
      setReleaseOpenError(null);
    } catch (error) {
      setReleaseOpenError(error instanceof Error ? error.message : "无法打开发布页，请稍后重试。");
    }
  };

  const actionLabel = offline
    ? "重试检查"
    : status === "checking"
    ? "检查中…"
    : status === "downloading" || status === "installing"
      ? "处理中…"
      : status === "available" && assetAvailable
        ? "立即下载"
        : status === "downloaded"
          ? "关闭并安装"
          : status === "error" && errorStage === "install"
            ? "再次关闭并安装"
            : status === "error" && errorStage === "download" && assetAvailable
              ? "重新下载"
              : status === "error"
                ? "重新检查"
                : "检查更新";

  return (
    <div className={viewClassName}>
      {!embedded ? (
        <header className="page-header">
          <div className="page-header-icon"><RefreshCw size={19} aria-hidden="true" /></div>
          <div className="page-header-copy">
            <p className="page-eyebrow">UPDATES</p>
            <h1>检查更新</h1>
            <p>查看 EmbedPix 是否有可用的新版本。</p>
          </div>
        </header>
      ) : null}

      <div className={`page-content update-content${embedded ? " update-content-embedded" : ""}`}>
        <section className="update-card" aria-labelledby="update-card-title">
          <div className="update-card-header">
            <div>
              <h2 id="update-card-title">版本信息</h2>
              <p>启动后会在后台检查更新，点击按钮即可下载或安装。</p>
            </div>
            {status !== "available" || assetAvailable ? (
              <button
                className="quiet-button update-check-button"
                type="button"
                disabled={busy}
                aria-busy={busy}
                onClick={handlePrimaryAction}
              >
                {offline ? <WifiOff size={15} aria-hidden="true" /> : status === "available" && assetAvailable ? <Download size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
                {actionLabel}
              </button>
            ) : null}
          </div>

          <div className="update-version-grid" aria-label="版本信息">
            <div className="update-version-item"><span>当前版本</span><strong>{currentVersion}</strong></div>
            <div className="update-version-item"><span>检查状态</span><strong>{resolveUpdateStatusLabel(status, errorStage)}</strong></div>
            <div className="update-version-item"><span>上次检查</span><strong>{formatUpdateCheckTime(lastCheckedAt)}</strong></div>
          </div>

          <div className={`update-status ${offline ? "update-status-offline" : meta.className}`} role="status" aria-live="polite" aria-atomic="true">
            <StatusIcon status={status} offline={offline} />
            <span>{resolveUpdateStatusLabel(status, errorStage)}</span>
          </div>
          {installHealthMessage ? <p className="update-release-open-error" role="alert">{installHealthMessage}</p> : null}
          {progress ? <UpdateProgressBar progress={progress} /> : null}
        </section>

        {(releaseNotes || releaseUrl || releaseOpenError) && (
          <section className="update-release-card" aria-labelledby="release-notes-title">
            <div className="update-release-heading">
              <div>
                <p className="update-section-eyebrow">RELEASE</p>
                <h2 id="release-notes-title">发布说明</h2>
              </div>
              <button
                className="update-release-link"
                type="button"
                disabled={!releaseUrl}
                aria-describedby={releaseOpenError ? "release-open-error" : undefined}
                onClick={() => void handleOpenReleasePage()}
              >
                {releaseUrl ? "查看发布页" : "发布页不可用"} <ExternalLink size={14} aria-hidden="true" />
              </button>
            </div>
            {releaseOpenError ? <p className="update-release-open-error" id="release-open-error" role="alert">{releaseOpenError}</p> : null}
            {releaseNotes ? <button className="update-release-toggle" type="button" aria-expanded={releaseExpanded} aria-controls="release-notes-content" onClick={() => setReleaseExpanded((expanded) => !expanded)}>{releaseExpanded ? "收起发布说明" : "展开发布说明"}</button> : null}
            {releaseNotes && releaseExpanded ? <p className="update-release-notes" id="release-notes-content">{releaseNotes}</p> : null}
          </section>
        )}
      </div>

    </div>
  );
}
