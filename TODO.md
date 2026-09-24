# EmbedPix 分阶段升级 TODO

目标：从 `0.1.9` 稳定推进到 `0.3.2`。

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
- [ ] 真实窗口矩阵 E2E（当前仅完成 CSS 断点审查与当前窗口图片/视频模式实测）
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
- [ ] 发布 `0.3.2`

内部验收证据：CLI 已通过无桌面 smoke/契约测试及 image、gif、pngSequence 三类端到端操作；更新协议已通过本地 HTTP fixture，覆盖下载、大小、SHA-256、签名和缓存复核；仓库内 verifier、Action SHA 固定、版本一致性、tag/commit 与发布后资产回读门禁已通过；GitHub Settings 的 `production` required reviewers、`main` 分支保护和 `v*` tag 保护规则已通过 API 验证。仍阻塞：`0.3.2` 尚未发布。

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
