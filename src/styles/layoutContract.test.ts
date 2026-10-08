import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(url: URL): string {
  return readFileSync(url, "utf8").replace(/\r\n?/g, "\n");
}

const gifCss = readSource(new URL("./features/gif-maker.css", import.meta.url));
const converterCss = readSource(new URL("./features/image-converter.css", import.meta.url));
const compressionCss = readSource(new URL("./features/image-compression.css", import.meta.url));
const gifView = readSource(new URL("../features/gif-maker/GifMakerView.tsx", import.meta.url));
const converterView = readSource(new URL("../features/image-converter/ImageConverter.tsx", import.meta.url));
const compressionView = readSource(new URL("../features/image-compression/ImageCompressionView.tsx", import.meta.url));
const appShell = readSource(new URL("../app/AppShell.tsx", import.meta.url));
const appTitleBar = readSource(new URL("../app/AppTitleBar.tsx", import.meta.url));
const compressionGateway = readSource(new URL("../platform/compression/compressionGateway.ts", import.meta.url));
const compressionPreferences = readSource(new URL("../features/image-compression/compressionPreferences.ts", import.meta.url));
const windowControlGateway = readSource(new URL("../platform/window/windowControlGateway.ts", import.meta.url));
const defaultCapabilities = readSource(new URL("../../src-tauri/capabilities/default.json", import.meta.url));
const themeSelectCss = readSource(new URL("./components/theme-select.css", import.meta.url));
const themeSelectSource = readSource(new URL("../shared/components/ThemeSelect.tsx", import.meta.url));
const updateCss = readSource(new URL("./features/update.css", import.meta.url));
const updateView = readSource(new URL("../features/update/UpdateView.tsx", import.meta.url));
const settingsView = readSource(new URL("../features/settings/SettingsView.tsx", import.meta.url));
const settingsCss = readSource(new URL("./features/settings.css", import.meta.url));
const appCss = readSource(new URL("../App.css", import.meta.url));
const appShellCss = readSource(new URL("./app-shell.css", import.meta.url));
const fieldHintCss = readSource(new URL("./components/field-hint.css", import.meta.url));
const tokensCss = readSource(new URL("./tokens.css", import.meta.url));
const imageExportGateway = readSource(new URL("../platform/image/imageExportGateway.ts", import.meta.url));
const updateConfirmDialog = readSource(new URL("../features/update/UpdateConfirmDialog.tsx", import.meta.url));
const updateProgressBar = readSource(new URL("../features/update/UpdateProgressBar.tsx", import.meta.url));
const aboutView = readSource(new URL("../features/about/AboutView.tsx", import.meta.url));
const tauriConfig = readSource(new URL("../../src-tauri/tauri.conf.json", import.meta.url));
const libRs = readSource(new URL("../../src-tauri/src/lib.rs", import.meta.url));
const agentsMd = readSource(new URL("../../AGENTS.md", import.meta.url));
const formatMetadata = readSource(new URL("../shared/formatMetadata.ts", import.meta.url));
const aboutCss = readSource(new URL("./features/about.css", import.meta.url));

// 窗口最小宽度对齐 patina（900，按 src-tauri/src/lib.rs 创建主窗口时的 min_inner_size）：窄于 900 的断点已整批删除，矩阵不再覆盖更窄的视口。
const VIEWPORT_MATRIX = [
  { name: "minimum window", width: 900, height: 636 },
  { name: "narrow tall", width: 900, height: 1100 },
  { name: "default window", width: 1100, height: 760 },
  { name: "desktop short", width: 1280, height: 720 },
  { name: "regular desktop", width: 1280, height: 800 },
] as const;

const CONTENT_CONTAINER_MATRIX = [
  { name: "normal", width: 920, height: 640, expanded: false },
  { name: "narrow", width: 700, height: 640, expanded: false },
  { name: "short", width: 920, height: 320, expanded: false },
  { name: "multiple expanded modules", width: 700, height: 320, expanded: true },
] as const;

