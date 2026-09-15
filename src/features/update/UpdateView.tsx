import {
  CheckCircle2,
  ExternalLink,
  Info,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import "../../styles/features/update.css";

export type UpdateStatus = "idle" | "checking" | "up-to-date" | "available" | "error";

export interface UpdateViewProps {
  currentVersion: string;
  latestVersion?: string;
  status: UpdateStatus;
  releaseNotes?: string;
  releaseUrl?: string;
  errorMessage?: string;
  onCheckForUpdates: () => void | Promise<void>;
  className?: string;
}

const STATUS_META: Record<UpdateStatus, { label: string; className: string }> = {
  idle: { label: "尚未检查更新", className: "update-status-idle" },
  checking: { label: "检查中…", className: "update-status-checking" },
  "up-to-date": { label: "已是最新", className: "update-status-success" },
  available: { label: "有新版本", className: "update-status-available" },
  error: { label: "检查失败", className: "update-status-error" },
};

function StatusIcon({ status }: { status: UpdateStatus }) {
  if (status === "up-to-date") return <CheckCircle2 size={16} aria-hidden="true" />;
  if (status === "error") return <TriangleAlert size={16} aria-hidden="true" />;
  if (status === "checking") return <RefreshCw className="update-status-icon-spinning" size={16} aria-hidden="true" />;
  return <Info size={16} aria-hidden="true" />;
}

export default function UpdateView({
  currentVersion,
  latestVersion,
  status,
  releaseNotes,
  releaseUrl,
  errorMessage,
  onCheckForUpdates,
  className,
}: UpdateViewProps) {
  const meta = STATUS_META[status];
  const viewClassName = ["update-view", "page-view", className].filter(Boolean).join(" ");

  return (
    <div className={viewClassName}>
      <header className="page-header">
        <div className="page-header-icon"><RefreshCw size={19} aria-hidden="true" /></div>
        <div>
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
              <p>仅检查版本信息，不会自动下载或安装更新。</p>
            </div>
            <button
              className="quiet-button update-check-button"
              type="button"
              disabled={status === "checking"}
              aria-busy={status === "checking"}
              onClick={() => void onCheckForUpdates()}
            >
              <RefreshCw size={15} aria-hidden="true" />
              {status === "checking" ? "检查中…" : "检查更新"}
            </button>
          </div>

          <div className="update-version-grid" aria-label="版本信息">
            <div className="update-version-item">
              <span>当前版本</span>
              <strong>{currentVersion}</strong>
            </div>
            <div className="update-version-item">
              <span>最新版本</span>
              <strong>{latestVersion ?? "—"}</strong>
            </div>
          </div>

          <div className={`update-status ${meta.className}`} role="status" aria-live="polite" aria-atomic="true">
            <StatusIcon status={status} />
            <span>{status === "error" && errorMessage ? errorMessage : meta.label}</span>
          </div>
        </section>

        {(releaseNotes || releaseUrl) && (
          <section className="update-release-card" aria-labelledby="release-notes-title">
            <div className="update-release-heading">
              <div>
                <p className="update-section-eyebrow">RELEASE</p>
                <h2 id="release-notes-title">发布说明</h2>
              </div>
              {releaseUrl && (
                <a className="update-release-link" href={releaseUrl} target="_blank" rel="noreferrer">
                  查看发布页
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              )}
            </div>
            {releaseNotes && <p className="update-release-notes">{releaseNotes}</p>}
          </section>
        )}
      </div>
    </div>
  );
}
