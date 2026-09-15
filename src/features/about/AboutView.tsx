import { Cpu, FileImage, Github, Info, ShieldCheck } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { MouseEvent } from "react";
import packageJson from "../../../package.json";
import UpdateView, { type UpdateViewProps } from "../update/UpdateView";

const SUPPORTED_OUTPUTS = ["BMP", "PNG", "JPG", "RGB565 BIN", "C 数组"];
const AUTHOR_BLOG_URL = "https://blog.nywerya.xyz/";
const AUTHOR_AVATAR_URL = "https://photo.nywerya.xyz/Obsidian/%E5%A4%B4%E5%83%8F2.jpg";
const AUTHOR_GITHUB_URL = "https://github.com/Mamekokwai";

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
              {SUPPORTED_OUTPUTS.map((format) => <span key={format}>{format}</span>)}
            </div>
          </div>
        </section>

        <div className="about-info-grid">
          <article className="about-info-card">
            <ShieldCheck size={18} aria-hidden="true" />
            <div><h3>本地优先</h3><p>图片只在本机处理，不上传到网络服务。</p></div>
          </article>
          <article className="about-info-card">
            <Cpu size={18} aria-hidden="true" />
            <div><h3>面向硬件</h3><p>支持 RGB565、通道顺序、端序、行序和对齐参数。</p></div>
          </article>
          <article className="about-info-card">
            <FileImage size={18} aria-hidden="true" />
            <div><h3>轻量工作流</h3><p>拖入图片、调整尺寸与参数，直接导出可用资源。</p></div>
          </article>
        </div>

        <section className="about-author-card" aria-label="作者信息">
          <img className="about-author-avatar" src={AUTHOR_AVATAR_URL} alt="Nywerya头像" />
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
      </div>
    </div>
  );
}
