import { useEffect, useState } from "react";
import { FileText, Github, HeartHandshake, Info, MessageSquare, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { MouseEvent } from "react";
import packageJson from "../../../package.json";
import UpdateView, { type UpdateViewProps } from "../update/UpdateView";
import { RELEASES_PAGE_URL } from "../../platform/update/updateGateway";

const PROJECT_REPOSITORY_URL = "https://github.com/Mamekokwai/EmbedPix";
const PROJECT_ISSUES_URL = "https://github.com/Mamekokwai/EmbedPix/issues/new/choose";
const KOFI_SUPPORT_URL = "https://ko-fi.com/nywerya";
// 赞赏码用原图（不裁切）；两个卡片图标都抄 patina：微信赞赏徽标、Ko-fi 官方 mark。
const WECHAT_REWARD_IMAGE_URL = "/wechat-reward.png";
const WECHAT_REWARD_MARK_URL = "/wechat-mark.png";
const KOFI_MARK_URL = "/kofi-mark.avif";

// 标签只讲功能，具体支持的格式收进悬停提示——简介里不再摊格式清单。
const FEATURE_GROUPS = [
  { label: "图片转换", detail: "BMP / PNG / JPG / TIFF / ICO · RGB565 / C 数组" },
  { label: "图片压缩", detail: "在目标体积与画质之间取舍，输出 WebP / PNG / JPEG" },
  { label: "GIF 制作", detail: "视频或 PNG 帧序列合成 GIF / WebP / APNG 动图" },
];

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
        <section className="about-hero" aria-labelledby="about-app-name">
          <div className="about-logo-shell"><img src="/embedpix-icon.png" alt="嵌图匠图标" /></div>
          <div className="about-title-line"><h2 id="about-app-name">嵌图匠</h2><span>v{packageJson.version}</span></div>
          <p className="about-hero-copy">EmbedPix 把常见图片处理和单片机资源导出集中在一个轻量工作区里。</p>
          <div className="about-output-list" aria-label="支持的输出格式">
            {FEATURE_GROUPS.map((group) => <span key={group.label} title={group.detail}>{group.label}</span>)}
          </div>

          <div className="about-pill-row" aria-label="项目与支持">
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
                <h2 id="about-support-title">赞助项目</h2>
                <button type="button" className="about-support-close" aria-label="关闭赞助弹窗" onClick={() => setSupportDialogOpen(false)}>
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
              <p className="about-support-copy">嵌图匠是免费的开源工具，赞助完全自愿，不影响任何功能。</p>
              <div className="about-support-body">
                <section className="about-support-card">
                  <div className="about-support-card-heading">
                    <img className="about-support-mark" src={WECHAT_REWARD_MARK_URL} alt="" aria-hidden="true" draggable={false} />
                    <h4>微信赞赏</h4>
                  </div>
                  <div className="about-support-qr-frame">
                    <img className="about-support-qr" src={WECHAT_REWARD_IMAGE_URL} alt="微信赞赏码，扫码支持嵌图匠" draggable={false} />
                  </div>
                </section>
                <section className="about-support-card">
                  <div className="about-support-card-heading">
                    <img className="about-support-mark" src={KOFI_MARK_URL} alt="" aria-hidden="true" draggable={false} />
                    <h4>Ko-fi</h4>
                  </div>
                  <p className="about-support-card-copy">喜欢嵌图匠的话，也可以在 Ko-fi 上请我喝一杯咖啡。</p>
                  <a className="about-support-kofi" href={KOFI_SUPPORT_URL} target="_blank" rel="noreferrer" onClick={(event) => handleExternalLink(event, KOFI_SUPPORT_URL)}>
                    在 Ko-fi 上请我喝咖啡
                  </a>
                </section>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
