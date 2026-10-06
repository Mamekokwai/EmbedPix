# AGENTS.md

## 项目定位

EmbedPix（嵌图匠）是面向嵌入式 UI 开发者的本地图片格式转换与处理工具。

- 核心路径：导入图片、预览、调整尺寸与像素格式、导出。
- 优先支持 BMP 位深、RGB565/C 数组等嵌入式资源需求。
- 规划扩展图片体积压缩、GIF 生成与导出，以及裁剪、旋转、镜像等简单编辑能力。
- 不引入账号、云端服务、时间追踪、SQLite 或与图片处理无关的复杂功能。

## 工具链

- Node `24.18.0`（`.node-version`）、Rust `1.94.1`（`rust-toolchain.toml`，含 clippy/rustfmt）；栈为 Tauri 2 + React 19 + Vite + TypeScript + Vitest。
- 准备：`npm install`；前端开发：`npm run dev`；桌面开发：`npm run tauri dev`。
- 前端门禁：`npm run check:types`、`npm run check:lint`、`npm run build`；聚合命令 `npm test` = check:types + check:lint + `vitest run`。
- Rust 门禁（全部带 `--locked`）：`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings`、`cargo check --manifest-path src-tauri/Cargo.toml --locked`、`cargo test --manifest-path src-tauri/Cargo.toml --locked`。
- Windows 专用 smoke（pwsh）：`npm run check:release-config`、`check:release-deps`、`check:release-fixture`、`check:release-signing-cleanup`、`check:desktop-smoke`、`check:compression-cli-smoke`、`check:gif-benchmark`、`check:gif-quality`。

## 协作规则

- 用户语言为中文；代码注释只写 WHY，不写 WHAT。
- 主任务负责拆分任务、整合结果、验收和催产；具体实现、测试、盘点和专项调查尽量交给子 agent 并行处理。
- 子 agent 优先使用 `gpt-5.6-luna`，推理强度优先使用 `high`；只有任务复杂度或可用性要求时才改用其他模型。
- 子任务必须有清晰且互不重叠的文件写入范围。主任务不重复实现已委派的子任务，只负责审查、整合和补缺。
- 每完成一组可独立验收的改动，主任务自动创建本地 Git commit；提交前检查 staged diff 范围并保持提交主题聚焦。自动 commit 不包含 git push，除非用户另行明确要求。
- 提交信息沿用现有历史约定：英文 conventional 前缀（`feat:`、`fix:`、`docs:`、`style:`、`a11y:`、`ci:`），发布提交为 `release: prepare EmbedPix v<版本>`。
- 不调用或消耗用户账户的任何用量重置卡、重置额度或类似权益。
- 修改前先阅读相关代码和配置，保留用户已有改动；不要无关重写。
- 不创建与当前功能无关的文档、README 或兼容层。
- 修改任一平台清理脚本时，必须同步检查另一平台对应脚本，保持两平台功能对等。

## 架构约定

- 前端使用 `src/app` 负责壳层，`src/features` 负责图片转换功能，`src/shared` 只放稳定共享组件，`src/platform` 只放 Tauri/桌面适配。
- Rust 使用 `src-tauri/src/lib.rs` 做装配，命令入口保持薄，图像处理逻辑放在明确的 feature/domain 模块。
- 严格格式编码、文件写入和平台对话框属于 Rust 侧；前端负责 UI、交互状态和预览。
- 新增样式优先复用现有语义 token；保持安静、专业、克制的桌面工具风格。

## 验收要求

- 命令行调试使用主程序同目录的 `embedpix-cli`：把一条 JSON 或多行 JSONL 请求写入 stdin（如 `echo '{"id":"job-1","op":"compress","inputPath":"in.png","outputPath":"out.webp"}' | embedpix-cli`），`op` 支持 `image`／`compress`／`gif`／`pngSequence`；按 stdout 的 JSONL 事件与退出码判断结果（`0` 成功、`1` 全部失败、`2` 部分失败或被中断）。GUI 主程序 `EmbedPix.exe` 不接受处理参数，传参即报错退出（退出码 `2`）；仅在命令行无法定位问题时再使用 IDE 或断点。
- 前端至少通过 `npm run check:types`、`npm run check:lint` 和 `npm run build`。
- Rust 变更至少通过 `cargo check --manifest-path src-tauri/Cargo.toml --locked`，并补齐同 `--locked` 的 `cargo fmt -- --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test` 三条门禁；涉及编码逻辑时补充单元测试。
- 版本相关改动必须让 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 与 `docs/release-notes-v<版本>.md` 四处一致，发布说明首行严格为 `# EmbedPix v<版本>`；发布 workflow 会硬校验这四点。
- 导出失败必须给出可理解的错误，不得静默生成格式错误的文件。