describe("compact layout viewport contract", () => {
  it("renders update failure details only for error states and wraps long text", () => {
    expect(updateView).toContain('status === "error" && errorMessage');
    expect(updateCss).toContain(".update-error-message");
    expect(updateCss).toContain("overflow-wrap: anywhere");
  });
  it("exposes readable values for compact settings sliders", () => {
    expect(settingsView).toContain('aria-label="JPEG 默认质量"');
    expect(settingsView).toContain("aria-valuetext={`${draft.defaultJpegQuality}% JPEG 默认质量`}");
  });
  it("pins a non-scrolling settings toolbar above the scrolling settings list", () => {
    // 顶栏：左侧标题不动，右侧状态提示 + 取消 + 保存；底部 1px 分隔线，是页面弹性列首的固定块（不随内容滚动）。
    expect(settingsView).toContain('className="page-header settings-toolbar"');
    expect(settingsView).toContain('className="settings-toolbar-actions"');
    expect(settingsView).toContain("有未保存更改");
    expect(settingsView).toContain("正在保存...");
    expect(settingsView).toContain("配置已更新");
    expect(settingsView).toContain('className="quiet-button settings-toolbar-cancel"');
    expect(settingsView).toContain('className="settings-primary-button settings-toolbar-save"');
    expect(settingsView).toContain("onClick={handleCancel}");
    expect(settingsView).toContain("onClick={handleSave}");
    expect(settingsView).toContain(">取消</button>");
    // 顶栏不再吸顶，而是页面弹性列里固定不缩的列首块；粘滞滚动已下沉到 .settings-content。
    expect(settingsCss).toMatch(/\.settings-toolbar \{[^}]*flex: 0 0 auto;/);
    expect(settingsCss).not.toMatch(/\.settings-toolbar \{[^}]*position: sticky;/);
    expect(settingsCss).toContain("background: var(--qp-bg-app)");
    expect(settingsCss).toContain("border-bottom: 1px solid var(--qp-border-subtle)");
  });
  it("keeps every settings control bound to a local draft until save", () => {
    // 控件读写 draft，只有「保存」通过 onChange(draft) 一次性提交；脏 = draft 与 props 不等。
    expect(settingsView).toContain("const [draft, setDraft] = useState<AppPreferences>(preferences)");
    expect(settingsView).toContain("setDraft(preferences);");
    expect(settingsView).toContain("arePreferencesEqual");
    expect(settingsView).toContain("onChange(draft)");
    expect(settingsView).toContain('disabled={!hasUnsavedChanges || saveStatus === "saving"}');
    expect(settingsView).toContain("value={draft.defaultOutputFormat}");
    expect(settingsView).toContain("value={draft.defaultJpegQuality}");
    expect(settingsView).toContain("checked={draft.keepAspectRatio}");
    expect(settingsView).toContain("value={draft.colorSchemeLight}");
    expect(settingsView).toContain("value={draft.defaultCArrayName}");
    expect(settingsView).toContain("presetLabel(draft.imagePreset)");
  });
  it("keeps estimate target and selected-quality fields visible with native results", () => {
    expect(compressionView).toContain("setEstimate(mergeCompressionEstimateResult(result))");
    expect(compressionView).toContain("typeof estimate.targetMet === \"boolean\"");
    expect(compressionView).toContain("typeof estimate.selectedQuality === \"number\"");
  });
  it("keeps compression selects aligned with the shared themed control", () => {
    expect(compressionView).toContain("<CompressionSelectField");
    expect(compressionView).not.toContain("<select");
    expect(compressionView).toContain('import ThemeSelect from "../../shared/components/ThemeSelect";');
    expect(compressionCss).not.toContain(".compression-field select");
    expect(themeSelectCss).toContain(".theme-select-trigger");
  });
  it("spans groups whose explanations or paired dimension inputs need full width", () => {
    expect(converterCss).toContain(".settings-module-body > .setting-group:has(> .field-help, > .format-description, > .dimensions-row) { grid-column: 1 / -1; }");
    expect(converterView).toContain('<div className="setting-group bit-depth-group">');
    expect(converterCss).toContain(".settings-module-body > .bit-depth-group { grid-column: 1 / -1; }");
  });
  it("centers the collapsible module header text and marker on one flex row", () => {
    // 标题与 +/− 标记都是 summary 的 flex 子项，靠 align-items:center 居中；标记 line-height:1 收敛到字形盒。
    // 纵向只留 padding: 0，不许用纵向内边距或基线技巧去凑（换字号/字体后会再偏）。
    expect(converterCss).toMatch(/\.settings-module > summary \{[^}]*display: flex;/);
    expect(converterCss).toMatch(/\.settings-module > summary \{[^}]*align-items: center;/);
    expect(converterCss).toMatch(/\.settings-module > summary \{[^}]*padding: 0 \d+px;/);
    expect(converterCss).toMatch(/\.settings-module > summary::after \{[^}]*line-height: 1;/);
    // 展开后标题栏下方那条 1px 分隔线保留。
    expect(converterCss).toMatch(/\.settings-module\[open\] > summary \{[^}]*border-bottom: 1px solid var\(--qp-border-subtle\);/);
  });
  it("sizes converter format options from their nearest card width", () => {
    expect(converterCss).toContain("container: format-options / inline-size;");
    expect(converterCss).toMatch(/\.format-selector \{[^}]*display: grid;/);
    expect(converterCss).toMatch(/\.format-selector \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
    expect(converterCss).toContain("@container format-options (max-width: 270px)");
    expect(converterCss).toContain("@container format-options (max-width: 210px)");
    expect(converterCss).toMatch(/\.format-option \{[^}]*min-width: 0;/);
    expect(converterCss).toContain("grid-auto-rows: auto;");
    expect(converterCss).not.toContain("aspect-ratio: 2 / 1;");
    expect(converterCss).toContain("box-sizing: border-box;");
    expect(converterCss).toContain(".format-option-content { display: flex;");
    expect(converterView).toContain('className="format-option-content"');
  });
  it("reveals converter explanations on hover instead of always showing them", () => {
    expect(fieldHintCss).toContain(".field-help-hover {");
    expect(fieldHintCss).toContain("*:has(+ .field-help-hover):hover + .field-help-hover,");
    // 只能用 :focus-visible：鼠标点一下开关也带焦点，:focus-within 会让浮出框在鼠标移开后一直挂着。
    expect(fieldHintCss).toContain("*:has(+ .field-help-hover):has(:focus-visible) + .field-help-hover,");
    expect(fieldHintCss).toContain(".field-help-hover-parent:has(:focus-visible) > .field-help-hover {");
    expect(fieldHintCss).not.toContain("):focus-within +");
    expect(fieldHintCss).not.toContain(":focus-within >");
    expect(converterView).toContain('className="field-help field-help-hover" id="converter-metadata-policy-help"');
    expect(converterView).toContain('className="field-help output-action-help field-help-hover" id="overwrite-same-name-help"');
    expect(converterView).toContain('className="field-help output-action-help output-action-danger field-help-hover" id="delete-source-help"');
    // 说明只是视觉收起，仍要在 DOM 里，否则 aria-describedby 断掉、读屏也拿不到。
    expect(converterView).toContain('aria-describedby="delete-source-help"');
  });
  it("uses one stack gap for every vertically stacked control group", () => {
    expect(tokensCss).toContain("--qp-stack-gap:");
    expect(converterCss).toMatch(/\.settings-module-body \{[^}]*gap: var\(--qp-stack-gap\)/);
    expect(converterCss).toMatch(/\.setting-group \{[^}]*gap: var\(--qp-stack-gap\)/);
    expect(converterCss).toMatch(/\.output-actions \{[^}]*gap: var\(--qp-stack-gap\)/);
    expect(converterCss).toMatch(/\.output-action \{[^}]*gap: var\(--qp-stack-gap\)/);
    // 短窗媒体查询里也不许再写死数字间距（曾出现 5px/6px/8px 三套，同一屏里对不齐）。
    expect(converterCss).not.toMatch(/\.(settings-module-body|setting-group|output-actions|output-action) \{[^}]*gap: \d/);
  });
  it("states the subfolder auto-create rule in the field instead of a separate note", () => {
    expect(converterView).toContain('placeholder="子文件夹不存在时会自动创建。"');
    expect(converterView).toContain('placeholder="目录不存在时会自动创建，支持绝对路径。"');
    // 输出位置不再挂常显说明（子文件夹/输出目录的规则都在占位符里），只剩错误提示参与 describedby。
    expect(converterView).not.toContain("output-location-help");
    expect(converterView).not.toContain("直接保存到源图片所在文件夹");
  });
  it("keeps converter helper text flush to the same left edge", () => {
    // 说明按开关宽度缩进会让它看起来属于勾选框、读起来割裂；一律与其它说明同一起点。
    expect(converterCss).toContain(".output-action-help {\n  line-height: 1.45;\n}");
    expect(converterCss).not.toContain("margin-left: 38px");
  });
  it("keeps the document itself unscrollable so the shell cannot slide out of the window", () => {
    expect(appCss).toMatch(/:root \{[^}]*overflow: hidden;/);
    expect(appCss).toMatch(/:root \{[^}]*overflow: clip;/);
    // 开关类复选框是绝对定位；没有定位祖先时会以初始包含块为基准逃出主滚动层，把文档撑高，一点就整页跑出窗口。
    expect(appShellCss).toMatch(/\.app-main \{[^}]*position: relative;/);
    expect(compressionCss).toMatch(/\.visually-hidden \{[^}]*top: 0;/);
    expect(compressionCss).toMatch(/\.visually-hidden \{[^}]*left: 0;/);
  });
  it("moves scrolling out of the shell into each page's content region", () => {
    // 外壳不再滚动：.app-main 只保留定位祖先与溢出裁剪，滚动下沉到页面内部。
    expect(appShellCss).toMatch(/\.app-main \{[^}]*position: relative;/);
    expect(appShellCss).toMatch(/\.app-main \{[^}]*overflow: hidden;/);
    expect(appShellCss).not.toMatch(/\.app-main \{[^}]*overflow: auto;/);
    // 页面根是撑满主区高度的弹性列：固定头部 + 可滚内容区。
    expect(appShellCss).toMatch(/\.page-view \{[^}]*display: flex;/);
    expect(appShellCss).toMatch(/\.page-view \{[^}]*flex-direction: column;/);
    expect(appShellCss).toMatch(/\.page-view \{[^}]*height: 100%;/);
    expect(appShellCss).toMatch(/\.page-view \{[^}]*min-height: 0;/);
    expect(appShellCss).toMatch(/\.page-header \{[^}]*flex: 0 0 auto;/);
    // 设置页内容区仍纵向滚动；关于页改为最外层不滚，纵向滚动下沉进内嵌更新视图的内容体。
    expect(settingsCss).toMatch(/\.settings-content \{[^}]*overflow-y: auto;/);
    expect(aboutCss).toMatch(/\.about-content \{[^}]*overflow: hidden;/);
    expect(aboutCss).not.toMatch(/\.about-content \{[^}]*overflow-y: auto;/);
    expect(updateCss).toMatch(/\.update-content-embedded \{[^}]*overflow-y: auto;/);
    // 设置卡片的列表类内容（配色方案色卡网格）在卡片内部滚，不下放给页面外层。
    expect(settingsCss).toMatch(/\.settings-color-scheme-list \{[^}]*overflow-y: auto;/);
    // 压缩页在双栏工作区下方还有参数摘要 / 预览 / 统计 / 结果区块，页面级内容区必须保留为唯一滚动层；GIF 页同理。
    expect(compressionCss).toMatch(/\.compression-content \{[^}]*overflow-y: auto;/);
    expect(gifCss).toMatch(/\.gif-maker-content\.page-content \{[^}]*overflow-y: auto;/);
    // 转换页再下沉一层：内容区只裁剪、不滚，纵向滚动进 02 / OUTPUT 输出设置卡片内部（见下条）。
    expect(converterCss).toMatch(/\.converter-content \{[^}]*overflow: hidden;/);
    expect(converterCss).not.toMatch(/\.converter-content \{[^}]*overflow-y: auto;/);
    // 两行页头固定在弹性列首，不随内容滚动。
    expect(converterCss).toMatch(/\.converter-header \{[^}]*flex: 0 0 auto;/);
    expect(compressionCss).toMatch(/\.compression-header \{[^}]*flex: 0 0 auto;/);
    expect(gifCss).toMatch(/\.gif-maker-header\.page-header \{[^}]*flex: 0 0 auto;/);
    // 这三页不在 .app-main 下（外壳包了一层自动高度的 .app-kept-view），由页面 CSS 让这层等高、页面根才撑满主区。
    // 必须带 :not([hidden])：否则与 App.css 的 .app-kept-view[hidden] 特异性相同而源序在后，会把 display:none 压掉。
    expect(converterCss).toMatch(/\.app-kept-view:has\(> \.converter-app\):not\(\[hidden\]\) \{[^}]*height: 100%;/);
    expect(compressionCss).toMatch(/\.app-kept-view\.app-kept-compression:not\(\[hidden\]\) \{[^}]*height: 100%;/);
  });
  it("sinks the converter scroll into the 02 / OUTPUT settings card", () => {
    // 转换页是撑满视口的双栏工作区：把页面级内容区的纵向滚动去掉，改由 02 / OUTPUT 输出设置卡片内滚，避免两个嵌套滚动条。
    expect(converterCss).toMatch(/\.converter-content \{[^}]*overflow: hidden;/);
    expect(converterCss).not.toMatch(/\.converter-content \{[^}]*overflow-y: auto;/);
    // 工作区两栏等高；行高锁到可用高度，卡片才有确定高度可内滚。
    expect(converterCss).toMatch(/\.workspace-grid \{[^}]*grid-template-rows: minmax\(0, 1fr\);/);
    // 输出设置卡片撑满行高并裁剪溢出；头部与底栏固定不缩。
    expect(converterCss).toMatch(/\.settings-panel \{[^}]*display: flex;/);
    expect(converterCss).toMatch(/\.settings-panel \{[^}]*flex-direction: column;/);
    expect(converterCss).toMatch(/\.settings-panel \{[^}]*min-height: 0;/);
    expect(converterCss).toMatch(/\.settings-panel \{[^}]*overflow: hidden;/);
    expect(converterCss).toMatch(/\.settings-panel > \.panel-heading,\n\.settings-panel > \.panel-footer \{[^}]*flex: 0 0 auto;/);
    // 滚动层仍在设置体，隐藏拖动条不能让窄窗展开控件失去访问途径。
    expect(converterCss).toMatch(/\.settings-stack \{[^}]*flex: 1 1 auto;/);
    expect(converterCss).toMatch(/\.settings-stack \{[^}]*min-height: 0;/);
    expect(converterCss).toMatch(/\.settings-stack \{[^}]*overflow-y: auto;/);
    expect(appCss).toMatch(/\* \{[^}]*scrollbar-width: none;/);
    expect(appCss).toContain("*::-webkit-scrollbar { display: none; }");
    for (const css of [converterCss, compressionCss, gifCss, settingsCss, aboutCss, updateCss, appShellCss]) {
      expect(css).not.toMatch(/scrollbar-(?:width|color)|::-webkit-scrollbar/);
    }
  });

  it("keeps every page header and card stack on the image-converter baseline", () => {
    // 基准全部取自图片转换页：固定页头 = min-height 34px + padding-bottom 10px + 1px token 底边线（合计 45px）；
    // 卡片间距 = 内层卡片栈 16px、外层两栏工作区 18px；页面外层内边距 = 20px 28px 18px、页头到内容 14px。
    // 转换/压缩页各在自己的页头类里声明，GIF/设置/关于共用壳层 .page-header；改基准必须五页同步。
    const assertHeaderBox = (selector: string, css: string) => {
      expect(css).toMatch(new RegExp(`${selector} \\{[^}]*min-height: 34px;`));
      expect(css).toMatch(new RegExp(`${selector} \\{[^}]*padding-bottom: 10px;`));
      expect(css).toMatch(new RegExp(`${selector} \\{[^}]*border-bottom: 1px solid var\\(--qp-border-subtle\\);`));
    };
    assertHeaderBox("\\.converter-header", converterCss);
    assertHeaderBox("\\.compression-header", compressionCss);
    assertHeaderBox("\\.page-header", appShellCss);
    // 三页的页头覆盖只许保留固定列首，不许再写回自己的高度 / 底边线 / 标题字号。
    // GIF 页头基规则只留固定列首：高度 / 内边距 / 底边线全部走壳层 .page-header，多写一条即在此失败。
    const gifBaseHeaderRule = gifCss.match(/\.gif-maker-header\.page-header \{[^}]*\}/)?.[0] ?? "";
    expect(gifBaseHeaderRule).toBe(".gif-maker-header.page-header { box-sizing: border-box; flex: 0 0 auto; margin-top: 0; }");
    expect(gifCss).not.toContain(".gif-maker-header h1 { font-size: 19px; }");
    expect(compressionCss).not.toMatch(/\.compression-header \{[^}]*padding: 0 2px/);
    // 页面外层内边距四页同值，并统一引用 spacing token。
    for (const [css, selector] of [
      [converterCss, "\\.converter-app"],
      [compressionCss, "\\.compression-app"],
      [gifCss, "\\.gif-maker-view\\.page-view"],
      [appShellCss, "\\.page-view"],
    ] as const) {
      expect(css).toMatch(new RegExp(`${selector} \\{[^}]*padding: var\\(--qp-space-page-block\\) var\\(--qp-space-page-inline\\) 18px;`));
    }
    expect(appShellCss).toMatch(/\.page-view \{[^}]*box-sizing: border-box;/);
    expect(appShellCss).toMatch(/\.page-header \{[^}]*box-sizing: border-box;/);
    expect(converterCss).toMatch(/\.converter-app \{[^}]*box-sizing: border-box;/);
    expect(compressionCss).toMatch(/\.compression-app \{[^}]*box-sizing: border-box;/);
    expect(converterCss).toMatch(/\.converter-header \{[^}]*box-sizing: border-box;/);
    expect(compressionCss).toMatch(/\.compression-header \{[^}]*box-sizing: border-box;/);
    expect(gifCss).toContain(".gif-maker-header.page-header { box-sizing: border-box; flex: 0 0 auto; margin-top: 0; }");
    expect(appShellCss).toMatch(/\.page-content \{[^}]*padding-top: 14px;/);
    // 内层卡片栈 16px（转换 .settings-stack / 压缩 .compression-settings-card / 设置·关于壳层 .page-content）。
    expect(converterCss).toMatch(/\.settings-stack \{[^}]*gap: 16px;/);
    expect(compressionCss).toMatch(/\.compression-settings-card \{[^}]*gap: 16px;/);
    expect(appShellCss).toMatch(/\.page-content \{[^}]*gap: 16px;/);
    // 外层两栏工作区 18px（转换 .workspace-grid / 压缩 .compression-grid / GIF .gif-workspace-grid）。
    expect(converterCss).toMatch(/\.workspace-grid \{[^}]*gap: 18px;/);
    expect(compressionCss).toMatch(/\.compression-grid \{[^}]*gap: 18px;/);
    expect(gifCss).toMatch(/\.gif-workspace-grid \{[^}]*gap: 18px;/);
    // 不许再退回各写一套的卡片间距。
    expect(compressionCss).not.toMatch(/\.compression-settings-card \{[^}]*gap: 15px;/);
    expect(gifCss).not.toMatch(/\.gif-workspace-grid \{[^}]*gap: 10px;/);
    // GIF 短窗口只收紧上下边距，不能把横向页边距压成 4px，避免页头横线变短。
    expect(gifCss).toContain(".gif-maker-view.page-view { padding: 4px var(--qp-space-page-inline); gap: 4px; }");
    expect(gifCss).not.toContain(".gif-maker-view.page-view { padding: 4px; gap: 4px; }");
    expect(compressionCss).not.toMatch(/\.compression-header \{[^}]*padding-top:/);
    expect(compressionCss).toContain(".compression-app { padding-top: 12px; padding-bottom: 12px; }");
    expect(gifCss).toContain(".gif-maker-view.page-view { padding-top: 12px; padding-bottom: 12px; }");
    expect(compressionCss).toContain(".compression-app { padding-top: 8px; padding-bottom: 8px; }");
  });

  it("sinks the converter's left column scroll into the preview card so its toolbar stays clickable", () => {
    // 左栏预览卡也撑满工作区行高、卡片内滚：没有内滚层时预览列（图 + 文件列表 + 那排按钮）溢出会被后绘制的
    // .converter-footer 盖住，「继续添加 / 导入文件夹 / 清空列表」在默认 1100×760 下点不到。
    expect(converterCss).toMatch(/\.preview-panel \{[^}]*display: flex;/);
    expect(converterCss).toMatch(/\.preview-panel \{[^}]*flex-direction: column;/);
    expect(converterCss).toMatch(/\.preview-panel \{[^}]*min-height: 0;/);
    expect(converterCss).toMatch(/\.preview-panel \{[^}]*overflow: hidden;/);
    expect(converterCss).toMatch(/\.preview-panel > \.panel-heading \{[^}]*flex: 0 0 auto;/);
    // 内滚层是 .preview-content：min-height 归零后才能收窄并保留纵向滚动。
    expect(converterCss).toMatch(/\.preview-content \{[^}]*min-height: 0;/);
    expect(converterCss).toMatch(/\.preview-content \{[^}]*flex: 1 1 auto;/);
    expect(converterCss).toMatch(/\.preview-content \{[^}]*overflow-y: auto;/);
    // 文件列表不能收缩成仅一行的独立滚动区，否则滚轮落在卡片其它位置时无法选后续图片。
    expect(converterCss).toMatch(/\.file-list \{[^}]*flex: 0 0 auto;/);
    expect(converterCss).not.toMatch(/\.file-list \{[^}]*overflow-y: auto;/);
    // 预览保留可辨认的面积，多出的高度由外层预览区滚动。
    expect(converterCss).toMatch(/\.preview-frame \{[^}]*flex: 1 0 120px;/);
    // 顶住内滚的固定下限必须消失，否则整列又被顶出卡片、按钮又被裁掉。
    expect(converterCss).not.toContain(".preview-content { min-height: 356px;");
    expect(converterCss).not.toMatch(/\.preview-frame \{[^}]*min-height: \d+px;/);
  });

  it("keeps the last converter module's hover hints from padding out the card's scroll bottom", () => {
    // 悬停说明是 opacity:0 的绝对定位浮层，收起态也参与布局：Chromium 会把它算进 .settings-stack 的滚动溢出区。
    // 最后一块折叠模块的说明若向下浮出，会在滚动内容底部垫出一整段看不见的空白（卡片滑到底看到的就是它）。
    // 最后一个模块的说明改向上开；滚动体自己保持零内边距，底部留白只由内容收尾，不靠固定像素去垫。
    expect(converterCss).toMatch(/\.settings-stack > \.settings-module:last-child \.field-help-hover \{[^}]*top: auto;/);
    expect(converterCss).toMatch(/\.settings-stack > \.settings-module:last-child \.field-help-hover \{[^}]*bottom: 100%;/);
    expect(converterCss).toMatch(/\.settings-stack \{[^}]*padding: 0;/);
    expect(converterCss).not.toMatch(/\.settings-stack \{[^}]*padding-bottom:/);
  });
  it("keeps the card's scroll position when a settings module is expanded", () => {
    // 展开/收起只切换 <details> 的 open，卡片(.settings-stack)的滚动位置不得改变。
    // 判据（结构/规则证据，无法在契约测试里跑真实布局）：
    // 1) 折叠处理只把 event.currentTarget.open 同步进 state，展开路径上没有任何 scrollIntoView / 写 scrollTop，
    //    也没有 autoFocus——三者都会触发浏览器的焦点/编程滚动（壳层为此外加 html{overflow:clip} 与 .app-main 定位祖先契约）。
    expect(converterView).not.toContain("scrollIntoView");
    expect(converterView).not.toContain("scrollTop");
    expect(converterView).not.toContain("autoFocus");
    expect(converterView).toMatch(/onToggle=\{\(event\) => setPixelSettingsOpen\(event\.currentTarget\.open\)\}/);
    expect(converterView).toMatch(/onToggle=\{\(event\) => setOutputSettingsOpen\(event\.currentTarget\.open\)\}/);
    // 2) 滚动体自己不得声明改变滚动位置的规则：scroll-behavior 会让展开后停在别处，
    //    overflow-anchor 会改写内容变化时的滚动锚点；滚动高度只由内容决定（零内边距才不会有底部留白）。
    const stackRule = converterCss.match(/\.settings-stack \{([^}]*)\}/)?.[1] ?? "";
    const stackDeclarations = stackRule.split(";").map((declaration) => declaration.trim()).filter(Boolean);
    const stackProperties = stackDeclarations.map((declaration) => declaration.split(":")[0].trim());
    expect(stackDeclarations).toContain("padding: 0");
    expect(stackProperties).not.toContain("padding-bottom");
    expect(stackProperties).not.toContain("scroll-behavior");
    expect(stackProperties).not.toContain("overflow-anchor");
  });
  it("wraps the compression import support hint inside narrow drop zones", () => {
    expect(compressionView).toContain('className="compression-drop-hint"');
    expect(compressionView).toContain('className={`drop-zone compression-drop-zone');
    expect(compressionView).toContain('className="drop-icon"');
    expect(compressionView).toContain('className="drop-zone-actions"');
    expect(compressionView).toContain('导入图片文件夹');
    expect(compressionView).toContain('className="file-list-toolbar compression-source-actions"');
    expect(compressionView).toContain('className="compression-list file-list"');
    expect(compressionView).toContain('className="compression-preview-inline"');
    expect(compressionView.indexOf('className="compression-preview-inline"')).toBeLessThan(compressionView.indexOf('className="file-list-toolbar compression-source-actions"'));
    expect(compressionView.indexOf('className="file-list-toolbar compression-source-actions"')).toBeLessThan(compressionView.indexOf('className="compression-list file-list"'));
    expect(compressionView).not.toContain('className="compression-card compression-preview-card"');
    expect(compressionView).toContain("{items.length === 0 ? <div");
    expect(compressionView).toContain("items.length > 0 ? <>\n          <div className=\"file-list-toolbar");
    expect(compressionView).toContain("compression-card-dragging");
    expect(compressionCss).toContain(".compression-card-dragging { border-color: var(--qp-accent-default); background: var(--qp-accent-muted); }");
    expect(compressionCss).toContain(".compression-drop-hint { max-width: 100%; }");
    expect(compressionCss).toContain("overflow-wrap: anywhere;");
    expect(compressionCss).not.toContain(".compression-drop-zone { margin-top:");
    expect(compressionCss).not.toContain(".compression-drop-zone { min-height:");
    expect(compressionCss).not.toContain(".compression-input-card, .compression-settings-card { padding:");
  });
  it("exposes a copyable compression batch summary without changing native wiring", () => {
    expect(compressionView).toContain("formatCompressionBatchSummary");
    expect(compressionView).toContain("复制批处理摘要");
    expect(compressionView).toContain("disabled={resultStats.total === 0}");
    expect(compressionView).toContain("下载 JSON 报告");
    expect(compressionView).toContain("createCompressionBatchReport");
  });
  it("exposes per-item retry only for retryable result states", () => {
    expect(compressionView).toContain('result.itemId && (result.status === "failed" || result.status === "skipped")');
    expect(compressionView).toContain("runCompression([result.itemId as string])");
    expect(compressionView).toContain("仅重试此项");
  });
  it("exposes a GIF export report only after an export path exists", () => {
    expect(gifView).toContain("createGifExportReport");
    expect(gifView).toContain("下载 JSON 报告");
    expect(gifView).toContain("打开文件夹");
    expect(gifView).toContain("复制路径");
    expect(gifView).toContain("openLastExportFolder");
    expect(gifView).toContain("copyLastExportPath");
    expect(gifView).toContain("{lastExportPath ? <div className=\"gif-output-actions\"");
    expect(gifCss).toContain(".gif-output-actions { display: flex; flex-wrap: wrap;");
  });
  it("describes image converter metadata preserve as a constrained passthrough", () => {
    expect(converterView).toContain('aria-describedby="converter-metadata-policy-help"');
    expect(converterView).toContain("清理元数据（推荐）");
    expect(converterView).toContain('id="converter-metadata-policy-help"');
    expect(converterView).toContain("关闭时仅尝试同格式、原尺寸、无裁剪旋转和无水印的原始字节直通");
    expect(converterView).not.toContain("关闭后默认清理 EXIF/ICC");
  });
  it("associates compression metadata policy with its constraints", () => {
    expect(compressionView).toContain('describedBy="compression-metadata-policy-help"');
    expect(compressionView).toContain('id="compression-metadata-policy-help"');
    expect(compressionView).toContain("仅允许同格式静态 PNG/JPEG/WebP；输出原字节，不应用压缩、缩放或目标体积参数。");
  });
  it("clears stale GIF export actions when export inputs change", () => {
    expect(gifView).toContain("setExportFrameSummary(null);\n    setLastExportPath(null);");
    expect(gifView).toContain("const invalidateGifExportResults = () => {");
    expect(gifView).toContain("invalidateGifExportResults();\n    if (!isVideoFile(file))");
    expect(gifView).toContain("invalidateGifExportResults();\n    const imageFiles = inputFiles.filter(isImageFile);");
  });
  it("clears stale compression preflight space when inputs or options change", () => {
    expect(compressionView).toContain("setPreflightSpaceBytes(null);");
    expect(compressionView).toMatch(/\[items, options, selectedItemId\]/);
  });
  it("keeps strip-safe metadata pending until validation completes", () => {
    expect(compressionView).toContain("useState<{ format: CompressionFormat; items: Array<Pick<CompressionItem, \"id\" | \"file\">>; valid: boolean | null } | null>(null)");
    expect(compressionView).toContain("setStripSafeInputValidation({ format, items: stripSafeValidationItems, valid: null });");
    expect(compressionView).toContain("getCurrentStripSafeValidation(stripSafeInputValidation, format, stripSafeValidationItems)");
    expect(compressionView).toContain("stripSafeInputVerified === true");
    expect(compressionView).toContain('(metadataPolicy === "stripSafe" || metadataPolicy === "preserve") && stripSafeInputVerified === false');
    expect(compressionView).toContain("setStripSafeInputValidation({ format, items: stripSafeValidationItems, valid: errors.every((error) => error === null) });");
    expect(compressionView).toContain("isCurrentStripSafeValidation(stripSafeInputValidation, format, stripSafeValidationItems)");
  });
  it("blocks native preview and estimate while strip-safe validation is pending", () => {
    expect(compressionView).toContain('options.metadataPolicy === "stripSafe" && stripSafeInputVerified !== true');
    expect(compressionView).toContain("正在校验安全清理输入");
    expect(compressionView).toContain("校验完成后生成预览");
    expect(compressionView).toMatch(/\[active, busy, items, options, selectedItem, stripSafeInputVerified\]/);
    expect(compressionView).toContain("const stripSafeValidationItems = useMemo");
  });

  it("passes JPEG background only when JPEG is the selected output format", () => {
    expect(compressionView).toContain('jpegBackground: format === "jpg" ? jpegBackground : undefined');
  });
  it("normalizes both LF and CRLF source checkouts before matching contracts", () => {
    expect(".a\r\n.b\r.c\n".replace(/\r\n?/g, "\n")).toBe(".a\n.b\n.c\n");
  });

  it.each(VIEWPORT_MATRIX)("defines a deterministic contract for $name ($width×$height)", ({ width, height }) => {
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(gifCss).toContain("overflow-x: hidden");
    expect(gifCss).toContain(".gif-canvas-stage { min-height: 132px;");
    expect(converterCss).toMatch(/\.converter-app\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*none;/s);
    expect(converterCss).toContain("overflow-x: hidden;");
    // 左栏预览卡改成卡片内滚后不再有固定高度下限；改锁内滚层的盒模型（同一组取值四页共用）。
    expect(converterCss).toContain(".preview-content {\n  display: flex;\n  min-height: 0;");
    expect(compressionCss).toMatch(/\.compression-app\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*none;/s);
    expect(compressionCss).toContain("overflow-x: hidden;");
    expect(converterCss).toContain("@media (max-width: 620px)");
    expect(themeSelectCss).toContain(".theme-select-option:focus-visible");
  });

  it.each(CONTENT_CONTAINER_MATRIX)("keeps $name content containers scrollable at $width×$height", ({ width, height, expanded }) => {
    expect(gifCss).toContain(".gif-maker-content { container: gif-maker / inline-size; }");
    expect(aboutCss).toContain("container: about-page / inline-size;");
    if (width <= 760) {
      expect(gifCss).toContain("@container gif-maker (max-width: 760px)");
      expect(aboutCss).toContain("@container about-page (max-width: 760px)");
    }
    if (height < 636) {
      expect(gifCss).toContain("@media (max-height: 620px)");
      expect(aboutCss).toContain("@media (max-height: 620px)");
    }
    if (expanded) {
      expect(compressionCss).toMatch(/\.compression-settings-card \{[^}]*min-height: 0;/);
      expect(compressionCss).toMatch(/\.compression-settings-card \{[^}]*overflow-y: auto;/);
      expect(gifCss).toMatch(/\.gif-settings-card \{[^}]*overflow-y: auto;/);
      expect(gifCss).toContain(".gif-maker-view.gif-settings-expanded");
    }
  });

  it("covers the requested portrait and narrow-tall viewport safeguards", () => {
    expect(VIEWPORT_MATRIX).toEqual(expect.arrayContaining([
      { name: "minimum window", width: 900, height: 636 },
      { name: "narrow tall", width: 900, height: 1100 },
      { name: "regular desktop", width: 1280, height: 800 },
    ]));
    // 短窗规则保留，窄窗条件已被最小宽度取代
    expect(gifCss).toContain("@media (max-height: 620px)");
    expect(gifCss).toContain("@media (min-height: 621px) and (max-height: 760px)");
    expect(gifCss).toContain(".gif-maker-view > .gif-export-footer { position: sticky;");
    expect(compressionCss).toContain("overflow-wrap: anywhere;");
  });

  it("keeps export and cancellation controls represented in both workspaces", () => {
    expect(gifView).toContain("gif-export-button");
    expect(gifView).toContain("cancelVideoExtraction");
    expect(gifView).toContain("getGifCancelButtonLabel");
    expect(converterView).toContain("export-button");
    expect(converterView).toContain("requestExportCancel");
    expect(converterView).toContain("if (status.kind === \"busy\") return;");
    expect(converterView).toContain("disabled={status.kind === \"busy\"}");
    expect(gifView).toContain("pendingRef.current > 0 || status.kind === \"exporting\"");
    expect(converterView).toContain("导入图片文件夹");
    expect(converterCss).toContain(".directory-import-button");
    expect(converterCss).toContain(".drop-zone-actions");
    expect(gifView).toContain("保存工作区");
    expect(converterView).toContain("打开工作区");
    expect(gifView).toContain("gif-status-${status.kind}");
    expect(gifView).toContain("formatGifExportProgress");
    expect(gifView).toContain("aria-valuetext={`第 ${selectedIndex + 1} / ${frames.length} 帧`}");
    expect(gifView).toContain('role={gifExportProgress && status.kind === "exporting" ? "progressbar" : "status"}');
    expect(gifView).toContain("aria-valuenow={gifExportProgress && status.kind === \"exporting\" ? exportProgressCurrent : undefined}");
    expect(gifView).toContain("const exportProgressCurrent = Math.min(Math.max");
    expect(gifView).toContain("setSourceMode(\"video\")");
    expect(gifView).toContain("选择视频");
    expect(converterView).toContain("export-progress-panel");
    expect(converterView).toContain("const clearExportResults = () =>");
    expect(converterView).toContain("clearExportResults();");
    expect(converterView).toContain("setExportOutputPaths([]);");
    expect(converterView).toContain("setExportPreflight(null);");
    expect(converterView).toContain("setNativePreflightStatus(null);");
    expect(converterView).toContain('if (status.kind === "busy") return;');
  });

  it("keeps the compression workbench wired into navigation and busy guards", () => {
    expect(appShell).toContain('id: "compression"');
    expect(compressionView).toContain("导入文件夹");
    expect(compressionView).toContain("重试失败项");
    expect(compressionView).toContain("aria-live=\"polite\"");
    expect(compressionView).toContain("disabled={busy}");
    expect(compressionView).toContain("当前浏览器预览仅支持编辑参数和估算大小");
    expect(compressionView).toContain("getCompressionSourcePathError");
    expect(compressionView).toContain('role="progressbar"');
    expect(compressionView).toContain("aria-valuetext={progress.total > 0");
    expect(compressionView).toContain("formatCompressionProgressSummary");
    expect(compressionView).toContain("totalInputBytes: resultStats.inputBytes");
    expect(compressionView).toContain("setCustomResizeActive(false); setTargetResizePercent(null); setPreset(\"custom\"); return;");
    expect(compressionView).toContain('className="compression-estimate-note" aria-live="polite"');
    expect(compressionView).toContain("isCompressionSourcePathError");
    expect(compressionView).toContain("桌面源文件不可访问，未导出");
    expect(compressionView).toContain("源文件夹子目录");
    expect(compressionView).toContain("成功、跳过和节省统计");
    expect(compressionView).toContain("result.status === \"skipped\"");
    expect(compressionView).toContain("skippedReason");
    expect(compressionView).toContain("真实压缩预览");
    expect(compressionView).toContain("复制输出路径");
    expect(compressionView).toContain("打开输出文件夹");
    expect(compressionView).toContain("当前文件：");
    expect(compressionView).toContain("复制失败详情");
    expect(compressionView).toContain("formatCompressionFailureDetails");
    expect(compressionView).toContain("estimateImageCompression");
    expect(compressionView).toContain("estimateRequestIdRef");
    expect(compressionView).toContain("isCurrentCompressionEstimate");
    expect(compressionView).toContain("原生精确预估");
    expect(compressionView).toContain("formatCompressionEstimateSource");
    expect(compressionView).toContain("逐项结果");
    expect(compressionView).toContain("getCompressionItemResultMetrics");
    expect(compressionView).toContain("原图 ${formatCompressionBytes(metrics.inputBytes)}");
    expect(compressionView).toContain('result.status === "skipped" ? "候选" : "输出"');
    expect(compressionView).toContain("节省");
    expect(compressionView).toContain("增加");
    expect(compressionView).toContain("formatCompressionItemResultStatus");
    expect(compressionView).toContain("getSuccessfulCompressionOutputPath");
    expect(compressionView).toContain("revealImageOutput");
    expect(compressionView).toContain("loadCompressionPreferences");
    expect(compressionView).toContain("saveCompressionPreferences");
    expect(compressionPreferences).toContain("COMPRESSION_PREFERENCES_VERSION = 3");
    expect(compressionPreferences).not.toContain("outputDirectory");
    expect(compressionPreferences).not.toContain("sourcePath");
    expect(compressionView).toContain("AbortController");
    expect(compressionView).toContain("最大输出体积（JPEG/WebP 有损）");
    expect(compressionView).toContain("getCompressionTargetSizeError");
    expect(compressionView).toContain("启用目标体积控制");
    expect(compressionView).toContain("压缩后更大时跳过");
    expect(compressionView).toContain("风险模式：压缩结果可能比原图更大");
    expect(compressionView).toContain("skipIfLarger");
    expect(compressionView).toContain("覆盖原图并备份到 bak");
    expect(compressionView).toContain("formatCompressionReplaceOriginalConfirmation");
    expect(compressionView).toContain("window.confirm");
    expect(compressionView).toContain("formatCompressionDeleteSourceConfirmation");
    expect(compressionView).toContain("deleteSourceAvailable");
    expect(compressionView).toContain("!replaceOriginalAvailable");
    expect(compressionView).toContain('disabled={encodingOptionDisabled || !qualityEnabled}');
    expect(compressionView).toContain('{targetSizeActive ? <label className="compression-field"><span className="compression-label-row"><span>最大输出体积（JPEG/WebP 有损）');
    expect(compressionView).toContain("{replaceOriginal ? null :");
    expect(compressionView).toContain('const encodingOptionDisabled = busy || metadataPreserveActive;');
    expect(compressionView).toContain("maxCandidates: !metadataPreserveActive && maxOutputBytes ? maxCandidates : undefined");
    expect(compressionView).toContain("selectedQuality");
    expect(compressionView).toContain("PNG 优化级别");
    expect(compressionView).toContain("PNG 透明像素优化");
    expect(compressionView).toContain("pngOptimizeAlpha");
    expect(compressionView).toContain("pngOptimizationLevel");
    expect(compressionView).toContain("内置预设");
    expect(compressionView).toContain("恢复平衡默认");
    expect(compressionView).toContain("disabled={busy}");
    expect(compressionView).toContain("DEFAULT_COMPRESSION_PREFERENCES.format");
    expect(compressionView).toContain("setWebpPass(DEFAULT_COMPRESSION_PREFERENCES.webpPass)");
    expect(compressionView).toContain("setPngOptimizeAlpha(DEFAULT_COMPRESSION_PREFERENCES.pngOptimizeAlpha)");
    expect(compressionView).toContain("setJpegBackground(DEFAULT_COMPRESSION_PREFERENCES.jpegBackground)");
    expect(compressionView).toContain("setMetadataPolicy(DEFAULT_COMPRESSION_PREFERENCES.metadataPolicy)");
    expect(compressionView).toContain("保存当前参数");
    expect(compressionView).toContain("导出 JSON");
    expect(compressionView).toContain("导入 JSON");
    expect(compressionView).toContain("loadCompressionCustomPresets");
    expect(compressionView).toContain("importCompressionPresetsJson");
    expect(compressionCss).toContain(".compression-balanced-reset { align-self: start; justify-self: start; }");
    expect(compressionView).toContain('{format === "webp" ? <label className="compression-check"><input type="checkbox" checked={lossless}');
    expect(compressionView).toContain("当前为有损 WebP；质量滑块控制编码质量");
    expect(compressionView).toContain("核心最多尝试 ${maxCandidates} 个 WebP 质量候选");
    expect(compressionView).toContain("WebP 无损编码");
    expect(compressionView).toContain("WebP 编码方法");
    expect(compressionView).toContain("webpMethod");
    expect(compressionView).toContain("Alpha 质量 ${webpAlphaQuality}");
    expect(compressionView).toContain("分析遍数 ${webpPass}");
    expect(compressionView).toContain("compression-webp-method-hint");
    expect(compressionView).toContain('{webpLossyActive ? <label className="compression-field"><span className="compression-label-row"><span>WebP 编码方法');
    expect(compressionPreferences).toContain("webpMethod");
    expect(compressionPreferences).toContain("webpPass");
    expect(compressionPreferences).toContain("skipIfLarger");
    expect(compressionView).toContain("保留原始元数据（原字节透传）");
    expect(compressionView).toContain("全部清理会移除可识别的元数据");
    expect(compressionView).toContain("全部清理元数据");
    expect(compressionView).toContain('format === "webp" ? "WebP" : "PNG"');
    expect(compressionView).toContain("保留结构合法且有界的 ICC payload");
    expect(compressionView).toContain('<details className="compression-advanced-settings">');
    expect(compressionView).toContain("<strong>预设管理</strong>");
    expect(compressionView).toContain("<strong>编码细节</strong>");
    expect(compressionView).toContain("<strong>目标体积</strong>");
    expect(compressionView).toContain("<strong>输入与跳过</strong>");
    expect(compressionView).toContain("<strong>输出与元数据</strong>");
    expect(compressionView).toContain("compression-advanced-settings-body");
    expect(compressionView).toContain('className="compression-parameter-issues"');
    // 可见区只保留预设、格式、质量与缩放，其余参数收进对应分组。
    expect(compressionView.indexOf("质量（JPEG/WebP 有损）")).toBeLessThan(compressionView.indexOf("<strong>编码细节</strong>"));
    expect(compressionView.indexOf("启用目标体积控制")).toBeGreaterThan(compressionView.indexOf("<strong>目标体积</strong>"));
    expect(compressionView.indexOf("允许覆盖同名文件")).toBeGreaterThan(compressionView.indexOf("<strong>输出与元数据</strong>"));
    expect(compressionView).toContain("{lossyQualityVisible ?");
    expect(compressionView).toContain('{targetSizeVisible ? <details className="compression-advanced-settings">');
    expect(compressionView).toContain("{replaceOriginal ? null : <CompressionSelectField");
    expect(compressionView).toContain('id="compression-output-location"');
    expect(compressionView).toContain("formatCompressionProgressError");
    expect(compressionView).toContain("const progressError = formatCompressionProgressError(next);");
    expect(compressionView).toContain("const sourceBusy = busy || importBusy;");
    expect(compressionView).toContain("清空");
    expect(compressionView).toContain("替换当前");
    expect(compressionView).toContain("replaceItemIdRef");
    expect(compressionView).toContain("仅使用所选文件中的第一张");
    expect(compressionView).toContain("getCompressionInputFormat(item.file)");
    expect(compressionView).toContain("item.dimensions.width");
    expect(compressionView).toContain("compression-import-errors");
    expect(compressionView).toContain("读取失败或被文件夹扫描跳过");
    expect(compressionView).toContain("pickCompressionDirectoryResult");
    expect(compressionView).toContain("compression-item-select");
    expect(compressionView).toContain('<strong title={item.file.name}>{item.file.name}</strong>');
    expect(compressionView).toContain("event.preventDefault(); void chooseFiles()");
    expect(compressionView).toContain("setResultStats({ total: 0, succeeded: 0, skipped: 0, failed: 0");
    expect(compressionView).toContain("setFailures([]);");
    expect(compressionCss).toContain(".compression-preview-grid");
    expect(compressionView).toContain("compression-preview-compare");
    expect(compressionView).toContain("原图与压缩结果分界位置");
    expect(compressionView).toContain("aria-valuetext={`${previewSplit}% 原图与压缩结果分界`}");
    expect(compressionCss).toContain(".compression-preview-compare-divider");
    expect(compressionCss).toContain(".compression-preview-compare-range input:focus-visible");
    expect(compressionView).toContain("hasPointerCapture(event.pointerId)");
    expect(compressionView).toContain("onDragStart={(event) => event.preventDefault()}");
    expect(compressionView).toContain("draggable={false}");
    expect(compressionView).toContain("Math.max(0, Math.min(100");
    expect(compressionView).toContain('className="compression-preview-compare-range visually-hidden"');
    expect(compressionCss).toContain("touch-action: none");
    expect(compressionCss).toContain("cursor: ew-resize");
    expect(compressionView).toContain("同名目标会拒绝写入");
    expect(compressionView).toContain("自动序号避免重名");
    expect(compressionView).toContain("autoNumbering");
    expect(compressionView).toContain("outputFileName");
    expect(compressionView).toContain("getCompressionOutputFileNameError");
    expect(compressionView).toContain("normalizeCompressionOutputFileName");
    expect(compressionView).toContain("compression-output-file-name-hint");
    expect(compressionGateway).toContain("autoSequence");
    expect(compressionView).toContain("输出位置仍按上方设置");
    expect(compressionCss).toContain(".compression-progress");
    expect(compressionCss).toContain("@media (max-height: 620px)");
    expect(compressionCss).toContain(".compression-status > span { min-width: 0;");
    expect(compressionCss).toContain(".compression-clear-button:focus-visible");
    expect(compressionCss).toContain(".compression-import-errors");
    expect(compressionCss).toContain(".compression-output-actions");
    expect(compressionView).toContain("successfulOutputPaths.length > 1");
    expect(compressionView).toContain("copyAllOutputPaths");
    expect(compressionView).toContain("setSuccessfulOutputPaths([])");
    expect(compressionView).toContain("没有可导入的图片；请检查格式");
    expect(compressionCss).toContain(".compression-current-file");
    expect(compressionView).toContain('className="compression-current-file" aria-live="polite" title={currentFileName ?? undefined}');
    expect(compressionCss).toContain(".compression-failure-details");
    expect(compressionCss).toContain(".compression-item-results");
    expect(compressionCss).toContain(".compression-item-result-actions");
    expect(compressionCss).toContain(".compression-custom-presets");
    expect(compressionCss).toContain(".compression-preset-actions");
    expect(compressionCss).toContain(".compression-preset-message");
    expect(compressionCss).toContain(".compression-estimate-note");
    expect(compressionCss).toContain(".compression-check span { display: grid; min-width: 0;");
    expect(compressionCss).toContain(".compression-webp-method-hint");
    expect(compressionCss).toContain(".compression-output-file-name-hint");
    expect(compressionCss).toContain(".compression-advanced-settings {\n  min-width: 0;\n  grid-column: 1 / -1;\n  border: 1px solid var(--qp-border-subtle);\n  border-radius: var(--qp-radius-control);\n  background: var(--qp-bg-elevated);\n}");
    expect(compressionCss).toContain(".compression-advanced-settings > summary:focus-visible");
    expect(compressionCss).toContain('.compression-advanced-settings > summary::after { flex: 0 0 auto; color: var(--qp-text-tertiary); content: "+";');
    expect(compressionCss).toContain(".compression-advanced-settings-body { display: grid; min-width: 0;");
    expect(compressionCss).toContain(".compression-skip-larger-warning");
  });

  it("keeps compression state mounted while navigation only toggles visibility", () => {
    expect(appShell).toContain('<div className="app-kept-view app-kept-compression" hidden={view !== "compression"}>');
    expect(appShell).toContain("const LazyImageCompressionView = lazy(() => import(\"../features/image-compression/ImageCompressionView\"))");
    expect(appShell).toContain("const LazyGifMakerView = lazy(() => import(\"../features/gif-maker/GifMakerView\"))");
    expect(appShell).not.toContain('import ImageCompressionView from "../features/image-compression/ImageCompressionView"');
    expect(appShell).not.toContain('import GifMakerView from "../features/gif-maker/GifMakerView"');
    expect(appShell).toContain("const [mountedViews, setMountedViews]");
    expect(appShell).toContain("{mountedViews.compression ? <LazyImageCompressionView active={view === \"compression\"} /> : null}");
    expect(appShell).toContain("{mountedViews.gif ? <LazyGifMakerView active={view === \"gif\"} /> : null}");
    expect(appShell).not.toContain('{view === "compression" ? <ImageCompressionView');
    expect(appShell).toContain("setMountedViews((current) => current[view] ? current : { ...current, [view]: true })");
    expect(appShell).toContain("<Suspense fallback=");
    expect(appShell).toContain("app-view-loading");
    expect(compressionView).toContain('if (!active || items.length === 0)');
    expect(compressionView).toContain('if (busy) {');
    expect(compressionView).toContain('}, [active, busy, options, selectedItem, stripSafeInputVerified]);');
    expect(compressionView).toContain('const sourceBusy = busy || importBusy;');
  });

  it("keeps compression export parameters visible in a wrapping summary", () => {
    expect(compressionView).toContain('aria-label="导出参数摘要"');
    expect(compressionView).toContain("compressionParameterSummary");
    expect(compressionView.indexOf('className="compression-parameter-summary"')).toBeGreaterThan(compressionView.indexOf('className="compression-header"'));
    expect(compressionView.indexOf('className="compression-parameter-summary"')).toBeLessThan(compressionView.indexOf('className="compression-grid"'));
    expect(compressionView).toContain("getCompressionAlphaHandling");
    expect(compressionView).toContain('className="compression-alpha-status"');
    expect(compressionView).toContain('aria-label="复制当前压缩参数摘要"');
    expect(compressionView).toContain("formatCompressionParameterSummary");
    expect(compressionView).not.toContain("预览实际元数据策略");
    expect(compressionView).not.toContain("估算实际元数据策略");
    expect(compressionCss).toContain(".compression-parameter-summary { box-sizing: border-box; display: flex;");
    expect(compressionCss).toContain("padding: 3px 8px;");
    expect(compressionCss).toContain("height: 34px;");
    expect(compressionCss).toContain("align-items: center;");
    expect(compressionCss).toContain("box-sizing: border-box;");
    expect(compressionCss).toContain("min-height: 24px; height: 24px;");
    expect(compressionCss).toContain("margin-top: 0;");
    expect(compressionCss).toContain("overflow: hidden;");
    expect(compressionCss).toContain("overflow-wrap: anywhere;");
    expect(compressionCss).toContain(".compression-alpha-status { display: flex;");
    expect(compressionCss).toContain("overflow-wrap: anywhere");
  });

  it("keeps batch cancellation, retry, and source-list transitions explicit", () => {
    expect(compressionView).toContain('const queue = getCompressionRetryQueue(items, retryItemIds ?? failures);');
    expect(compressionView).toContain('getCompressionCancelledItemResults(queue, index)');
    expect(compressionView).toContain('const finalState = getCompressionBatchFinalState(failedNames, cancelRequestedRef.current);');
    expect(compressionView).toContain('const merged = mergeCompressionItems(items, next, replaceItemId);');
    expect(compressionView).toContain('const nextItems = removeCompressionItem(items, id);');
    expect(compressionView).toContain('void cancelActiveCompression();');
    expect(compressionView).toContain('重试失败项');
    expect(compressionView).toContain("其余文件未处理，可点击“重试失败项”继续");
    const nativeImportStart = compressionView.indexOf("const importNativeFiles");
    const nativeImportEnd = compressionView.indexOf("const chooseFiles", nativeImportStart);
    const nativeImportSource = compressionView.slice(nativeImportStart, nativeImportEnd);
    expect(nativeImportSource).toContain("setFailures([]);");
    expect(nativeImportSource).toContain("setFailureDetails([]);");
    expect(nativeImportSource).toContain("setItemResults([]);");
  });

  it("invalidates stale image export preflight when request parameters change", () => {
    expect(converterView).toContain("setExportPreflight(null);");
    expect(converterView).toContain("setNativePreflightStatus(null);");
    expect(converterView).toMatch(/\[bitDepth, deleteSource, file, fileNameTemplate, height, imageTransform, keepAspectRatio, loadedImages, outputDirectory, outputLocation, outputSubdirectory, outputFormat, overwriteSameName, width\]/);
    // 重复目标自动编号已下线：不要再出现开关或状态（重复目标改为在示例目标行直接报出来）。
    expect(converterView).not.toContain("重复目标自动编号");
    expect(converterView).not.toContain("setAutoSequence");
    expect(converterView).toContain("setActualExportResult(null);");
  });

  it("keeps GIF interaction modules, multiselect, and batch duration controls represented", () => {
    expect(gifView).toContain("素材帧");
    expect(gifView).toContain("动画预览");
    expect(gifView).toContain("画布");
    expect(gifView).toContain("帧时长");
    expect(gifView).toContain("导出设置");
    expect(gifView).toContain("selectedFrameIndices");
    expect(gifView).toContain("批量设置选中帧时长");
    expect(gifView).toContain("恢复平衡默认");
    expect(gifView).toContain("disabled={!canEditFrames}");
    expect(gifView).toContain("DEFAULT_GIF_MAKER_PREFERENCES.targetSizeKiB");
  });

  it("does not reintroduce a horizontal scrolling frame list", () => {
    expect(gifCss).not.toMatch(/\.gif-frame-list \{[^}]*overflow-x: auto;/s);
    expect(gifCss).toContain(".gif-frame-meta small { min-width: 0; overflow: hidden;");
    expect(gifView).toContain('<strong title={frame.name}>{frame.name}</strong>');
    expect(gifCss).toMatch(/\.gif-balanced-reset \{[^}]*align-self: start;[^}]*justify-self: start;/s);
    expect(gifView).toContain('className="quiet-button gif-busy-cancel"');
  });

  it("keeps one target, limit, and compression control per output-format branch", () => {
    expect((gifView.match(/<span>目标文件大小<\/span>/g) ?? []).length).toBe(3);
    expect((gifView.match(/<span>最大文件大小<\/span>/g) ?? []).length).toBe(3);
    expect((gifView.match(/<strong>自动压缩到目标大小<\/strong>/g) ?? []).length).toBe(3);
    expect(gifView).toContain("WebP/APNG 动图使用当前画布和帧时长导出");
    expect(gifView).toContain("PNG 帧序列按当前画布逐帧输出 PNG");
    expect(gifView).toContain("仅调用原生规划，不会修改参数或自动压缩正式导出");
  });

  it("keeps focus styling and text wrapping explicit for narrow and short windows", () => {
    expect(gifCss).toContain(":focus-visible");
    expect(gifCss).toContain("overflow-wrap: anywhere");
    expect(gifCss).toContain("flex-wrap: wrap");
    expect(converterCss).toContain(":focus-visible");
    expect(converterCss).toContain("overflow-wrap: anywhere");
    expect(converterCss).toContain("overflow-x: hidden;");
  });

  it("keeps resource cleanup and failed-item retry paths explicit", () => {
    expect(converterView).toContain("URL.revokeObjectURL(realPreviewUrlRef.current)");
    expect(converterView).toContain("loadedImagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl))");
    expect(converterView).toContain("仅重试失败项");
    expect(converterView).toContain("暂停队列");
    expect(converterView).toContain("继续导出");
    expect(converterView).toContain("原子导出不会被中断");
    expect(gifView).toContain("framesRef.current.forEach((frame) => URL.revokeObjectURL(frame.previewUrl))");
    expect(gifView).toContain("videoImportRequestRef.current += 1");
    expect(gifView).toContain("setSelectedFrameIndices(new Set());");
    expect(gifView).toContain("正在取消导出");
    expect(converterView).toContain("if (!active || !file || !dimensions");
  });

  it("does not rely on undefined utility classes for visible GIF labels", () => {
    // 仓库里没有定义 .sr-only：挂在标签上只会让标签照常显示，而下次谁补一个全局工具类就会让标签凭空消失。
    expect(gifView).not.toContain("sr-only");
    expect(gifCss).toContain(".gif-dimensions-row label > span { white-space: nowrap; }");
  });
  it("re-measures the dropdown after it has a real width", () => {
    // 首次落位时浮层宽度为 0，量到的高度是折行后的结果，必须靠观察器在真实排版后再量一次，否则上翻会浮空。
    expect(themeSelectSource).toContain("new ResizeObserver(placeList)");
    expect(themeSelectSource).toContain("list?.offsetHeight");
  });
  it("keeps custom dropdowns in a viewport overlay independent of card clipping", () => {
    expect(themeSelectCss).toContain("position: fixed;");
    expect(themeSelectCss).toContain("max-height: 240px;");
    expect(themeSelectCss).toContain("overflow-y: auto;");
  });
  it("keeps expanded GIF settings in the page scroll flow", () => {
    expect(gifCss).toMatch(/\.gif-maker-view\.gif-settings-expanded \.gif-settings-card \{\s*max-height: none;\s*overflow: visible;/s);
    // 展开设置时内容区仍是滚动容器：只让工作区按内容自然撑高，不再把整页改回滚动。
    expect(gifCss).toMatch(/\.gif-maker-view\.gif-settings-expanded \.gif-workspace-grid \{\s*flex: 0 0 auto;\s*min-height: 300px;/s);
    expect(gifCss).not.toMatch(/\.gif-maker-view\.gif-settings-expanded \.gif-maker-content\.page-content \{\s*flex: 0 0 auto;/s);
  });
  it("raises the expanded GIF settings card above the frame workspace", () => {
    expect(gifCss).toContain(".gif-maker-view.gif-settings-expanded > .gif-settings-card { position: relative; z-index: 4; }");
  });

  it("preserves preview space when expanded settings exceed the window height", () => {
    expect(gifCss).toMatch(/\.gif-maker-view\.gif-settings-expanded \.gif-workspace-grid \{\s*flex: 0 0 auto;\s*min-height: 300px;/s);
    expect(gifView).toContain('gif-settings-expanded');
    expect(gifCss).toContain('.gif-maker-view.gif-settings-expanded > .gif-export-footer { position: static; }');
  });
  it("keeps GIF header workspace actions visible on narrow windows", () => {
    expect(gifView).toContain("title={`${videoSource.name} · ${videoSource.width} × ${videoSource.height} px`}");
  });

  it("keeps GIF parameter summary copy action available and compact", () => {
    expect(gifView).toContain("copyExportParameterSummary");
    expect(gifView).toContain("复制 GIF 导出参数摘要");
    expect(gifView).toContain('setError(null);\n      setStatus({ kind: "success", text: "导出参数已复制" });');
    expect(gifCss).toContain(".gif-copy-parameter-summary");
  });

  it("does not compress narrow short GIF cards below readable content height", () => {
    expect(gifCss).not.toContain("grid-template-rows: minmax(96px, .85fr) minmax(96px, 1.15fr)");
    expect(gifCss).toContain(".gif-assets-card,");
    expect(gifCss).toContain(".gif-preview-card,");
  });

  it("keeps GIF drag and drop isolated from the hidden image converter", () => {
    expect(appShell).toContain('<div className="app-kept-view" hidden={view !== "converter"}>');
    expect(appShell).toContain('<div className="app-kept-view app-kept-gif" hidden={view !== "gif"}>');
    expect(gifView).toContain("onDrop={(event) => { if (locked) { event.preventDefault(); return; } handleDrop(event); }}");
    expect(gifView).toContain('if (sourceMode === "video")');
  });

  it("keeps the title-bar close flow on the native destroy path", () => {
    expect(appTitleBar).toContain("destroyCurrentWindow");
    expect(appTitleBar).toContain("WINDOW_CLOSE_TIMEOUT_MS");
    expect(appTitleBar).toContain("WINDOW_DESTROY_TIMEOUT_MS");
    expect(appTitleBar).toContain("close current window timed out");
    expect(appTitleBar).toContain("destroy current window timed out");
    expect(appTitleBar).toContain("requestWindowClose().then(async () =>");
    expect(appTitleBar).toContain("close current window failed, falling back to destroy");
    expect(appTitleBar).toContain("await runWindowActionWithTimeout(closeCurrentWindow");
    expect(appTitleBar).toContain("await runWindowActionWithTimeout(destroyCurrentWindow");
    expect(windowControlGateway).toContain("await currentWindow().destroy();");
    expect(defaultCapabilities).toContain('"core:window:allow-destroy"');
  });

  it("uses one signed size-change vocabulary for preview and estimate", () => {
    expect(compressionView).toContain("formatCompressionSizeDelta(previewSavedBytes, previewSavingsPercent)");
    expect(compressionView).toContain("预计体积变化");
    expect(compressionView).toContain("formatCompressionSizeDelta(estimate.inputBytes - estimate.estimatedBytes, estimate.savingsPercent)");
  });

  it("keeps workbench drop zones free of repeated helper copy", () => {
    expect(converterView).not.toContain("转换图片，适配你的嵌入式界面");
    expect(converterView).not.toContain("或点击选择一个或多个本地文件");
    expect(converterView).not.toContain("导入图片后开始设置输出参数");
    // 位深候选由下拉列表给出，标签行不再复述一遍
    expect(converterView).not.toContain("位可选");
    expect(compressionView).not.toContain("压到目标体积，格式与画质可控");
    expect(compressionView).not.toContain("或点击选择多个文件");
    expect(gifView).not.toContain("或点击选择视频文件");
  });

  it("keeps the workbench icon headers and gives redesigned pages concise context", () => {
    // 转换页保留紧凑基准，压缩与 GIF 的介绍内容留在固定页头之外。
    expect(converterView).toContain('<Images className="header-lockup-icon"');
    expect(converterView).toContain('<p className="eyebrow">EMBEDPIX</p>');
    expect(converterView).toContain("<h1>图片转换工作区</h1>");
    expect(converterView).not.toContain("brand-mark");
    expect(converterView).not.toContain("本地处理");
    expect(converterView).not.toContain("converter-intro");

    expect(compressionView).toContain('<Minimize2 className="header-lockup-icon"');
    expect(compressionView).toContain('<p className="eyebrow">EMBEDPIX</p>');
    expect(compressionView).toContain("<h1>图片压缩工作台</h1>");
    expect(compressionView).not.toContain("brand-mark");

    expect(gifView).toContain('<div className="page-header-icon"><Film size={19}');
    expect(gifView).toContain('<p className="page-eyebrow">EMBEDPIX</p>');
    expect(gifView).toContain("<h1>GIF 制作</h1>");
    expect(gifView).toContain('className="gif-command-bar"');
    expect(gifView).not.toContain("GIF MAKER");

    // 三页图标与侧栏导航 NAV_ITEMS 里该页的 lucide 图标一致。
    expect(appShell).toContain('{ id: "converter", label: "图片转换", hint: "导入、调整并导出", icon: Images }');
    expect(appShell).toContain('{ id: "compression", label: "图片压缩", hint: "批量降低图片体积", icon: Minimize2 }');
    expect(appShell).toContain('{ id: "gif", label: "GIF 制作", hint: "图片序列制作动画", icon: Film }');

    // 页头固定不滚，介绍带在内容层；转换页保留原有更短的版式。
    expect(converterCss).toMatch(/\.converter-header \{[^}]*flex: 0 0 auto;/);
    expect(converterCss).toMatch(/\.converter-header \{[^}]*border-bottom: 1px solid var\(--qp-border-subtle\);/);
    expect(converterCss).not.toContain(".brand-mark");
    expect(converterCss).not.toContain("brand-lockup");
    expect(converterCss).not.toContain("converter-intro");
    expect(converterCss).not.toContain(".header-context");
    expect(converterCss).not.toContain("status-dot");
    expect(converterCss).not.toContain(".intro-copy");
    expect(converterCss).not.toContain(".intro-note");

    expect(compressionCss).toMatch(/\.compression-header \{[^}]*border-bottom: 1px solid var\(--qp-border-subtle\);/);

    expect(gifCss).toMatch(/\.gif-maker-header\.page-header \{[^}]*flex: 0 0 auto;/);
    expect(gifCss).not.toContain(".gif-header-note .status-dot");
    expect(gifCss).not.toContain(".gif-maker-header .page-eyebrow");
  });

  it("locks the compression header to the two-line EMBEDPIX lockup", () => {
    // 压缩页头只留 EMBEDPIX + 「图片压缩」两行；介绍带与本地处理状态点已并入清理，不得回流。
    expect(compressionView).toContain('<p className="eyebrow">EMBEDPIX</p>');
    expect(compressionView).toContain("<h1>图片压缩工作台</h1>");
    expect(compressionView).not.toContain('className="header-context"');
    expect(compressionView).not.toContain("本地处理");
    expect(compressionView).not.toContain("IMAGE COMPRESSION");
    expect(compressionView).not.toContain("减小体积，保留需要的画质");
    expect(compressionView).not.toContain("导入图片，调整核心参数，预览结果后一次导出。");
    expect(compressionView).not.toContain("PNG · JPEG · WebP");
    expect(compressionView).not.toContain("compression-intro");
    expect(compressionCss).not.toContain(".compression-intro");
    expect(compressionCss).not.toContain(".header-context");
    expect(compressionCss).not.toContain(".status-dot");
  });

  it("locks the GIF header to the two-line EMBEDPIX lockup", () => {
    // GIF 页头只留 EMBEDPIX + 「GIF 制作」两行；介绍带与本地处理状态点已并入清理，不得回流。
    expect(gifView).toContain('<p className="page-eyebrow">EMBEDPIX</p>');
    expect(gifView).toContain("<h1>GIF 制作</h1>");
    expect(gifView).not.toContain('className="gif-local-status"');
    expect(gifView).not.toContain("本地处理");
    expect(gifView).not.toContain("ANIMATION WORKSPACE");
    expect(gifView).not.toContain("把图片或视频片段整理成动画");
    expect(gifView).not.toContain("先导入素材，再在右侧预览；帧时长、画布和导出参数按需展开。");
    expect(gifView).not.toContain("本地处理 · 文件不会上传");
    expect(gifView).not.toContain("gif-intro-band");
    expect(gifCss).not.toContain(".gif-intro-band");
    expect(gifCss).not.toContain(".gif-local-status");
  });

  it("shows the selected format description, BMP included", () => {
    expect(converterView).not.toContain("showsFormatDescription");
    expect(converterView).toContain('<FormatSelector value={outputFormat} onChange={handleFormatChange} describedBy="format-description" />');
    expect(converterView).toContain('<p className="format-description format-description-footer" id="format-description">{getFormatInfo(outputFormat).description}</p>');
    expect(converterView.indexOf('className="format-description format-description-footer"')).toBeGreaterThan(converterView.indexOf("<footer className=\"converter-footer\">"));
    expect(converterCss).toContain(".format-description-footer { min-width: 0; flex: 1 1 auto;");
    expect(converterCss).toContain(".converter-footer {\n  display: flex;");
    expect(formatMetadata).toContain("支持 1、4、8、16、24、32 位；仅 32 位保留透明度。");
  });

  it("offers transparent-color fill only for 32-bit output", () => {
    expect(converterView).toContain('{outputFormat === "bmp" && getEffectiveBitDepth(outputFormat, bitDepth) === 32 ? (');
    expect(converterView).toContain('<span>填充透明色</span>');
    expect(converterView).toContain('className="field-help field-help-hover" id="fill-transparent-help"');
    expect(converterView).toContain('aria-describedby="fill-transparent-help"');
    // 预览与导出两条请求都要带上这个参数
    expect(converterView.match(/^ {10}fillTransparent,$/gmu) ?? []).toHaveLength(2);
    expect(imageExportGateway).toContain("...(request.fillTransparent ? { fillTransparent: true } : {})");
  });

  it("routes the update check button through a confirm dialog instead of inline download", () => {
    expect(updateView).toContain('import UpdateConfirmDialog from "./UpdateConfirmDialog";');
    expect(updateView).toContain('if (status === "available") setConfirmOpen(true);');
    expect(updateView).toContain("onClick={handleCheckButtonAction}");
    expect(updateView).toContain('? "查看更新"');
    expect(updateView).toContain('? "安装更新"');
    // 进度条同一时刻只出现一处，卡片与弹窗不重复显示
    expect(updateView).toContain("{progress && !confirmOpen ? <UpdateProgressBar progress={progress} /> : null}");
  });

  it("keeps the update confirm dialog wired to download, install and cancel", () => {
    expect(updateConfirmDialog).toContain('role="dialog"');
    expect(updateConfirmDialog).toContain('aria-labelledby="update-confirm-title"');
    expect(updateConfirmDialog).toContain("onDownload");
    expect(updateConfirmDialog).toContain("onInstall");
    expect(updateConfirmDialog).toContain("onCancelDownload");
    expect(updateConfirmDialog).toContain("稍后");
    expect(updateProgressBar).toContain('role="progressbar"');
  });

  it("crops the preview window in the same order the native transform runs", () => {
    expect(converterView).toContain("previewTransform.crop ? getCropPreviewLayout(");
    expect((converterView.match(/data-crop-window="true"/gu) ?? [])).toHaveLength(2);
    // 窗口承载裁切，旋转与翻转叠加在窗口上（等价 Rust 的 crop → rotate → fliph/flipv）
    expect(converterView).toContain("transform: `scaleY(${previewTransform.flipVertical ? -1 : 1}) scaleX(${previewTransform.flipHorizontal ? -1 : 1}) rotate(${previewTransform.rotation}deg)`");
    expect(converterCss).toContain(".preview-crop-window");
    expect(converterCss).toContain("aspect-ratio: var(--crop-w, 1) / var(--crop-h, 1)");
    expect(converterView).not.toContain("裁剪将在导出时按原图像素坐标执行");
    expect(converterView).toContain("裁剪按原图像素坐标实时预览。");
    expect(converterView).not.toContain("裁剪按原图像素坐标于导出时执行");
  });

  // 窗口最小尺寸对齐 patina：主窗口改由 Rust 在创建期创建（只有创建期的 min_inner_size 才会进
  // WM_GETMINMAXINFO 的 minTrack），因此尺寸的唯一来源是 src-tauri/src/lib.rs 的构建链，
  // tauri.conf 的 app.windows 必须保持空数组（置空后 Tauri 不再自动建窗，改由 lib.rs 建）。
  it("pins the window minimum size to patina's 900 × 636 on the Rust-created main window", () => {
    expect(tauriConfig).toMatch(/"windows":\s*\[\s*\]/);
    expect(libRs).toContain(
      'WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))',
    );
    expect(libRs).toContain(".title(\"EmbedPix\")");
    expect(libRs).toContain(".inner_size(1100.0, 760.0)");
    expect(libRs).toContain(".min_inner_size(900.0, 636.0)");
    expect(libRs).toContain(".resizable(true)");
    expect(libRs).toContain(".decorations(false)");
    expect(agentsMd).toContain("900 × 636");
  });

  it("exposes light and dark color schemes and applies the derived tokens", () => {
    // 配色方案是折起的色卡选择器，不是下拉
    expect(settingsView).toContain("<SchemePicker");
    expect(settingsView).toContain("settings-color-scheme-list");
    expect(settingsView).toContain("colorSchemeLight: scheme");
    expect(settingsView).toContain("colorSchemeDark: scheme");
    expect(settingsView).toContain("配色方案");
    expect(settingsView).not.toContain('id="color-scheme-light"');
    expect(appShell).toContain('applyThemeColors(activeTheme, activeTheme === "dark" ? previewColorSchemeDark : previewColorSchemeLight);');
    expect(tokensCss).toContain("--qp-accent-contrast");
  });

  it("puts every settings row hint on the help icon instead of an always-on paragraph", () => {
    // 每行由 SettingsRow 渲染 = 标题 + ⓘ 提示 + 控件列；说明只进 aria-label/title，不再常显 <p>。
    expect(settingsView).toContain("function SettingsRow({");
    expect(settingsView).toContain("className?: string");
    expect(settingsView).toContain('className="settings-row-title"');
    expect(settingsView).toContain("aria-label={hint}");
    expect(settingsView).toContain('className="settings-help-icon"');
    expect(settingsView).toContain('className="settings-row-control"');
    expect(settingsView).toContain('hint="选择 EmbedPix 的显示方式。"');
    expect(settingsView).not.toContain("<p>选择 EmbedPix 的显示方式。</p>");
  });

  it("places project details at bottom left and updates at top right", () => {
    // 避免版本卡被右栏底部对齐规则推走，项目详情也不能回到右侧。
    expect(aboutView).toContain("FEATURE_GROUPS");
    expect(aboutView).not.toContain("FORMAT_METADATA.map((format) => <span key={format.id}");
    expect(aboutView).toContain('className="about-layout"');
    expect(aboutView).toContain('className="about-secondary-column"');
    expect(aboutCss).toContain(".about-layout { display: grid;");
    expect(aboutCss).toContain("@container about-page (max-width: 760px)");
    expect(aboutCss).toContain(".about-layout { grid-template-columns: minmax(0, 1fr) minmax(280px, 300px); }");
    // 可用高度由左主卡与右栏更新卡共同吸收，项目详情贴底；展开内容由右栏卡片内滚，外层不再冒滚动条。
    expect(aboutCss).toContain("flex: 1 1 auto; min-height: 0; grid-template-columns:");
    expect(aboutCss).toContain("align-items: stretch; }");
    expect(aboutCss).toContain("align-content: start;");
    expect(aboutView).not.toContain("about-project-details-card");
    expect(aboutView).not.toContain("about-project-title");
    expect(aboutView).not.toContain("PROJECT DETAILS");
    expect(aboutView).not.toContain("轻量、本地、面向嵌入式");
    expect(aboutView).not.toContain("所有图片处理都在本地完成");
    expect(aboutView).not.toContain("packageJson.version");
    expect(aboutView).toContain('<UpdateView {...updateProps} embedded className="about-update-view" />');
    expect(updateView).toContain("update-release-card");
    // 赞助弹窗照 patina 的两张卡结构
    expect(aboutView).toContain("about-support-card-heading");
    expect(aboutCss).toContain(".about-support-dialog { display: grid; width: min(580px, calc(100vw - 40px)); height: auto; max-height: none;");
    expect(aboutCss).not.toContain("max-height: min(560px, calc(100vh - 32px))");
    // 赞赏码用原图整张放大，不做裁切；两个卡片图标都抄 patina（微信赞赏徽标 + Ko-fi 官方 mark）
    expect(aboutView).toContain('src={WECHAT_REWARD_IMAGE_URL}');
    expect(aboutView).toContain('src={WECHAT_REWARD_MARK_URL}');
    expect(aboutView).toContain('src={KOFI_MARK_URL}');
    expect(aboutCss).toContain(".about-support-qr { display: block; width: 100%; max-width: 100%; aspect-ratio: 1; object-fit: contain; }");
    expect(aboutCss).not.toContain("width: 200px; height: 200px");
    expect(aboutView).not.toContain("wechat-qr.png");
  });

  it("keeps the about quick links free of the redundant release-notes entry", () => {
    expect(aboutView).not.toContain("更新说明");
    expect(aboutView).not.toContain("RELEASES_PAGE_URL");
    expect(aboutView).not.toContain("<FileText");
    expect(aboutView).toContain('className="about-pill-row" aria-label="项目与支持"');
    expect(aboutView).toContain("GitHub Star");
    expect(aboutView).toContain("问题反馈");
    expect(aboutView).toContain("赞助项目");
  });

  it("uses shared spacing tokens for page and card insets", () => {
    expect(tokensCss).toContain("--qp-space-page-block: 20px;");
    expect(tokensCss).toContain("--qp-space-page-inline: 28px;");
    expect(tokensCss).toContain("--qp-space-card: 18px;");
    expect(tokensCss).toContain("--qp-space-compact: 12px;");
    expect(appShellCss).toContain("padding: var(--qp-space-page-block) var(--qp-space-page-inline) 18px;");
    expect(converterCss).toContain("padding: var(--qp-space-card);");
    expect(compressionCss).toContain("padding: var(--qp-space-card);");
    expect(gifCss).toContain("padding: var(--qp-space-compact);");
    expect(aboutCss).toContain("padding: var(--qp-space-page-block);");
  });

  it("keeps the about page outer container unscrollable so expanding release notes squishes the card instead", () => {
    // 主人要求：关于页最外层取消滚动条；展开右栏发布说明时不把容器变成可滚，而是卡片挤占剩余高度，多出的文本在卡片内部滚。
    // 外层只裁剪：显式 hidden，且不得再退回任何纵向滚动。
    expect(aboutCss).toMatch(/\.about-content \{[^}]*overflow: hidden;/);
    expect(aboutCss).not.toMatch(/\.about-content \{[^}]*overflow-y: auto;/);
    expect(aboutCss).not.toMatch(/\.about-content \{[^}]*overflow: auto;/);
    // 弹性列靠 flex 收缩把可用高度交给 .about-layout；行高锁到容器高度，展开不会再把行撑高。
    expect(aboutCss).toMatch(/\.about-layout \{[^}]*flex: 1 1 auto;/);
    expect(aboutCss).toMatch(/\.about-layout \{[^}]*min-height: 0;/);
    expect(aboutCss).toMatch(/\.about-layout \{[^}]*grid-template-rows: minmax\(0, 1fr\);/);
    // 右栏单行 1fr + 拉伸：更新卡撑满行高并可向下收缩。
    expect(aboutCss).toMatch(/\.about-secondary-column \{[^}]*grid-template-rows: minmax\(0, 1fr\);/);
    // 内嵌更新视图是撑满的弹性列，内容体才是真正的滚动层。
    expect(aboutCss).toMatch(/\.about-update-view\.update-view-embedded \{[^}]*display: flex;/);
    expect(aboutCss).toMatch(/\.about-update-view\.update-view-embedded \{[^}]*min-height: 0;/);
    expect(updateCss).toMatch(/\.update-content-embedded \{[^}]*flex: 1 1 auto;/);
    expect(updateCss).toMatch(/\.update-content-embedded \{[^}]*min-height: 0;/);
    expect(updateCss).toMatch(/\.update-content-embedded \{[^}]*overflow-y: auto;/);
    expect(updateCss).toMatch(/\.update-content-embedded \{[^}]*overscroll-behavior: contain;/);
    // 内滚层只用于 embedded 分支：独立更新页只挂 .update-content，不挂这个类，也就不会变成内滚。
    expect(updateView).toContain('embedded ? " update-content-embedded" : ""');
    expect((updateView.match(/update-content-embedded/g) ?? []).length).toBe(1);
    expect(updateCss).not.toMatch(/\.update-content \{[^}]*overflow-y: auto;/);
    // 高度链靠 flex 收缩，不用固定像素高度去凑。
    expect(aboutCss).not.toMatch(/\.about-layout \{[^}]*height: \d+px;/);
    expect(updateCss).not.toMatch(/\.update-content-embedded \{[^}]*height: \d+px;/);
  });

  it("centers the about blocks on the card's center axis without fixed pixel heights", () => {
    // 参照 patina 的 .about-center-profile：外层容器限宽居中（min(Npx, 100%) + justify-self/justify-items），块内再对齐中轴。
    // 关于页把每个内容块作为卡片子项对齐中轴：卡片 align-items:center，各块限宽 min(560px, 100%)（窄窗 100% 铺满、宽窗收窄居中）。
    expect(aboutCss).toMatch(/\.about-primary-card \{ display: flex;[^}]*align-items: center;/);
    expect(aboutCss).toMatch(/\.about-primary-intro \{[^}]*width: min\(560px, 100%\);/);
    expect(aboutCss).toMatch(/\.about-primary-intro \{[^}]*justify-content: center;/);
    expect(aboutCss).toMatch(/\.about-primary-intro \{[^}]*text-align: center;/);
    expect(aboutCss).toMatch(/\.about-primary-copy \{[^}]*flex: 1 1 auto;[^}]*text-align: center;/);
    expect(aboutCss).toMatch(/\.about-title-line \{[^}]*justify-content: center;/);
    expect(aboutCss).toMatch(/\.about-hero-copy \{[^}]*margin: 6px auto 0;[^}]*text-align: center;/);
    expect(aboutCss).toMatch(/\.about-feature-block,\n\.about-action-block \{[^}]*width: min\(560px, 100%\);[^}]*text-align: center;/);
    expect(aboutCss).toMatch(/\.about-block-heading \{[^}]*justify-content: center;[^}]*text-align: center;/);
    expect(aboutCss).toMatch(/\.about-pill-row \{[^}]*justify-content: center;/);
    // 列表项只居中文字：不能给 li 加 align-items:center——那会解除 small 的拉伸，nowrap 的说明文字不再被裁切，
    // 会把卡片撑出约 35px 横向溢出（实测 900×636）。缺省 stretch + text-align:center 才能既居中又不溢出。
    expect(aboutCss).toMatch(/\.about-output-list li \{[^}]*text-align: center;/);
    expect(aboutCss).not.toMatch(/\.about-output-list li \{[^}]*align-items: center;/);
    // 更新卡在右栏内滚区，只改对齐：头部改上下列居中，按钮跟着中轴；版本项与状态居中。
    expect(aboutCss).toMatch(/\.about-update-view \.update-card-header \{[^}]*flex-direction: column;[^}]*align-items: center;/);
    expect(aboutCss).toContain(".about-update-view .update-card-header > div { flex: 0 1 auto; }");
    expect(aboutCss).toMatch(/\.about-update-view \.update-version-item \{[^}]*text-align: center;/);
    expect(aboutCss).toMatch(/\.about-update-view \.update-status \{[^}]*justify-content: center;/);
    expect(aboutCss).toMatch(/\.about-update-view \.update-release-heading \{[^}]*flex-direction: column;[^}]*align-items: center;/);
    // 发布说明正文是多行长文，保持左对齐，只把标题与按钮居中对齐。
    expect(aboutCss).toMatch(/\.about-update-view \.update-release-notes \{[^}]*text-align: left;/);
    // 居中一律靠对齐 + 限宽，钉死不许用固定像素高度去凑。
    expect(aboutCss).not.toMatch(/\.about-primary-(?:card|intro|copy) \{[^}]*height: \d+px;/);
    expect(aboutCss).not.toMatch(/\.about-(?:feature-block|action-block|secondary-card) \{[^}]*height: \d+px;/);
  });

  it("keeps all five fixed page headers on one icon frame, eyebrow, and title scale", () => {
    // 五页共用一个页头图标外框（壳层 .page-header-icon）：34×34 + 1px token 边线 + control 圆角 + panel 底色；
    // 框内 lucide 字形一律 18px，由 CSS 定宽高，不再依赖各页组件传的 size（props 换字号或漏传都不会再偏）。
    expect(appShellCss).toMatch(/\.page-header-icon \{[^}]*width: 34px;/);
    expect(appShellCss).toMatch(/\.page-header-icon \{[^}]*height: 34px;/);
    expect(appShellCss).toMatch(/\.page-header-icon \{[^}]*border: 1px solid var\(--qp-border-subtle\);/);
    expect(appShellCss).toMatch(/\.page-header-icon \{[^}]*border-radius: var\(--qp-radius-control\);/);
    expect(appShellCss).toMatch(/\.page-header-icon \{[^}]*background: var\(--qp-bg-panel\);/);
    expect(appShellCss).toMatch(/\.page-header-icon > svg \{[^}]*width: 18px;[^}]*height: 18px;/);
    // GIF 页头曾把外框圆角改回按钮圆角并重复声明尺寸：基规则必须与壳层同组取值，破坏即在此失败（短窗自适应规则不算）。
    const gifIconBaseRule = gifCss.match(/\.gif-maker-header \.page-header-icon \{[^}]*\}/)?.[0] ?? "";
    expect(gifIconBaseRule).not.toContain("--qp-radius-button");
    expect(gifIconBaseRule).toMatch(/border-radius: var\(--qp-radius-control\);/);

    // eyebrow 10px：转换/压缩页用自己的 .eyebrow，GIF/设置/关于共用壳层 .page-eyebrow。
    expect(converterCss).toMatch(/\.eyebrow,\n\.panel-kicker \{[^}]*font-size: 10px;/);
    expect(appShellCss).toMatch(/\.page-eyebrow \{[^}]*font-size: 10px;/);
    // h1 14px + margin-top 2px：转换页 .header-lockup h1、压缩页 .brand-lockup h1、其余走壳层 .page-header h1。
    expect(converterCss).toMatch(/\.header-lockup h1 \{\n  margin-top: 2px;\n  font-size: 14px;\n\}/);
    expect(compressionCss).toMatch(/\.compression-header \.brand-lockup h1 \{[^}]*margin: 2px 0 0;[^}]*font-size: 14px;/);
    expect(appShellCss).toMatch(/\.page-header h1 \{[^}]*margin: 2px 0 0;[^}]*font-size: 14px;/);
    // 图标与文案的间距五页同为 11px；三条页头基规则的间距取值也一致（转换页头补回 gap）。
    expect(converterCss).toMatch(/\.header-lockup \{[^}]*gap: 11px;/);
    expect(compressionCss).toMatch(/\.compression-header \.brand-lockup \{[^}]*gap: 11px;/);
    expect(gifCss).toMatch(/\.gif-brand-lockup \{[^}]*gap: 11px;/);
    expect(appShellCss).toMatch(/\.page-header \{[^}]*gap: 11px;/);
    expect(converterCss).toMatch(/\.converter-header \{[^}]*gap: 11px;/);
    expect(compressionCss).toMatch(/\.compression-header \{[^}]*gap: 11px;/);
  });

  it("wraps the converter and compression header icons in the shared frame instead of leaving them bare", () => {
    // 转换/压缩页原先把 lucide 图标裸挂在 .header-lockup / .brand-lockup 下（既无外框，字号也只由组件 size 决定）。
    // 现在必须包进壳层同一个 .page-header-icon 外框，五页页头结构一致。
    expect(converterView).toMatch(/<div className="header-lockup">\s*<div className="page-header-icon">/);
    expect(compressionView).toMatch(/<div className="brand-lockup">\s*<div className="page-header-icon">/);
    expect(settingsView).toContain('<div className="page-header-icon"><Settings2');
    expect(aboutView).toContain('<div className="page-header-icon"><Info');
    // 负向断言：图标不再作为 lockup 的直接子元素裸挂。
    expect(converterView).not.toMatch(/<div className="header-lockup">\s*<Images/);
    expect(compressionView).not.toMatch(/<div className="brand-lockup">\s*<Minimize2/);
  });
});
