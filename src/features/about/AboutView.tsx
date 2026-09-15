import { Cpu, FileImage, Info, ShieldCheck } from "lucide-react";

const SUPPORTED_OUTPUTS = ["BMP", "PNG", "JPG", "RGB565 BIN", "C 数组"];

export default function AboutView() {
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
            <div className="about-title-line"><h2>嵌图匠</h2><span>v0.1.0</span></div>
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

        <p className="about-footnote">EmbedPix · 为嵌入式屏幕 UI 准备的图片工具</p>
      </div>
    </div>
  );
}