## UI 布局规则

- 后续页面默认参照 `E:\Github\patina` 的模块化、响应式和窗口自适应布局；页面功能结构与布局样式变量保持独立。
- 应用根层固定占满窗口并隐藏溢出；壳层、标题栏、侧栏和视图容器使用 `min-height: 0`，页面内容保留单一主滚动层，只有有明确尺寸约束的列表或弹层才允许内部滚动。
- 桌面布局保持标题栏、侧栏、主视图区三段骨架；侧栏同时支持图标模式和文字模式，窄窗优先缩窄侧栏并保留全部功能，不因宽度隐藏核心导航。
- 页面内容使用 `max-width` 和 `min-width: 0` 控制可读宽度；卡片、表单行和按钮允许换行，长文本使用省略或折行，禁止依赖固定宽度造成横向溢出。
- 响应式至少覆盖约 `820px`、`760px`、`620px`、`560px`、`500px` 断点：双栏工作区在窄窗堆叠，设置项和页头操作改为纵向，按钮在窄窗扩展为可点击的整行宽度。
- 以 `src-tauri/tauri.conf.json` 的 `minWidth`/`minHeight` 为最低验收窗口；当前窗口下页面必须可访问、可滚动、可操作，不得把最小尺寸当作正常桌面尺寸。
- 新增样式优先使用现有设计 token，保持紧凑卡片、清晰层级、克制间距和键盘焦点可见；布局验收需同时覆盖正常窗口、最小窗口和窄高窗口。

## GUI 规则

页面外壳、折叠模块与控件语义按这套做；新页面照抄现有类，不要另造视觉语言。样板：`src/features/image-converter/ImageConverter.tsx` 的 `converter-*`、`src/features/image-compression/ImageCompressionView.tsx` 的 `compression-*`。

适用范围：主工作区页面（图片转换、图片压缩）已按此执行；**GIF 制作、设置、关于尚未迁移**，改动这三个页面时按本规则收敛外壳与折叠模块，不要另立一套（2026-10-06 核实现状：三页均无品牌头带与品牌行）。

