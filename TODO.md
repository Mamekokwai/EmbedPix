# EmbedPix 分阶段升级 TODO

目标：从 `0.1.9` 稳定推进到 `0.3.3`。

执行规则：一次只做一个编号任务；任务完成后必须通过对应验收、提交并 push，再开始下一项。未完成任务不得标记为完成。

## 当前基线

- [x] Windows x64/ARM64 安装包、Tauri updater `.sig`、`latest.json` 和 Artifact Attestation 已发布
- [x] 视频抽帧资源预算：画布尺寸、累计像素、单帧体积、总帧数
- [x] 原生 GIF/WebP/APNG/PNG 序列后端 Job 最小契约
- [x] 原生导出取消后清理临时文件，不误报成功
- [x] 更新下载前后校验版本、来源、大小、SHA256 和 `.sig`
- [x] Release workflow 校验签名、`latest.json` 和不可变提交来源
- [x] GIF 小窗口布局、错误详情、头像 fallback 和隐藏滚动条
- [x] 更新页面离线状态与手动重试

## 0.2.1 可靠导出

### A1：前端 Job 类型和 Gateway ✅

- [x] 在 `gifGateway.ts` 增加 `jobId`、进度 DTO、取消和查询方法
- [x] 校验 Rust 返回的状态、阶段、帧数和错误字段
- [x] 保留没有 `jobId` 的旧调用兼容性

验收：Gateway 单测覆盖正常响应、非法响应、未知状态和取消失败。

### A2：GIF 导出接入 Job ✅

- [x] GIF 导出生成唯一 `jobId`
- [x] 导出中显示 `validating / encoding / publishing`
- [x] 显示已完成帧数/总帧数
- [x] 导出完成后只接受 `completed`

验收：GIF 导出 UI 能显示真实 Rust 进度，不再只显示静态“导出中”。

### A3：WebP/APNG/PNG 序列接入 Job ✅

- [x] 三种格式复用 A1 的 Gateway
- [x] 统一任务状态和错误文案
- [x] 不同格式显示正确的输出路径

验收：四种原生输出均能显示进度、完成、失败和取消状态。

### A4：导出取消按钮 ✅

- [x] 导出中显示取消按钮
- [x] 点击后调用 `cancel_gif_export`
- [x] 进入 `cancelling` 时禁用重复提交
- [x] 轮询到 `cancelled` 后显示明确结果

验收：取消后界面不会显示成功，不产生最终输出文件。

### A5：取消竞态和发布事务 ✅

- [x] 增加 `publishing`/`completed` 边界
- [x] 发布前取消必须回滚
- [x] 发布后不再报告 cancelled
- [x] 覆盖模式失败时恢复旧文件和 `bak`

验收：覆盖编码完成、发布前、发布中、发布后四种取消时序都有 Rust 测试。

### A6：Job 生命周期和并发限制 ✅

- [x] 为编码任务增加并发上限
- [x] 终态 Job 增加 TTL 回收
- [x] 重复 `jobId` 只允许一个 active 任务
- [x] 查询过期 Job 返回明确错误

验收：20 个并发请求不会无限创建编码线程，Job registry 长时间运行不会持续增长。

### A7：0.2.1 验收与发布 ✅

- [x] `npm test`
- [x] `npm run build`
- [x] Rust fmt/check/test/clippy
- [x] 100/200 帧取消测试
- [x] 覆盖、备份、失败回滚测试
- [x] 发布 `0.2.1`

## 0.2.2 批处理与界面体验

### B1：转换页底部任务栏 ✅

- [x] 显示当前文件名、`n/total`、成功、失败、跳过
- [x] 增加真实 `progressbar` 和 ARIA 属性
- [x] 导出中始终提供取消按钮

验收：导出 10 张以上图片时，进度和统计实时同步。

### B2：失败详情 ✅

- [x] 失败列表可展开
- [x] 保留完整文件名和错误原因
- [x] 增加复制错误详情
- [x] 增加“仅重试失败项”

验收：多个文件失败时不再被单行省略，纯键盘可展开、复制和重试。

### B3：GIF 素材帧操作 ✅

