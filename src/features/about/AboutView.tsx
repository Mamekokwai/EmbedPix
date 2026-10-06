import { useEffect, useState } from "react";
import { FileText, Github, HeartHandshake, Info, MessageSquare, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { MouseEvent } from "react";
import packageJson from "../../../package.json";
import UpdateView, { type UpdateViewProps } from "../update/UpdateView";
import { FORMAT_METADATA } from "../../shared/formatMetadata";
import { RELEASES_PAGE_URL } from "../../platform/update/updateGateway";

const AUTHOR_BLOG_URL = "https://blog.nywerya.xyz/";
const AUTHOR_AVATAR_URL = "https://photo.nywerya.xyz/Obsidian/%E5%A4%B4%E5%83%8F2.jpg";
const AUTHOR_AVATAR_FALLBACK_URL = "/embedpix-icon.png";
const AUTHOR_GITHUB_URL = "https://github.com/Mamekokwai";
const PROJECT_REPOSITORY_URL = "https://github.com/Mamekokwai/EmbedPix";
const PROJECT_ISSUES_URL = "https://github.com/Mamekokwai/EmbedPix/issues/new/choose";
const KOFI_SUPPORT_URL = "https://ko-fi.com/nywerya";
const WECHAT_REWARD_IMAGE_URL = "/wechat-reward.png";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined"
    && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function handleExternalLink(event: MouseEvent<HTMLAnchorElement>, url: string): void {
  if (!isTauriRuntime()) return;
  event.preventDefault();
  void openUrl(url).catch((error) => console.warn("open external author link failed", error));
}

export default function AboutView(updateProps: UpdateViewProps) {
  const [authorAvatarUrl, setAuthorAvatarUrl] = useState(AUTHOR_AVATAR_URL);
  const [supportDialogOpen, setSupportDialogOpen] = useState(false);

  useEffect(() => {
    if (!supportDialogOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSupportDialogOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [supportDialogOpen]);

  return (
    <div className="about-view page-view">
      <header className="page-header">
        <div className="page-header-icon"><Info size={19} aria-hidden="true" /></div>
        <div>
          <p className="page-eyebrow">ABOUT EMBEDPIX</p>
          <h1>关于嵌图匠</h1>
          <p>面向嵌入式 UI 开发的本地图片格式转换工具。</p>
        </div>
      </header>

      <div className="page-content about-content">
        <section className="about-hero">
          <div className="about-logo-shell"><img src="/embedpix-icon.png" alt="嵌图匠图标" /></div>
          <div className="about-hero-copy">
            <div className="about-title-line"><h2>嵌图匠</h2><span>v{packageJson.version}</span></div>
            <p>EmbedPix 把常见图片处理和单片机资源导出集中在一个轻量工作区里。</p>
            <div className="about-output-list" aria-label="支持的输出格式">
              {FORMAT_METADATA.map((format) => <span key={format.id} title={format.description}>{format.label}</span>)}
            </div>
          </div>
        </section>

        <section className="about-pill-row" aria-label="项目与支持">
          <a className="about-pill-action" href={PROJECT_REPOSITORY_URL} target="_blank" rel="noreferrer" onClick={(event) => handleExternalLink(event, PROJECT_REPOSITORY_URL)}>
            <span className="about-pill-icon" aria-hidden="true"><Github size={14} /></span>
            <span className="about-pill-label">GitHub Star</span>
          </a>
          <a className="about-pill-action" href={RELEASES_PAGE_URL} target="_blank" rel="noreferrer" onClick={(event) => handleExternalLink(event, RELEASES_PAGE_URL)}>
            <span className="about-pill-icon" aria-hidden="true"><FileText size={14} /></span>
            <span className="about-pill-label">更新说明</span>
          </a>
          <a className="about-pill-action" href={PROJECT_ISSUES_URL} target="_blank" rel="noreferrer" onClick={(event) => handleExternalLink(event, PROJECT_ISSUES_URL)}>
            <span className="about-pill-icon" aria-hidden="true"><MessageSquare size={14} /></span>
            <span className="about-pill-label">问题反馈</span>
          </a>
          <button type="button" className="about-pill-action" onClick={() => setSupportDialogOpen(true)}>
            <span className="about-pill-icon" aria-hidden="true"><HeartHandshake size={14} /></span>
            <span className="about-pill-label">赞助项目</span>
          </button>
        </section>

        <section className="about-author-card" aria-label="作者信息">
          <img className="about-author-avatar" src={authorAvatarUrl} alt="Nywerya头像" onError={() => setAuthorAvatarUrl((current) => current === AUTHOR_AVATAR_URL ? AUTHOR_AVATAR_FALLBACK_URL : current)} />
          <div className="about-author-copy">
            <p className="about-section-eyebrow">MADE BY NYWERYA</p>
            <h2>Nywerya · XUNCHANG WANG</h2>
            <p>EmbedPix 的作者与维护者，专注于嵌入式界面和本地工具。</p>
          </div>
          <div className="about-author-links">
            <a className="about-author-link" href={AUTHOR_BLOG_URL} target="_blank" rel="noreferrer" onClick={(event) => handleExternalLink(event, AUTHOR_BLOG_URL)}>
              博客
            </a>
            <a className="about-author-link" href={AUTHOR_GITHUB_URL} target="_blank" rel="noreferrer" onClick={(event) => handleExternalLink(event, AUTHOR_GITHUB_URL)}>
              <Github size={15} aria-hidden="true" />
              @Mamekokwai
            </a>
          </div>
        </section>

        <UpdateView {...updateProps} embedded />

        <p className="about-footnote">EmbedPix · 为嵌入式屏幕 UI 准备的图片工具</p>

        {supportDialogOpen ? (
          <div
            className="about-support-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setSupportDialogOpen(false);
            }}
          >
            <div className="about-support-dialog" role="dialog" aria-modal="true" aria-labelledby="about-support-title">
              <div className="about-support-head">
                <h2 id="about-support-title">赞助嵌图匠</h2>
                <button type="button" className="about-support-close" aria-label="关闭赞助弹窗" onClick={() => setSupportDialogOpen(false)}>
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
              <p className="about-support-copy">嵌图匠是免费的开源工具，赞助完全自愿，不影响任何功能。</p>
              <div className="about-support-channel">
                <img className="about-support-qr" src={WECHAT_REWARD_IMAGE_URL} alt="微信赞赏码，扫码支持嵌图匠" />
                <div className="about-support-channel-copy">
                  <h3>微信赞赏</h3>
                  <p>用微信扫码，金额随意。</p>
                </div>
              </div>
              <a className="about-support-kofi" href={KOFI_SUPPORT_URL} target="_blank" rel="noreferrer" onClick={(event) => handleExternalLink(event, KOFI_SUPPORT_URL)}>
                在 Ko-fi 上请我喝咖啡
              </a>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