- **页面外壳 = 品牌头带 + 介绍带 + 底部边界**：头带是「图标 + `EMBEDPIX` + 工作区名 + `● 本地处理`」并带底边线（`brand-lockup` / `brand-mark` / `eyebrow` / `header-context` / `status-dot`，样式在 `image-converter.css`，全局可用）；介绍带是「英文 eyebrow + 标语 + 说明」，可按需在右侧放一条注释（`intro-copy` / `intro-note`）；页面动作栏加顶边线，页尾以品牌行 `EmbedPix · 嵌图匠` 收尾。
- **折叠模块 = 独立边框卡片**：1px `--qp-border-subtle` 边框、`--qp-radius-control` 圆角、`--qp-bg-elevated` 底色，标题栏 38px、左右 12px 内边距，展开时标题栏下方补 1px 分隔线，收起/展开标记用等宽字体的 `+` / `−`。样板见 `.settings-module` 与 `.compression-advanced-settings`。
- **主控件平铺，其余收纳**：每页只把最常改的 2–4 个控件留在外面（如压缩页的格式、质量、输出缩放），其余按主题分组折叠；折叠组的标题必须带当前状态摘要（如「目标体积 · 未启用（不限制输出体积）」），危险项（覆盖原图、删除源文件）与无效参数用 `--qp-danger` 标红。
- **下拉一律用共享的 `ThemeSelect`**（`src/shared/components/ThemeSelect.tsx`，样式 `src/styles/components/theme-select.css`）：不要写原生 `<select>`（系统弹出层跟主题脱节），也不要另造一套下拉（浮层落位在 `themeSelectPlacement.ts`，重复实现会得到不同位置）。字段外层用各页的包装组件（压缩页 `CompressionSelectField`、转换页 `SelectField`），标签在控件上方、说明在控件下方。
- **用不上的参数直接隐藏，不要留成灰控件**：按当前格式 / 模式 / 环境不生效的字段整块不渲染（PNG 下没有质量与输出缩放、JPEG 下没有 WebP 编码参数、浏览器环境没有目录选择按钮）；只有「暂时不可用」才用 `disabled`——导出中、队列为空、尚未选目标这类状态控件要留在原位，否则导出时面板会闪空。纯信息文案可以留（如「JPG 固定 24 位」）。
- **文档永远不可滚动，定位祖先必须落在主滚动层**：壳层是固定尺寸，`.app-main` 是唯一主滚动层；`html` 用 `overflow: clip`（`overflow: hidden` 仍能被 `scrollIntoView`/焦点滚动编程滚动——曾导致点开关时整页含标题栏被顶出窗口）。任何 `position: absolute` 的隐藏控件（开关复选框、`.visually-hidden`）都必须有定位祖先，否则以初始包含块为基准逃出主滚动层裁剪、把文档撑高；`.app-main` 已设 `position: relative`，新页面不要把它改回 static。
- **说明文字宽度要一致**：折叠模块体是两列网格，任何带说明段落（`.field-help` / `.format-description`）的设置组都要通栏（`grid-column: 1 / -1`，见 `.settings-module-body > .setting-group:has(...)` 那条），否则解释被挤成半栏、和同页其它说明对不齐。半栏只留给纯输入并排。
- **说明默认收起，悬停 / 聚焦后才浮出**：设置项的说明统一用 `.field-help-hover`（`src/styles/components/field-hint.css`，`App.css` 已引入），不要常显在面板里——逐条解释会把控件本身盖掉。用法：说明元素加这个类，并把控件与说明一起放进 `.field-hint-anchor`（紧贴控件的 `position: relative` 锚点）——浮层按最近定位祖先算 `top: 100%`，拿整个设置组当锚点会让说明落到组底、看着像跑到窗口底部；`.output-action` 这类只包一行的小容器本身就可以当锚点。说明只做视觉收起（`opacity`），必须留在 DOM 里，`aria-describedby` 不能断；出现延迟写在浮出态那一侧的 `transition` 上，写在隐藏态会被覆盖导致秒出。聚焦一律用 `:has(:focus-visible)`，**不要用 `:focus-within`**——鼠标点一下开关也会给它焦点，那样鼠标移开后浮出框会一直挂着。
- **同类组件的间距必须相同**：竖向堆叠的控件行与设置组统一用 `--qp-stack-gap`（`src/styles/tokens.css`，当前 7px）——模块体（`.settings-module-body`）、设置组（`.setting-group`）、勾选组（`.output-actions` / `.output-action`），连同它们的短窗媒体查询覆盖，都只用这一个 token；不要再各自写 4px / 5px / 7px / 8px / 10px，同一屏里相邻选项的间距差一点就看得出。卡片之间的间距属于另一层（`.settings-stack`），不在这一条里。
- **阻断性错误要有始终可见的出口**：字段被折叠时，按钮禁用必须配一个折叠组之外的说明块（如 `compression-parameter-issues`），不能让用户对着灰按钮猜原因。
- **滚动条可见但细**：主滚动层用 6px 细滚动条，不要再写 `scrollbar-width: none`（0.2.2 的隐藏滚动条契约已作废）。
- **控件用真语义**：导入类操作用真 `<button>` + ref 触发隐藏 `<input type="file">`（不要 `label` 包 input），单选组用真 `<input type="radio">`，列表用 `list` / `listitem`，忙碌时用 `<fieldset disabled>` 或 `aria-busy` 禁用整组。
- 能机器检查的部分写在 `src/styles/layoutContract.test.ts`：新增页面时同步补断言，改样式前先改契约。

## 陷阱

- 前端测试只收集 `src/**/*.test.ts`（见 `vitest.config.ts`），写成 `.test.tsx` 不会被运行；测试文件与被测代码同目录，`testTimeout` 为 15 s。
- `src/styles/layoutContract.test.ts` 是源码契约测试：直接读取 CSS/TSX/`src-tauri/capabilities/default.json` 文本做字符串断言，改类名、文案或属性字符串会连带失败，必须同步更新契约。
- 依赖中有精确锁定版本（`jpeg-encoder`、`kamadak-exif`、`libwebp-sys2`、`oxipng`），所有 cargo 门禁都带 `--locked`；不要顺手升级这些版本。`libwebp-sys2` 为静态构建，需要本机 C 工具链。
- 发布只覆盖 Windows NSIS（x64/ARM64）；macOS/Linux 仅做跨平台编译检查，不作为支持平台或发布资产。
- `dist/`、`src-tauri/target/`、`src-tauri/gen/`、`tmp/`、`.tmp/`、`benchmarks/cli-test/` 均为生成物，已在 `.gitignore` 中，不要手改或提交。
- 颜色只来自 `src/styles/tokens.css` 的 `--qp-*` 变量（含 `:root[data-theme="dark"]` 深色一套）；新增颜色先加 token，不要写死色值。