- [x] 单帧删除、替换、复制、插入
- [x] 多选帧
- [x] 多选批量设置时长
- [x] 拖拽排序和倒序播放

验收：200 帧以内的帧列表操作不会丢失顺序、时长或预览 URL。

### B4：GIF 小窗口布局矩阵 ✅

- [x] 固定测试尺寸：320×480、360×500、480×640
- [x] 图片模式和视频模式分别测试
- [x] 不再把预览区压缩到不可用高度
- [x] 导出/取消操作始终可达

验收：无卡片重叠、无文字覆盖、无横向滚动条，Tab 能到达全部关键操作。

### B5：统一隐藏滚动条契约 ✅

- [x] 统一 `min-height: 0`、`overflow` 和 `overscroll-behavior`
- [x] 焦点进入隐藏区域时自动滚入视口
- [x] 支持滚轮、PageDown、Space 和 Tab
- [x] 避免同一轴多层滚动

验收：页面无可见滚动条，但鼠标和键盘仍能访问全部内容。

### B6：紧凑更新状态卡 ✅

- [x] About 页只显示当前版本、检查状态、上次检查时间
- [x] 每种状态只保留一个主动作
- [x] 发布说明保留换行并支持展开
- [x] 320×480 下更新主动作可见

验收：在线、离线、检查中、发现更新、下载中、安装失败六种状态均有明确动作。

### B7：0.2.2 验收与发布

- [x] 前端测试覆盖进度、失败详情、帧操作和响应式 ViewModel
- [x] 增加四种窗口尺寸的可重复 CSS/source contract（320×480、360×500、480×640、1280×800）
- [x] 真实窗口矩阵 E2E（E1 已完成五种 viewport、图片/视频双模式、连续 Tab、长中文文件名及受控失败状态实测）
- [x] 发布 `0.2.2`

## 0.2.3 编码质量和体积优化

### C1：建立体积基准 ✅

- [x] 准备横屏、竖屏、透明 PNG、游戏录屏和长视频风格的确定性合成样本
- [x] 记录 GIF 分辨率、FPS、颜色数、体积、耗时和峰值内存
- [x] 建立 `benchmarks/gif/baseline.json` 与 `baseline.csv` 固定回归数据

注：当前基准使用确定性合成 PNG 帧，不代表真实视频解码/FFmpeg 编码；耗时与峰值内存需在同一平台和工具链下比较。

验收：同一输入可以比较优化前后的体积和画质。

### C2：减少 IPC 复制 ✅

- [x] GIF/APNG/WebP/PNG 序列业务路径禁止全量 `Array.from(Uint8Array)`
- [x] 使用 64 KiB 分块 Base64 传输，Rust 兼容旧数组协议
- [x] 记录每批内存上限并增加 200 帧/字节顺序回归测试

注：Base64 仍有编码字符串和 Rust 解码开销；更低峰值的 opaque spool 方案属于 C3。

验收：200 帧接近资源上限时，峰值内存有明确上界，结果与旧路径一致。

### C3：临时帧 spool 方案 ✅

- [x] 由 Rust 创建受控临时目录和随机 opaque spool ID
- [x] 前端只传 spool ID 与受控元数据，不传任意路径
- [x] Rust 按固定帧名逐帧读取
- [x] 成功、失败、取消统一清理

注：当前编码前会顺序读回受控帧；进程崩溃遗留目录的启动清理策略留待后续稳定性任务。

验收：路径越权、残留文件和取消清理均有测试。

### C4：跨帧调色板与抖动实验 ✅

- [x] 对比当前逐帧量化、FFmpeg `palettegen/paletteuse`、Gifski 思路
- [x] 测试逐帧量化与多种抖动方式，并记录三组以上样本数据
- [x] 完成许可证审查；当前不引入 FFmpeg/Gifski 生产依赖

