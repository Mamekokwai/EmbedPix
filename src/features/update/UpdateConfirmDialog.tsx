import { useEffect, useRef } from "react";
import { Download, ExternalLink, RefreshCw, X } from "lucide-react";
import type { UpdateStatus } from "./UpdateView";
import UpdateProgressBar, { type UpdateProgressModel } from "./UpdateProgressBar";

export interface UpdateConfirmDialogProps {
  open: boolean;
  currentVersion: string;
  latestVersion?: string;
  status: UpdateStatus;
  releaseNotes?: string;
  errorMessage?: string;
  progress: UpdateProgressModel | null;
  downloading: boolean;
  installing: boolean;
  assetAvailable?: boolean;
  onClose: () => void;
  onDownload: () => void;
  onInstall: () => void;
  onCancelDownload: () => void;
  onOpenReleasePage: () => void;
}

export default function UpdateConfirmDialog({
  open,
  currentVersion,
  latestVersion,
  status,
  releaseNotes,
  errorMessage,
  progress,
  downloading,
  installing,
  assetAvailable = false,
  onClose,
  onDownload,
  onInstall,
  onCancelDownload,
  onOpenReleasePage,
}: UpdateConfirmDialogProps) {
  const laterButtonRef = useRef<HTMLButtonElement>(null);
  const busy = downloading || installing;
  const ready = status === "downloaded";

  useEffect(() => {
    if (!open) return;
    laterButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose, open]);

  if (!open) return null;

  const primaryAction = ready
    ? { label: installing ? "正在安装…" : "关闭并安装", icon: <RefreshCw size={14} aria-hidden="true" />, onClick: onInstall, disabled: installing }
    : { label: downloading ? "正在下载…" : "下载并安装", icon: <Download size={14} aria-hidden="true" />, onClick: onDownload, disabled: !assetAvailable || busy };

  return (
    <div
      className="update-confirm-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section className="update-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="update-confirm-title">
        <div className="update-confirm-head">
          <h2 id="update-confirm-title">{ready ? "更新包已就绪" : "发现新版本"}</h2>
          <button type="button" className="update-confirm-close" aria-label="关闭更新弹窗" disabled={busy} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="update-confirm-version">
          当前 v{currentVersion}
          {latestVersion ? <> → 最新 <strong>v{latestVersion}</strong></> : null}
        </p>
        <p className="update-confirm-copy">
          {ready
            ? "下载已完成，继续会关闭应用并安装新版本。"
            : "下载完成前可以随时取消；安装会关闭当前窗口，重新打开即为新版本。"}
        </p>
        {progress ? <UpdateProgressBar className="update-confirm-progress" progress={progress} /> : null}
        {errorMessage ? <p className="update-confirm-error" role="alert">{errorMessage}</p> : null}
        {releaseNotes ? (
          <div className="update-confirm-notes">
            <p className="update-section-eyebrow">RELEASE</p>
            <p className="update-confirm-notes-body">{releaseNotes}</p>
          </div>
        ) : null}
        <div className="update-confirm-actions">
          <button ref={laterButtonRef} className="quiet-button" type="button" disabled={busy} onClick={onClose}>稍后</button>
          <button className="quiet-button update-confirm-release" type="button" onClick={onOpenReleasePage}>
            查看发布页 <ExternalLink size={13} aria-hidden="true" />
          </button>
          {downloading ? (
            <button className="quiet-button" type="button" onClick={onCancelDownload}>取消下载</button>
          ) : (
            <button
              className="quiet-button update-confirm-primary"
              type="button"
              disabled={primaryAction.disabled}
              onClick={primaryAction.onClick}
            >
              {primaryAction.icon}
              {primaryAction.label}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
