import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  Info,
  RefreshCw,
  TriangleAlert,
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

export type UpdateErrorStage = "check" | "download" | "install";

export interface UpdateViewProps {
  currentVersion: string;
  latestVersion?: string;
  status: UpdateStatus;
  releaseNotes?: string;
  releaseUrl?: string;
  assetAvailable?: boolean;
  errorStage?: UpdateErrorStage;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  errorMessage?: string;
  onCheckForUpdates: () => void | Promise<void>;
  onDownloadUpdate: () => void | Promise<void>;
  onInstallUpdate: () => void | Promise<void>;
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

function StatusIcon({ status }: { status: UpdateStatus }) {
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
  latestVersion,
  status,
  releaseNotes,
  releaseUrl,
  assetAvailable = false,
  errorStage,
  downloadedBytes,
  totalBytes,
  errorMessage,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
  className,
}: UpdateViewProps) {
  const [confirmAction, setConfirmAction] = useState<"download" | "install" | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const meta = STATUS_META[status];
  const progress = resolveUpdateProgress(status, downloadedBytes, totalBytes);
  const busy = status === "checking" || status === "downloading" || status === "installing";
  const viewClassName = ["update-view", "page-view", className].filter(Boolean).join(" ");

  useEffect(() => {
    if (!confirmAction) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmAction(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    confirmButtonRef.current?.focus();
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmAction]);

  useEffect(() => {
    if (busy) setConfirmAction(null);
  }, [busy]);

  const handlePrimaryAction = () => {
    if (busy) return;
    if (status === "available" && assetAvailable) {
      setConfirmAction("download");
      return;
    }
    if (status === "downloaded" || (status === "error" && errorStage === "install")) {
      setConfirmAction("install");
      return;
    }
    if (status === "error" && errorStage === "download" && assetAvailable) {
      void onDownloadUpdate();
      return;
    }
    if (status !== "available") void onCheckForUpdates();
  };

  const handleConfirm = () => {
    const action = confirmAction;
    setConfirmAction(null);
    if (action === "download") void onDownloadUpdate();
    if (action === "install") void onInstallUpdate();
  };

  const actionLabel = status === "checking"
    ? "检查中…"
    : status === "downloading" || status === "installing"
      ? "处理中…"
      : status === "available" && assetAvailable
        ? "立即下载"
        : status === "downloaded"
          ? "重启安装"
          : status === "error" && errorStage === "install"
            ? "再次安装"
            : status === "error" && errorStage === "download" && assetAvailable
              ? "重新下载"
              : status === "error"
                ? "重新检查"
                : "检查更新";

  const statusDetail = status === "available"
    ? assetAvailable
      ? "发现新版本，确认后先下载更新包，下载完成后再确认安装。"
      : "发现新版本，但没有可用的受信任安装包，请打开发布页手动下载。"
    : status === "downloaded"
      ? "更新包已通过校验，确认后重启并完成安装。"
      : status === "downloading"
        ? "安装包正在后台下载，完成后会进入安装确认。"
        : status === "installing"
          ? "正在启动安装程序，请保持应用开启。"
          : status === "error"
            ? errorMessage ?? "更新流程未能完成，可稍后重试。"
            : null;

  return (
    <div className={viewClassName}>
      <header className="page-header">
        <div className="page-header-icon"><RefreshCw size={19} aria-hidden="true" /></div>
        <div className="page-header-copy">
          <p className="page-eyebrow">UPDATES</p>
          <h1>检查更新</h1>
          <p>查看 EmbedPix 是否有可用的新版本。</p>
        </div>
      </header>

      <div className="page-content update-content">
        <section className="update-card" aria-labelledby="update-card-title">
          <div className="update-card-header">
            <div>
              <h2 id="update-card-title">版本信息</h2>
              <p>启动后会在后台检查更新，下载安装前始终需要确认。</p>
            </div>
            {status !== "available" || assetAvailable ? (
              <button
                className="quiet-button update-check-button"
                type="button"
                disabled={busy}
                aria-busy={busy}
                onClick={handlePrimaryAction}
              >
                {status === "available" && assetAvailable ? <Download size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
                {actionLabel}
              </button>
            ) : null}
          </div>

          <div className="update-version-grid" aria-label="版本信息">
            <div className="update-version-item"><span>当前版本</span><strong>{currentVersion}</strong></div>
            <div className="update-version-item"><span>最新版本</span><strong>{latestVersion ?? "—"}</strong></div>
          </div>

          <div className={`update-status ${meta.className}`} role="status" aria-live="polite" aria-atomic="true">
            <StatusIcon status={status} />
            <span>{meta.label}</span>
          </div>
          {statusDetail ? <p className="update-status-detail">{statusDetail}</p> : null}
          {progress ? <UpdateProgressBar progress={progress} /> : null}
        </section>

        {(releaseNotes || releaseUrl) && (
          <section className="update-release-card" aria-labelledby="release-notes-title">
            <div className="update-release-heading">
              <div>
                <p className="update-section-eyebrow">RELEASE</p>
                <h2 id="release-notes-title">发布说明</h2>
              </div>
              {releaseUrl ? (
                <a className="update-release-link" href={releaseUrl} target="_blank" rel="noreferrer">
                  查看发布页 <ExternalLink size={14} aria-hidden="true" />
                </a>
              ) : null}
            </div>
            {releaseNotes ? <p className="update-release-notes">{releaseNotes}</p> : null}
          </section>
        )}
      </div>

      {confirmAction ? (
        <div className="update-confirm-backdrop" role="presentation" onMouseDown={() => setConfirmAction(null)}>
          <section
            className="update-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="update-confirm-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <p className="update-section-eyebrow">CONFIRM UPDATE</p>
            <h2 id="update-confirm-title">{confirmAction === "download" ? "发现新版本" : "准备重启安装"}</h2>
            <p>
              {confirmAction === "download"
                ? `将下载 ${latestVersion ? `v${latestVersion}` : "新版本"} 安装包，下载完成后还需要再次确认安装。`
                : "应用将启动受信任的安装程序并重启完成更新。"}
            </p>
            {releaseNotes ? <div className="update-confirm-notes">{releaseNotes}</div> : null}
            <div className="update-confirm-actions">
              <button className="quiet-button" type="button" onClick={() => setConfirmAction(null)}>稍后</button>
              <button ref={confirmButtonRef} className="quiet-button update-confirm-primary" type="button" onClick={handleConfirm}>
                {confirmAction === "download" ? "立即下载" : "重启安装"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