参考：[FFmpeg palettegen/paletteuse](https://ffmpeg.org/ffmpeg-filters.html)、[Gifski](https://github.com/ImageOptim/gifski)。

验收：至少三组样本同时比较画质、体积和耗时，不凭主观判断合并方案。

### C5：目标体积自动压缩

- [x] 设定目标体积和最大体积
- [x] 按分辨率、FPS、颜色数、跳帧顺序搜索
- [x] 显示压缩前后体积和最终参数
- [x] 限制候选次数，防止重复全量编码

验收：目标可达时输出不超过目标；不可达时给出最终参数和原因。✅

候选预算为 96；四种输出都受候选预算限制，目标不可达时报告最佳参数。

### C6：0.2.3 验收与发布

- [x] 固定样本基准全部通过
- [x] 峰值内存和导出耗时有记录
- [x] 第三方许可证和 notices 完整
- [x] 发布 `0.2.3`

## 0.3.2 自动化与平台能力

### D1：CLI 最小入口

- [x] 支持图片转换
- [x] 支持 PNG 帧序列导出
- [x] 支持 GIF 导出
- [x] JSON/JSONL 输入
- [x] stdout 输出结构化进度和错误码

验收：无桌面环境可执行单图和 GIF 批处理。✅

退出码约定：0 表示成功，1 表示完全失败，2 表示部分失败；D2 尚未覆盖 SIGINT 安全取消和任务级取消。

### D2：CLI 取消与批处理

- [x] SIGINT 安全取消
- [x] 部分失败继续执行
- [x] 临时文件清理
- [x] 输出结果可机器解析

验收：CI 中可稳定执行，退出码能区分成功、部分失败和完全失败。✅

CLI 约定退出码 0/1/2，并通过 JSONL 提供机器可解析输出；限制：SIGINT 状态机及 taskkill/崩溃后的残留清理仍需后续加固。

### D3：统一更新协议

- [x] 选择自定义更新器或 Tauri updater 作为唯一事实源
- [x] 删除重复配置和重复下载逻辑
- [x] 保留版本、摘要、签名和回滚校验

验收：检查、下载、安装和失败回滚只经过一条协议。✅

桌面端统一走 Rust custom updater gateway；CLI 不混用桌面更新协议。

### D4：平台支持矩阵

- [x] 明确 Windows x64/ARM64 支持范围
- [x] 决定是否补齐 macOS/Linux
- [x] UI、文档和 Release 资产保持一致

验收：任何显示为支持的平台都有签名资产、manifest、下载和安装测试。✅

当前正式支持 Windows x64/ARM64；macOS/Linux 仅保留跨平台编译检查，不作为支持平台或发布资产。

### D5：发布供应链加固

- [x] 固化独立 verifier 源码和 lockfile
- [x] 所有第三方 Action 固定 SHA
- [x] 生产环境增加审批和受保护 tag
- [x] 发布后回读 GitHub Release 资产摘要
- [x] 强制 package/Cargo/Tauri/tag 版本一致

验收：篡改版本、commit、资产、签名或 manifest 任一字段都会阻止发布；GitHub Settings 已配置并通过 API 验证 `production` required reviewers、`main` 分支保护和 `v*` tag 保护规则。

### D6：0.3.2 验收与发布

- [x] CLI 无桌面测试通过
- [x] 更新协议端到端测试通过
- [x] 供应链门禁通过
- [x] 发布 `0.3.2`

内部验收证据：CLI 已通过无桌面 smoke/契约测试及 image、gif、pngSequence 三类端到端操作；更新协议已通过本地 HTTP fixture，覆盖下载、大小、SHA-256、签名和缓存复核；仓库内 verifier、Action SHA 固定、版本一致性、tag/commit 与发布后资产回读门禁已通过；GitHub Settings 的 `production` required reviewers、`main` 分支保护和 `v*` tag 保护规则已通过 API 验证。远端审计确认 `v0.3.2` Release 非 draft，7 个资产齐全，`latest.json` 为 0.3.2 且包含两个平台，两个 manifest 签名与对应 `.sig` 资产一致，provenance 指向 `dbb07ce`。

## 0.3.3 GIF 与图片转换体验/稳定性

执行顺序：先完成 P0 的稳定性和验收基础，再推进 P1 的核心体验，最后处理 P2 的扩展评估；每项任务开始前确认依赖已完成，未完成项不得标记为完成。

### P0：稳定性与验收基础

#### E1：真实窗口 E2E 矩阵 ✅（依赖：B7）

- [x] 覆盖 320×480、360×500、480×640、700×1100、1280×800（Codex In-app Browser viewport）
- [x] 每个尺寸分别验证图片模式和视频模式
- [x] 实测检查卡片几何分离、横向溢出和导出按钮存在；矩阵最终无失败，因此没有失败截图
- [x] 五个 viewport 下真实连续 Tab 审计均能到达导出按钮；长中文文件名在 320×480 下按预期省略，未造成页面横向滚动
- [x] 补充真实视频源证据：MP4 20 帧成功抽取；10 秒样本取消后进入“已取消视频抽帧”终态，帧列表为 0，未残留帧 Blob URL
- [x] 复现环境/命令：`E:\Github\EmbedPix`；`npm run dev -- --host 127.0.0.1`；浏览器访问 `http://127.0.0.1:1420/`；`powershell -File scripts/generate-e1-video-fixture.ps1`；证据提交 `eb04a00`
- [x] 真实浏览器（700×1100）将输出位置设为受控非法目录 `Z:\\__embedpix_controlled_failure__\\missing` 后导出 BMP：状态为“导出完成：成功 0，失败 1，跳过 0”，错误详情显示“当前预览环境不支持导出，请在桌面应用中执行导出。”；“查看失败详情（1）”可展开，“仅重试失败项（1）”可点击并再次进入同一失败状态。该证据验证了失败状态、详情和重试按钮的真实可达性，不写入用户文件。

验收 ✅：五种尺寸、两种模式的真实 viewport 几何/横向溢出检查通过；480×640 与 700×1100 的真实视频源布局通过；导出按钮五尺寸 Tab 可达，长中文文件名无页面级溢出；700×1100 下已真实验证受控导出失败、失败详情和“仅重试失败项”状态闭环。

代码级证据：`9d53cd8` 的 `imageExportQueue.test.ts` 以受控失败验证仅重试失败项、成功项不重复导出，并验证失败文件名/错误原因可格式化为可复制详情；这不替代真实窗口中的失败详情展开、复制和重试状态验收。

#### E2：GIF 视频抽帧资源与临时文件生命周期（依赖：C3、D2）

- [x] 明确内存、磁盘、帧数和累计像素预算
- [x] 覆盖正常完成、失败、取消、进程崩溃后的临时目录清理
- [x] 增加长视频和接近预算上限的回归样本
- [x] 记录残留扫描结果和清理耗时

- [x] 验收：成功、失败、取消均无可见残留；重启后能清理上次崩溃残留；长视频不越过资源预算且错误可定位。

证据：`eb04a00`/`285465b` 覆盖真实 MP4 抽帧、10 秒取消后的终态与 Blob 清理，以及 20 秒/200 帧边界；`b820864` 覆盖 Rust spool 成功读取、失败/取消清理、200 帧和孤儿目录清理；`40a8644` 将扫描结果提升为 state 内可测试的结构化快照（scanned、removed、skipped-active、skipped-grace-period、elapsed_ms），验证活跃目录保护与宽限期跳过；`4d06ca5` 提供 MP4/WebM fixture；`a072ede` 的 E3 报告覆盖长视频代理、200 帧、资源阈值和错误记录。

#### E3：性能与回归基准（依赖：E2、C1）

- [x] 覆盖大图、200 帧、长视频和混合尺寸输入
- [x] 记录峰值内存、磁盘峰值、耗时、输出体积和失败率
- [x] 固定工具链与样本，生成可比较的基准记录

- [x] 验收：基准可重复运行，结果包含完整输入参数和环境信息；相对基线的回归阈值明确，超阈值时 CI 或验收报告失败。

证据：commit `a072ede`；`benchmarks/gif/e3/baseline.json`/`baseline.csv` 记录 8/8 样本成功、失败率 0、环境和资源指标；`npm run check:gif-benchmark` 通过 `thresholds.json` 阈值检查。

#### E4：0.3.3 验收与发布（依赖：E1、E2、E3、P1/P2 任务及 D6）

- [ ] P0/P1/P2 任务的验收证据归档
- [ ] 前端、Rust、真实窗口和发布资产门禁全部通过
- [ ] 发布说明列出兼容性、已知限制和回归数据
- [ ] 完成 `0.3.3` 发布前版本/签名/manifest 一致性检查

验收：所有已承诺任务均有通过证据；发布门禁通过后才允许发布 `0.3.3`，不得以未完成项替代验收。

当前 E4 发布门禁审计：P0（E1/E2/E3）证据已归档；P1 的 E5/E6/E7 preview 编码契约已完成，E7 仍缺真实导出文件回读 harness，E8 默认清理/sRGB 限制证据已完成但 ICC/EXIF 保留和真实色彩管理不支持，E9 预检/估算/Windows 磁盘空间闭环已完成但非 Windows 容量探针仍降级；P2 的 E10 仅完成 WebP/ICO/TIFF 评估，结论是不加入生产依赖或用户选项。版本/签名/manifest 门禁已有 `v0.3.2` 远端证据：Release 非 draft、7 个资产齐全、`latest.json` 两平台签名与 `.sig` 一致、provenance 指向发布 commit；这不能替代 `0.3.3` 的新版本一致性检查。发布前仍需评估 E7 回读 harness 是否纳入承诺、准备包含兼容性/已知限制/回归数据的发布说明，并由用户决定 E10 不进入生产的范围；在此之前不勾选 E4 或创建 `0.3.3` Release。

0.3.3 发布说明草案：兼容 Windows x64/ARM64；P0/P1 回归门禁包括前端 199 tests、Rust 130 library tests + 3 CLI tests、GIF benchmark 8/8 和 quality presets 3/3。已知限制：E7 尚无真实导出文件回读 harness；E8 不保留 ICC/EXIF、不提供真实色彩管理；E9 非 Windows 不提供磁盘容量探针；E10 的 WebP/ICO/TIFF 仅完成评估，不加入生产格式选项。

### P1：核心转换体验

#### E5：GIF 输出质量预设（依赖：C4、C5、E3）

- [x] 提供高质量、平衡、小体积三档预设；预设真实映射编码速度、颜色数、抖动、画布比例、视频 FPS 和跳帧，手动修改这些参数后回到“自定义”
- [x] 预设说明可解释且可复现：高质量=原尺寸/256 色/15 FPS/不跳帧，平衡=75%/128 色/12 FPS/不跳帧，小体积=50%/64 色/8 FPS/每 2 帧采样；未引入未支持的后端参数
   - [x] 评估自适应调色板、FPS、颜色数和分辨率搜索策略
   - [x] 记录三档同一输入的体积、耗时、峰值内存和质量指标

   验收：三档参数在 UI 中可选择、可解释、可复现，且手动覆盖规则明确；已通过 `benchmarks/gif/e5/quality-report.json`、`quality-report.csv` 及 `npm run check:gif-quality` 完成同一输入的桌面端基准验收。现有 C4/E3 的质量代理定义为首帧 RGB MAE（越低越好），并记录输出体积、编码耗时和进程峰值内存。

#### E6：GIF 时间轴增强（依赖：B3、E1）

- [x] 支持起始帧/结束帧时间区间选择；导出使用同一选区，不修改原始帧列表
- [x] 支持时间轴拖动定位、75%/100%/150%/200% 离散缩放及帧时长批量修改
- [x] 时间轴、帧列表和预览共用帧对象与 durationMs 状态，导出按选区保持帧顺序和时长

验收：起始/结束帧、时间轴定位/缩放、单帧及批量时长修改均由同一份状态驱动；导出只使用当前区间并保持顺序/时长；取消和模式切换不清空已确认编辑。逻辑测试覆盖区间夹取、缩放标签与现有导出时长路径；`npm test` 189 tests、`npm run build`、`git diff --check` 均通过。桌面原生取消后的真实窗口回归仍未单独补测。

#### E7：图片输出真实预览（依赖：E1）

- [x] 预览 JPEG 质量、RGB565、BMP 位深和透明背景的像素级编码差异
- [x] 增加导出前输出参数对比卡：尺寸、格式、有效位深、背景/透明度状态实时同步；文件体积明确标注“导出后显示实际体积”
- [x] 预览参数摘要与导出请求共用当前格式、尺寸、位深和背景状态；导出失败仍保持参数模拟标识，不显示成功文件预览

验收：参数对比卡已覆盖 JPEG、RGB565、BMP 和透明 PNG 的有效位深/背景语义；`3a92751` 让 BMP/RGB565/透明 PNG 测试直接走 `build_image_preview`（`preview_image_export` 的唯一构造 helper），JPEG 质量输出可解码且差异可验证，8 MiB 限制有测试。像素编码契约已完成；真实导出文件回读 harness 仍未补齐，不影响本项 preview 编码契约验收。Blob URL 生命周期继续沿用现有 revoke 清理路径。

现有证据：`58ecf15` 增加 Rust `preview_image_export`、gateway 调用和响应字段测试，`019fc9a` 接入桌面真实编码预览；`51a64db` 直接覆盖 preview 编码路径的 JPEG 质量差异/可解码、透明 PNG alpha 和 8 MiB 限制，`3a92751` 将 BMP 位深和 RGB565 golden 断言统一路由到 `build_image_preview`。限制已明确：preview 输出上限 8 MiB；C-array/RGB565 是原始数据，不能作为图像视觉显示；浏览器环境不支持原生 preview，失败时只显示参数/错误，不冒充成功图像；真实导出文件回读 harness 仍是后续增强项。

#### E8：图片色彩与元数据（依赖：E7）

- [x] 明确 EXIF 方向的读取和落盘策略：当前不读取 EXIF Orientation，像素旋转只由显式 transform 控制；编码默认生成无 EXIF/ICC 的新文件，避免重复旋转
- [x] 提供默认清理元数据选项；`preserve` 明确拒绝，尚未宣称支持保留 EXIF/ICC
- [x] 验证 PNG/BMP/JPEG 的透明度输出与默认元数据清理；ICC 保留/色彩管理仍未覆盖

验收：默认 sRGB/清理策略、显式旋转不重复应用和透明像素回归已验证；`decfab7` 证明 PNG 无 `iCCP`/`eXIf`、JPEG 无 `ICC_PROFILE`/APP1，`metadataPolicy=preserve` 明确拒绝，旧请求默认 `strip`。不支持 ICC/EXIF 保留，也不宣称真实色彩管理；三项子任务保持勾选，限制作为产品契约记录。

#### E9：批量导出预检（依赖：B2、D2、E3）

- [x] 导出前保留重复目标预检，并在桌面端接入原生目录存在性、写权限和目标存在检查；允许覆盖原图/同名输出时不因 targetExists 误阻止
- [x] 显示预计成功/失败数量、逐项目标路径和原生返回原因；非 Tauri 明确显示“未执行原生文件系统预检”，磁盘空间明确显示未检查
- [x] 保留仅重试失败项，不重复覆盖已成功输出；原生预检失败在 `runExportQueue` 前阻止真正导出

验收：`b1b28ea` 在 Windows x64/ARM64 使用 `GetDiskFreeSpaceExW`，沿目标路径向上找到最近存在的父路径后检查可用空间；`estimatedBytes=0` 明确不检查磁盘空间，非 Windows 返回未检查而不伪造容量。原生预检覆盖目录不存在、权限不可写、重名目标、覆盖策略和仅重试失败项；`d3af8ab` 提供按格式/尺寸/位深/输入体积的估算并在不足时阻止导出。浏览器环境明确降级为不执行文件系统预检。现有 Rust、gateway、UI 逻辑测试和 `npm test`/`npm run build` 证据足以关闭三项；非 Windows 磁盘容量能力仍是已知限制。

### P2：格式扩展与长期能力

#### E10：图片格式扩展评估（依赖：E3、E8）

- [x] 评估 WebP、ICO、TIFF 的许可证和维护风险
- [x] 对比体积、编码耗时、色彩/透明度/元数据兼容性
- [x] 先提交评估结论，再决定是否实现生产支持

验收：每种格式都有许可证、体积、兼容性和测试成本结论；未通过评估前不增加生产依赖或用户可见格式选项。

评估结论（2026-09-25）：暂不加入生产依赖或用户可见选项。优先级建议为 WebP P2（已有基础，需先补齐质量/元数据契约）；ICO P3（仅适合图标管线）；TIFF P3（面向归档/专业图像，范围和测试成本最大）。

| 格式 | 现有链路与许可证/维护风险 | 兼容性与测试成本 | 结论 |
| --- | --- | --- | --- |
| WebP | `image 0.24.9` 已启用 `webp` feature；当前 image-rs 0.24 文档/变更记录表明 WebP 编码为无损路径，仓库另有 `webp-animation 0.10`/`libwebp-sys2`（MIT OR Apache-2.0 / BSD-3-Clause）。上游成熟但 C 库绑定带来跨平台构建和安全更新跟踪成本。 | 支持透明度，适合网页体积；需明确 lossy/lossless、动画、ICC/EXIF/XMP 保留策略。需补充 RGBA 往返、质量/体积回归、metadata/恶意文件限制测试。 | P2 评估后再做；不能把现有 WebP 动画能力等同于静态有损编码能力。 |
| ICO | 当前生产 `image` feature 未启用 `ico`；Cargo 元数据中的 `ico 0.5.0` 为 MIT，维护面小，且 ICO 有 256×256 尺寸上限和多尺寸/位深组合语义。 | 透明度可由 PNG 图像承载，但多尺寸、热点/调色板和 Windows 图标兼容性需要专门契约；应覆盖 16/32/48/256 多尺寸、alpha、损坏目录和 Windows shell 读取。 | P3，仅在明确需要应用图标导出时考虑，不作为通用图片格式。 |
| TIFF | 当前生产 `image` feature 未启用 `tiff`；image-rs 通过 TIFF 依赖提供能力，许可证/压缩组合和维护风险需按实际 feature 锁定后复核。 | 可表达高位深、灰度/CMYK、alpha、ICC/EXIF，但压缩、页/帧、BigTIFF、色彩解释差异大；需覆盖多页、CMYK、ICC、16-bit、压缩变体、资源上限和 round-trip。 | P3，除非产品出现归档/专业印刷需求，否则测试与兼容矩阵不值得进入当前导出链。 |

可复现实测（仅工具链量级参考，非生产编码链）：Windows 本机用 FFmpeg `testsrc2` 生成固定 320×180 PNG（7,448 bytes）；WebP 用 `cwebp -q 80`，TIFF/ICO 用 FFmpeg 默认编码。单次 `Measure-Command` 结果：WebP 4,154 bytes / 42.8 ms，TIFF 174,084 bytes / 56.7 ms；ICO 因 320×180 超过 256×256 限制失败，改用 256×144 后为 115,388 bytes / 57.6 ms。该样本不是同编码器、不是质量等价比较，耗时受进程启动影响，只用于暴露尺寸和典型成本；没有据此宣称生产性能。来源与复现：`ffmpeg -f lavfi -i testsrc2=size=320x180:rate=1 -frames:v 1 fixture.png`、`cwebp -q 80 fixture.png -o fixture.webp`、`ffmpeg -i fixture.png fixture.tiff`；上游格式能力参考 [image-rs codecs](https://docs.rs/image/latest/image/codecs/)、[image-rs 0.24 变更记录](https://github.com/image-rs/image/blob/main/CHANGES.md)、[libwebp BSD 许可](https://github.com/webmproject/libwebp)。

未决项：若未来进入实现，先固定目标格式、质量/压缩参数、ICC/EXIF/XMP 保留规则和资源上限，再补跨平台 round-trip、恶意输入、体积/耗时基准；本条评估不改变生产依赖、导出实现或 UI 选项。

## 通用验收门禁

- [x] `npm test`
- [x] `npm run build`
- [x] `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- [x] `cargo check --manifest-path src-tauri/Cargo.toml --locked`
- [x] `cargo test --manifest-path src-tauri/Cargo.toml --locked`
- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings`
- [x] 工作区无未提交残留
- [x] 通过后 push 到 `main`

证据：CI run 35862950286 三个平台全部通过，本地回归验证通过。
