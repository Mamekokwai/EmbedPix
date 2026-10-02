# EmbedPix 图片压缩功能 TODO

> 依据：[图片压缩功能设计文档](./image-compression-design.md)
>
> 当前目标：先完成第一阶段本地 PNG/JPEG/WebP 压缩闭环，再推进自动择优和高级编码器。
>
> 状态约定：`[ ]` 未开始，`[~]` 进行中，`[x]` 已完成，`[!]` 阻塞或需要决策。

## 当前执行状态（2026-10-02）

- 第一阶段闭环已交付：PNG/JPEG/WebP 单图批处理、桌面原生压缩命令、预检、进度、取消、失败重试、临时文件与原子发布、覆盖保护、响应式工作台；新增活动 `jobId` 冲突保护、最多 2 个并发编码 slot 和最多 8 个活动任务，避免取消/进度串任务及内存峰值失控。原生压缩预览现在也注册独立任务，支持排队取消、编码检查点、终态记录和槽位回收；每次预览使用唯一内部 native ID，并对原生注册尚未完成的极短窗口做有界取消重试。GIF spool 现在锁先于目录创建，启动清理仅在确认未被其他实例持有时回收过期目录或无目录 stale lock，并使用不覆盖的 quarantine 保护创建崩溃窗口。GIF/压缩工作台已懒加载，主入口约 342 kB、gzip 约 104 kB，切页后通过隐藏保活保留状态。
- 交互与诊断增强：格式感知的高质量/平衡/小体积/自定义预设已落地；JPEG 渐进式与优化 Huffman 选项已接入并默认关闭；进度响应增加兼容性的可选错误码；发布链路增加本地 manifest/PE 边界 fixture。
- 视频转 GIF 稳定性补强：视频抽帧等待 `loadedmetadata` 现在与元数据读取共用 15 秒超时，超时会释放视频资源并返回可读错误；视频源绑定也纳入统一 `try/finally` 清理，独立元数据读取在源绑定异常时立即失败并清理，新增生命周期回归，避免不支持的编码长期挂起。
- 图片转换稳定性补强：输入尺寸读取已提取为可注入模块，加载成功、解码失败、`src` 绑定异常和 15 秒无响应都会恰好回收 Blob URL/事件监听，并由独立生命周期测试覆盖。
- 压缩工作区稳定性补强：压缩队列读取图片尺寸现在同样有 15 秒超时；`createImageBitmap` 超时后仍会在迟到结果到达时关闭位图，回退图片加载会清除事件监听并回收 Blob URL，避免坏文件或浏览器解码器长期占用任务。
- GIF 图片帧稳定性补强：帧导入、预览和编码前读取统一增加 15 秒超时；成功、失败、尺寸无效、`src` 绑定异常和超时都会清除图片监听，避免单个坏帧让 GIF 工作区永久等待。
- GIF 导入取消进一步收紧：导入队列为每批任务提供 `AbortSignal`，清空帧、组件卸载或新批次取消时会立即中止正在等待的图片解码，并保留旧版本校验防止过期帧写回。
- 图片转换尺寸读取取消进一步收紧：替换图片或卸载工作区会主动中止旧的尺寸读取，清除事件监听并回收 Blob URL；新增 AbortError 生命周期回归。
- 发布后校验增强：`prepare-release` 在上传后读取 `latest.json` 时增加 6 次有界传播重试，并输出实际版本/平台诊断，避免 GitHub 资产短暂传播延迟误判为发布失败；该契约由 `check:release-config` 固定检查。
- GIF 预览与导出读取接入取消信号：切换预览帧、卸载工作区或取消导出时立即停止当前图片解码，不再仅依赖超时回收。
- 压缩工作区尺寸读取接入按项目取消信号：移除/清空/替换图片和卸载页面会立即取消对应 `createImageBitmap` 或回退图片读取，并确保迟到位图仍关闭、错误不回写到队列。
- 最新门禁：前端 34 个测试文件 / 421 项测试通过；生产构建与桌面 smoke 通过，GIF Rust 35 项和图片导出/回滚 46 项通过。
- 本轮回归结论：WebP 有损已接入静态 `libwebp-sys2` 0.2.0 封装；method 0–6 已通过初始化 FFI 接入 RGB/RGBA、预览、估算和候选搜索，默认 method=4 与旧路径兼容；无损 WebP 新增 80/90/95 近无损等级，标准无损仍为默认，三条编码路径共用同一协议并验证无动画块、尺寸、解码和 Alpha。目标体积候选搜索次数现可在前端选择 1–12 次，默认 8，偏好和自定义预设向后兼容，核心仍强制范围校验；预览、估算和正式结果现在返回并展示实际候选数量与搜索耗时（旧核心响应缺失这些字段时安全隐藏），正式候选搜索在每次编码前后检查取消信号。元数据策略也纳入三类原生响应，正式压缩、预览与估算会回报实际采用的 `strip`、`stripAll` 或 `stripSafe`；`stripAll` 使用无元数据编码路径并保持旧 `strip` 兼容，WebP `stripSafe` 仅限静态同格式路径并回报实际策略，估算请求不再隐式依赖核心默认值。由 Rust 边界负责质量范围、输出复制与释放。JPEG 透明输入现在必须按 `jpegBackground`（默认白色）合成后再编码，不再静默丢弃 Alpha；正式输出与体积估算共用同一背景策略，并验证解码结果与颜色接近度。当前 x64 Windows 静态构建已通过；ARM64 尚未在本环境安装目标，发布前仍需按架构复核。JPEG EXIF Orientation 已通过固定 `kamadak-exif` 0.6.1 在 strip 解码入口归一化。
- 第二阶段已交付：压缩后更大则跳过、源文件夹/子目录/指定目录输出、实际输入输出体积与节省统计、逐项原图/输出（或候选）体积与节省/增加比例、跳过原因展示；批量导入现在会按稳定 itemId 关联同名文件的重试和体积统计，并在进入队列前拦截超过 32 MiB 的图片。
- 第一阶段限制：单文件输入上限可在 1–32 MiB 内配置，默认 32 MiB，native 硬上限不会被放宽；WebP 有损使用质量 1–100、method 0–6、分析遍数 1–10 和 Alpha 质量 0–100（默认分别为 1 和 100；分析遍数影响编码分析耗时与结果，不代表画质）；无损 WebP 支持可选 method 0–6，默认不发送并保留旧编码路径，近无损继续支持 1–99 协议值；JPEG 不支持无损，含透明像素时按已校验的 `#RRGGBB` 背景合成（默认白色）；压缩支持 `strip`、PNG→PNG/JPEG→JPEG/静态 WebP→WebP 的 `stripSafe` 和明确删除所有可由当前编码器输出的元数据的 `stripAll`，`preserve` 仍由 native 以明确理由拒绝；三种 `stripSafe` 只保留结构合法且有界的 ICC payload（不保证 ICC 内部色彩语义），并移除 EXIF/GPS/XMP/COM/其他输入 metadata；浏览器预览不能直接执行原生压缩；同名文件默认拒绝写入，不自动改名。
- 下一阶段优先级：完整元数据策略、可选编码后端与跨架构发布复核；当前压缩结果已明确回报实际模式与编码后端，但尚未开放用户选择 auto/backend。
- 本轮运行时复核：压缩页在 360×500、320×480 下无横向溢出，GIF 页在相同尺寸展开设置时 footer 与设置卡无重叠，700×1100 窄宽布局保持单列；本轮已完成 GIF 异步交互修复并通过回归验证。图片转换、压缩预览、GIF 帧/视频抽帧和下载 Blob URL 已复核创建/回收配对，取消、过期请求、替换、删除、清空及卸载路径未发现可证实的新泄漏；压缩尺寸读取已提取为可注入契约，覆盖 `createImageBitmap.close`（含尺寸 getter 异常）以及 fallback Blob URL 在加载成功、失败和 `src` 赋值异常时的一次性回收。签名预检已能执行临时签名并用独立 verifier 校验受信公钥，缺少私钥时会在构建前失败。
- GIF/视频工作区交互审查：导入/拖放控件支持 `role=button` 的 Enter/Space，文件 input change 会清空 value 以支持同文件重选；GIF drop zone 与图片转换视图隔离；帧编辑与导出均有 disabled 与运行时 guard；时长手动编辑可切回 `custom`；压缩规划旧结果会失效且 request-safe；视频模式切换会取消过期抽帧；pending 图片导入期间阻止视频导入；取消 pending 导入可用并静默处理旧解码错误；尺寸读取在移除/清空或组件卸载后不会写回；压缩工作台的文件/文件夹导入、取消任务和打开输出目录错误、压缩跳过原因、native 格式边界错误、图片转换工作台的读取/检查/编码/写入/输出目录选择/导出预检错误、批量文件名模板规划错误、工作区导入校验错误以及预设导入校验错误会将已知协议前缀本地化并保留细节；更新页会显示失败原因、隐藏纯英文底层错误，并对发布页打开错误做同样脱敏，移除单项会清理对应尺寸错误；无帧或导出中按钮保持禁用。前端 32 个测试文件 / 381 个测试通过，types 与 lint 通过。
- 本轮已完成两项协议修复：图片转换批量原生磁盘预检现在按每个输入的实际目标尺寸累计预算，修复混合尺寸与保持比例场景下的预算偏差；GIF/WebP/APNG 导出参数摘要现在显示自动压缩实际采用的候选尺寸，并在参数变化后清除陈旧候选状态。
- 本轮已完成第三项协议修复：图片转换预检摘要现在会在输出位置、目录、文件名模板、序号、覆盖和删除等所有导出计划参数变化时失效，避免继续显示旧预计体积和旧目标路径。
- 本轮已完成第四项交互修复：压缩参数在空闲状态发生变化时会清除上一批任务的成功/失败/跳过结果、体积统计、最近输出路径和预检空间预算；任务执行中不打断当前批次，避免旧结果被误认为当前参数结果。
- 本轮已完成第五项交互修复：GIF 结果失效 effect 纳入视频源模式、FPS、抽帧间隔、最大帧数、裁剪、旋转和倒放参数；仅修改视频参数时会清除旧规划/摘要/输出路径，但保留已提取帧，等待用户重新抽帧。
- 本轮已完成发布可靠性修复：发布后验证 `latest.json` 时加入 `Cache-Control: no-cache` 与 `Pragma: no-cache`，避免 CDN/代理缓存旧 manifest 让已有重试循环重复读取旧版本；发布 URL 与签名校验协议保持不变。
- 本轮已完成更新页状态修复：只有“已是最新/发现新版本/检查失败/离线”这些检查结果会刷新“上次检查”，下载取消、下载完成和安装失败不会伪装成新的检查时间。
- [x] 本轮新增功能与门禁：支持复制本次批处理摘要、下载 JSON 批处理报告；新增 PNG/JPEG/静态 WebP formal 结果与磁盘实体追踪矩阵，覆盖完成结果字段、最终路径、磁盘长度、输入长度、元数据策略、格式/尺寸回读，以及 skipped 无临时残留。
- [x] 门禁统计修正：当前前端为 32 个测试文件 / 382 个测试通过；本轮 release fixture 使用固定 UTC 输入，重复执行的 manifest/asset summary 结果一致。
- [x] 本轮收尾：支持“仅重试此项”；release fixture 已覆盖 `release-provenance.json` 的 `workflow_ref` 与 `release_commit` 篡改拒绝。
- [x] 前端门禁统计更新：32 个测试文件 / 383 个测试通过。
- [x] 本轮报告与发布门禁收尾：GIF/视频 GIF 导出结果支持 JSON 报告；SHA256SUMS 哈希篡改与重复条目拒绝用例已完成；前端当前为 32 个测试文件 / 385 个测试通过。
- [x] 本轮新增完成项：图片转换栅格正式输出在发布前执行解码/尺寸回读校验；GIF 输入变化会清除陈旧导出操作；release fixture 会拒绝 manifest version 漂移。
- [x] 门禁统计更新：前端 32 个测试文件 / 386 个测试通过；Rust 270 个库测试 + 4 个 CLI 测试通过；desktop smoke 图片导出测试已增至 46 项。
- [x] 本轮交互与诊断收尾：压缩进度条补齐 `role=progressbar` 语义；GIF 进度帧数执行边界 clamp；签名预检清理失败显示残留目录路径。
- [x] 当前门禁统计确认：前端 32 个测试文件 / 386 个测试通过；Rust 270 个库测试 + 4 个 CLI 测试通过；图片导出 smoke 46 项；release manifest 版本漂移拒绝与签名清理路径诊断均已验证。
- [x] 发布收尾：GIF/视频 GIF 导出进度补齐 `role=progressbar` 语义；release notes 版本漂移拒绝用例已完成；本轮 release fixture 与 desktop smoke 均通过。
- [x] 本轮批处理与资产门禁收尾：累计压缩批处理进度摘要已完成；release fixture 已覆盖 x64 签名资产 `browser_download_url` 篡改拒绝。
- [x] 本轮门禁确认：前端 32 个测试文件 / 387 个测试通过；压缩 CLI、release fixture、release config、desktop smoke 全部通过。
- [x] 本轮可访问性收尾：累计压缩批处理进度摘要增加 `aria-live` 通知；前端当前为 32 个测试文件 / 387 个测试通过。
- [x] `targetResize` 分阶段接入：固定 `targetResizePercent` 与 `autoResizeToTarget` 均已完成安全缩放；默认关闭、仅允许 10–100%、禁止放大、保持宽高比，JPEG/有损 WebP 的 preview/estimate/formal/CLI 共用同一份 resize preparation，Lanczos3 缩放并复用尺寸上限。结果额外回报 `originalInputBytes`/`preparedInputBytes`/`selectedResizePercent`，现有 `inputBytes` 明确定义为源文件体积，跳过和节省率按源文件比较；缩放准备阶段有取消检查并受单文件输入预算约束。
- [x] 本轮增量：输出缩放支持自定义 10–100% 输入，不再局限于预设档位；偏好、自定义预设、参数摘要和格式切换清理均已覆盖。当前门禁为前端 32 个测试文件 / 392 项通过，Rust 277 项、CLI 4 项；构建与 compression CLI smoke 已通过。
- [x] 自动目标体积联动缩放（2026-10-01）：Gateway/native/CLI 新增 `autoResizeToTarget`，默认关闭且只接受 JPEG/有损 WebP + `maxOutputBytes`；preview/estimate/formal/CLI 共用 `prepare_and_choose_output`，按 100/75/50/25/10% 有界尝试，质量候选预算在所有轮次合计不超过 `maxCandidates`，每轮检查取消；目标不可达统一返回 skipped，正式路径在 writer 前拒绝发布并保持目标文件不变。前端增加互斥开关、窄窗口可换行提示、偏好和自定义预设持久化；结果统一返回最终 `selectedResizePercent`，预检返回候选轮数、峰值准备输入、峰值编码候选和像素预算；CLI 烟测额外验证不可达目标不会覆盖已有同名输出。当前回归：前端 32 个测试文件 / 394 项、Rust 278 项库测试、CLI 4 项。
- [x] 压缩诊断可访问性收尾：本地化跳过原因保留 `nativeReason` 到逐项结果与 JSON 报告，预览与逐项结果同时提供可聚焦设备可读取的辅助文本；不改变 native 写入、覆盖、取消或重试语义。完整前端测试 394 项、构建与 desktop smoke 均通过。
- [x] GIF 帧编辑可访问性收尾：帧列表支持方向键、Home/End、Delete/Backspace，焦点跟随选中帧和删除后的新选中帧；锁定、抽帧 pending、导出中保持禁用，现有多选/拖拽/排序协议不变。前端全量测试 396 项、构建与 desktop smoke 通过。
- [x] GIF 帧编辑竞态收尾：导入、视频抽帧、测量、规划和导出期间统一禁止拖拽、倒序、改序、复制、删除及时长编辑，同时保留图片导入、视频抽帧和导出取消入口；新增 busy 状态矩阵测试，前端全量测试 397 项、构建与 desktop smoke 通过。
- [x] 发布 URL 完整匹配门禁：release asset 与 `latest.json` 的 URL 均拒绝可信 GitHub host 下错误仓库、Tag、query string 和 fragment，合法资产集合保持通过。
- [x] GIF 短高窗口可达性收尾（commit `035285f`）：取消导入并清空按钮并入统一底部操作栏，与取消抽帧、取消测量和取消导出保持同一可见区域；窄窗口下不会被 GIF 设置卡遮挡。相关前端回归保持 397 项通过。
- [x] 紧凑视口布局契约（commit `ccefcdd`）：静态测试固定覆盖 320×480、360×500、700×1100，并守护 GIF 短高 sticky footer/取消操作、横向溢出隔离以及压缩参数单列与长文本换行规则；前端回归增至 398 项。
- [x] 压缩参数快速恢复（commit `7223ac4`）：压缩参数卡新增“恢复平衡默认”，完整恢复格式、质量、WebP 分析遍数、PNG 透明像素优化、JPEG 背景、目标体积、自动缩放、输入上限和元数据策略；不清空队列，也不改变输出位置、文件名或覆盖/删除策略。前端回归增至 399 项。
- [x] 更新器重定向与缓存清理契约复核（commit `70555f3`）：可信 GitHub host 下错误 Tag、仓库、query 和 fragment 变体均被拒绝；清理 `.part`、`.sig.part`、`.etag` 时保留已提交安装包与签名。当前证据为本地单测/fixture，不冒充真实 GitHub 网络覆盖。
- [x] 发布诊断收尾：`scripts/release-signing-preflight.ps1` 支持 `-ReportPath` 输出不含私钥/签名内容的脱敏 JSON 预检摘要；验收统计为前端 32 个测试文件 / 387 个测试通过。
- [x] 发布门禁复核：`npm run check:release-config`、`npm run check:release-signing-cleanup`、`npm run check:release-fixture` 均通过。
- [x] 签名预检报告安全契约（commit `8696532`）：报告字段白名单、敏感字段拒绝和 UTF-8 无 BOM 写入均由 `check:release-config` 校验并通过。
- [x] 签名预检报告原子提交（commit `30b90ad`）：`ReportPath` 使用同目录 `.part` 临时文件与 `File.Replace`/`File.Move` 提交，失败时保留旧报告并清理临时文件；`check:release-config`、`check:release-signing-cleanup`、前端 32 个测试文件 / 388 个测试及 build 均通过。
- [x] 发布报告归档（commit `606bb37`）：`prepare-release.yml` 显式生成并按架构归档 `signing-preflight-report.json`，缺失报告会阻断发布；`release-config`、`release-fixture`、前端 32 个测试文件 / 388 个测试通过。
- [x] 发布报告内容门禁（commit `b6a6c33`）：`prepare-release` 解析并校验签名预检报告的 version、三个 `passed` 状态和 UTC 时间戳，失败阻断发布；`release-config`、`release-fixture`、前端 32 个测试文件 / 388 个测试及 build 均通过。
- [x] 核心格式门禁修复（commit `fc59dfa`）：图片转换正式栅格输出在发布前新增实际格式签名校验，防止请求格式与实际编码格式不一致；`export_image` 46 项 Rust 测试、build、types 与 lint 均通过。
- [x] 压缩协议收敛（commit `de82d1f`）：formal/preview/estimate/WebP 候选共用请求格式与尺寸验证，并新增格式错配回归；压缩 Rust 87 项测试、前端 32 个测试文件 / 388 个测试及 build 均通过。
- [x] GIF 页头响应式修复已完成（commit `6748493`）：320–620px 宽度支持标题与控件换行且控件保持可聚焦，宽屏布局不变；前端验收统计为 32 个测试文件 / 388 个测试通过。
- [x] 本轮门禁复核：桌面 smoke、compression CLI smoke、release dependency smoke、GIF benchmark 8/8、GIF quality benchmark 3/3 均通过；前端统计保持 32 个测试文件 / 388 个测试通过。
- [~] 发布资产状态保持谨慎：未安装/未签名的真实 x64 或 ARM64 发布资产不标记为完成，仍需对应签名资产与安装/启动验收。
- [x] 本轮用户流程审查：GIF、视频 GIF 与图片转换流程未发现可在现有依赖和设备条件下安全补齐的低风险缺口。
- [~] 发布环境边界：发布链路本地门禁已覆盖；ARM64 安装/启动/卸载与 macOS/Linux 自动更新仍需真实签名资产或对应设备，暂无法由本地 fixture 替代。
- [~] 编码后端实验门禁：MozJPEG/libavif 仍保持未引入、默认关闭；接入前必须完成版本与上游来源锁定、精确 NOTICE/许可证审计、静态/动态链接证据、每架构 encode→decode/Alpha/元数据回读、x64 与 ARM64 安装启动卸载 smoke，并将证据纳入签名 manifest。当前本地依赖 smoke 不覆盖这些候选后端。
- [x] 未审计编码后端阻断（commit `9992df7`）：release dependency smoke 会拒绝锁文件中出现的 MozJPEG、libavif、AOM、rav1e、SVT-AV1、libyuv、dav1d 等候选包，并明确提示 NOTICE、许可证/专利、链接方式、跨架构和真实 runner 验收要求；当前依赖集合保持不变。
- [x] 编码后端阻断回归契约（commit `4ffeb11`）：拒绝逻辑抽为可注入的 `Assert-NoUnreviewedCodecBackends`，release-config smoke 同时守护函数、候选名称和失败提示，防止后续发布脚本回归放行未审计后端。
- [x] GIF 导出结果操作回归契约（commit `c3f827d`）：静态布局测试守护成功导出后“打开文件夹”“复制路径”“下载 JSON 报告”三项操作及窄屏换行规则；失败/取消仍由 `lastExportPath` 门控，不改变导出协议。
- [x] GIF 参数快速恢复（commit `381ad5a`）：新增“恢复平衡默认”，覆盖画布、帧时长、首尾停留、播放、背景/循环、颜色/抖动、目标体积、自动压缩、合并相同帧及视频 FPS/抽帧/裁剪/旋转/倒放；保留素材、输出格式、输出位置、文件名和覆盖策略，视频源仅标记需要重新抽帧。前端回归增至 400 项。
- [x] GUI 启动参数发布契约（commit `6cd43cd`）：发布配置 smoke 固定检查 Windows GUI 在显式参数路径中先准备控制台、再输出诊断、最后以退出码 2 结束；同时保留 GUI subsystem 与独立 CLI binary 边界，不接触签名密钥。
- [x] 主线全量回归复核（2026-10-01）：前端 32 个测试文件 / 400 项通过；Rust library 279 项通过；压缩 CLI、GIF benchmark 8/8、GIF quality 3/3、release config、release fixture、签名清理 smoke 均通过，工作树与 `origin/main` 一致。
- [x] JPEG 视觉质量门槛：`maxRgbMae` 现在支持目标体积下的有损 JPEG 与 WebP；JPEG 透明输入先按 `jpegBackground` 合成再计算 RGB MAE，候选搜索、preview/estimate/formal、CLI、Gateway、UI 和自定义预设共用范围校验，默认关闭且不可达时不发布。新增透明背景回归、CLI smoke 与前端门禁，当前 Rust library 280 项、前端 401 项通过。
- [x] 压缩预览滑动对比：在保留并排预览的基础上增加原图/压缩结果分界线与键盘可操作范围控件，便于在同一画布快速观察细节变化；不改变原生压缩协议、Blob URL 生命周期或窄窗口单列布局。
- [x] CLI 格式边界回归：目标体积、自动缩放和 `maxRgbMae` 的 JPEG/WebP 判断统一改为大小写不敏感，避免 `JPG`、`JPEG` 或 `WebP` 命令行请求被错误拒绝。
- [~] `v0.7.5` 发布准备：消除签名预检脚本首行 BOM/空白歧义；待本地发布门禁通过后由新 tag 触发真实签名资产与安装启动验收。
- [x] 发布效率优化：签名预检从 x64/ARM64 矩阵中前置为单独 job，两个架构构建复用同一通过结果；不改变各架构实际签名和资产校验。
- 本轮新增 `compressionGateway` 四入口 envelope 矩阵回归：覆盖 PNG/JPEG/静态 WebP、格式专属字段不泄漏，以及非法组合在 IPC 前拒绝。
- 本轮完成预检临时空间预算状态修复：参数、输入或选中项变化时清除旧预算，任务完成后保留最近一次有效预算。
- 本轮新增 updater 签名提交/安装包提交边界清理回归：验证临时 `.part`、签名临时文件和 `.etag` 清理，以及既有/已提交缓存的保留或失败清理语义；真实异步 rename 间隙尚未通过 hook 注入验证，未扩大覆盖声明。
- 本轮修复 stripSafe 校验状态回归：pending/valid/invalid 三态期间不再把用户选择误降级为 `strip`，只有明确失败才回退；空队列不会触发误清理。
- 本轮补齐 stripSafe preview/estimate pending 门控：校验完成后自动重试，明确失败降级后也自动重试，避免 native 暂态错误固化为错误结果。
- 本轮补齐 stripSafe 校验身份绑定：身份同时绑定输出 format、队列顺序、项目 id 与 File 引用；同 id 替换文件会使旧校验失效，dimensions 等展示字段更新复用当前快照；pending 快照避免重复读取文件内容。
- 当前门禁：前端 32 个测试文件 / 381 个测试通过；类型检查、ESLint 和构建通过；Rust 269 个库测试 + 4 个 CLI 测试通过；本轮 desktop smoke、compression CLI、release config、release fixture 均通过；构建、clippy、OxiPNG 强制 smoke、GIF 8/8 性能与 3/3 质量门禁、发布配置与本地 release fixture smoke、压缩 CLI smoke 通过；真实 `v0.7.0` 发布资产 smoke 已完成。压缩任务和预览现在会按读取、解码、规划、编码、校验、发布报告阶段，界面显示当前文件、阶段和实时体积，未知阶段保持向后兼容；正式结果、预览和估算会回报实际压缩模式（无损/有损）及编码后端（OxiPNG/image JPEG/libwebp），前端参数摘要和预览信息会展示这些字段；估算 UI 保留并展示原生 `targetMet`、`selectedQuality`、候选数量、搜索耗时和质量指标等字段；本轮已完成 preview/estimate/formal compress 的协议一致性审计，确认三者共用请求校验、候选选择、输出回读、质量指标与 metadataPolicy 语义。导出前参数摘要会展示格式、质量/编码参数、目标体积、元数据和输出策略；WebP 有损预览、估算和逐项正式结果现在额外展示 RGB MAE、PSNR 与 Alpha 差异像素，仅作相对比较参考，并支持 0–100 的 Alpha 质量控制和 1–10 的分析遍数；工作区和预设 JSON 下载统一延迟撤销 Blob URL，避免下载尚未启动时失效；PNG 的 `lossless=false` 现在在正式压缩与估算入口统一拒绝，避免静默生成无损结果；`strip` 策略已用带 JPEG EXIF APP1 的输入验证 PNG/JPEG/WebP 输出不会复制该元数据；GIF 窄短窗口不再把素材/预览行压缩到 96px，改为内容驱动最小高度并新增布局契约；360×500 运行时展开 GIF 画布设置时，导出栏会回到正常文档流，避免与设置卡重叠；旧版本偏好或自定义预设若携带未支持的 `preserve`，现在会安全拒绝并使用明确的 `metadata_policy_unsupported` 分类；PNG→PNG/JPEG→JPEG/静态 WebP→WebP `stripSafe` 与 `stripAll` 已可执行：UI/Gateway 对 PNG/JPEG 按实际 `inputData` 做签名/格式匹配校验；WebP 额外执行 RIFF/chunk/动画/重复块/坏 padding/截断/溢出/ICC/输出白名单校验；PNG/JPEG 结构、CRC、解码和 metadata 最终由 native 门禁负责；WebP 只接受静态输入，ICCP 经过有界结构校验，输出由 RAII mux 清理 EXIF/XMP/旧 ICCP，仅允许 VP8X、VP8/VP8L、合法 ALPH 和最多一个合法 ICCP，动画、重复块、坏 padding、截断或非白名单输出拒绝；正式压缩、预览和估算摘要都会显示实际采用的元数据策略；压缩工作台新增桌面源文件删除选项，并由核心保证发布成功后才删除；目标体积候选搜索现在在每次编码前后响应取消；正式压缩 IPC 入口现在也会在前端拒绝越界 JPEG 质量、目标体积、32 MiB 硬上限和用户配置的 1–32 MiB 单文件输入，避免无效任务进入原生队列；正式压缩和原生预览在等待并发编码槽位时都响应取消，并在进度中明确显示“排队等待”；窗口自绘关闭与 Alt+F4 和系统关闭都会先有界取消活动压缩/GIF 任务，原生监听生命周期和超时期间的取消调用均有测试；错误码分类现在由 `CompressionErrorCode` 内部统一收敛，外部字符串协议保持兼容；本轮已覆盖损坏 PNG/JPEG/GIF 的 `decode` 分类与发布保护；压缩进度轮询取消/卸载清理已覆盖；更新器新增独立取消下载按钮，取消不显示为失败、清理本次临时文件但保留合法缓存并可直接重试；并覆盖了 hook 中“取消事件/Promise reject 竞态”，不会把取消误呈现为失败；压缩取消与已完成原生任务的竞态也已区分，已发布成功不会被误标成取消。
- 发布脚本兼容性回归：`release-config-smoke.ps1`、签名预检及清理 smoke 均固定为 UTF-8 BOM，并由 release config smoke 静态检查 4 个脚本的 BOM；Windows PowerShell 5.1 Parser、`pwsh`、发布配置、签名清理和本地 release fixture smoke 均已验证通过。

- 当前 UI、偏好和自定义预设已支持 PNG/JPEG/静态 WebP `stripSafe`；`preserve`/WebP 元数据 `preserve` 仍保持未完成状态。
- stripSafe 组件层 React 挂载测试暂未引入新测试依赖；当前 UI/Gateway 对 PNG/JPEG 仅按实际 `inputData` 做签名与格式匹配校验，对 WebP 做已有静态 RIFF/chunk/动画/输出白名单校验；PNG/JPEG 的结构、CRC、解码和 metadata 最终门禁由 native 承担，WebP 再由 native 静态门禁形成双重保护，后续统一 UI 测试 harness 时补混合队列/异步验证状态测试。PNG/JPEG 浏览器结构预检尝试已撤回：合法 Gateway 最小样本兼容性尚未闭合，且 JPEG 多 SOS 状态机容易产生误拒绝。
- 若重做 PNG/JPEG 浏览器结构预检，必须先准备真实 PNG chunk CRC、baseline/progressive 多 SOS fixtures，并补齐 UI/Gateway/native 三层一致性测试，确认合法输入不会被浏览器预检误拒绝后再接入。

## 0. 总体门禁

- [x] 创建独立压缩工作区，不破坏图片转换和 GIF 制作现有流程。
- [x] 所有图片处理默认本地完成，不上传图片。
- [x] 压缩输出统一使用临时文件、解码校验和原子发布。
- [x] 默认不覆盖、不删除源文件，压缩后更大时默认跳过。
- [x] 取消、失败、切页不会留下不可清理的临时文件；GIF spool、更新下载临时文件和 Blob URL 均有清理/回收测试；`pending-install.json.part` 已在启动清理中按固定路径安全回收，并有 marker 保留/清除与文件/目录异常测试。更新器已提供独立用户取消下载命令：取消覆盖签名读取、安装包 chunk、重试和原子提交前边界，统一清理本次 `.part`、`.etag`、签名临时文件，保留已有合法最终缓存；进度进入 `cancelled` 终态且 UI 可直接重新下载。
- [x] 构建产物清理安全门禁：Windows/Linux 都拒绝 repoRoot 到目标之间任意 parent symlink/junction/reparse point；Windows 缺失目标安全 Skip，dry-run 与实际删除共用同一检查。已验证 Windows `check-cleanup`、Linux `check-cleanup`、`npm test`（340）、`cargo test`（253 + 4 CLI）、`check:release-config` 和 `check:release-signing-cleanup`。
- [x] 全仓解码入口安全审查：普通图片、`preserve`、压缩、GIF 序列、WebP/APNG 动画均具备尺寸、像素、`max_alloc`、帧数/累计资源预算与发布前回读校验；损坏或截断输入不会发布。已复核 export_image 44、GIF 35、animation 8、sequence 12 相关测试通过。
- [x] 输出位置、覆盖、`bak` 与删除源文件沿用现有安全策略；删除源文件仅允许桌面源文件队列，成功发布并校验后执行，失败或跳过保留源文件。
- [~] 前端、Rust、桌面 smoke 已通过；发布资产门禁需下一个带真实 release 资产的版本再验收。
- [x] 新增编码器的许可证、版本和第三方声明完成审查：`kamadak-exif=0.6.1` 已固定并核对 BSD-2-Clause；`jpeg-encoder=0.7.1` 已核对 `(MIT OR Apache-2.0) AND IJG` 并补充 Independent JPEG Group 可执行分发声明；WebP 有损复用已在依赖树中的 `libwebp-sys2=0.2.0` 静态绑定，Rust crate 为 BSD-3-Clause，bundled libwebp 源码保留 BSD/WebM 许可文件。

## 1. M0：任务拆分与架构准备

### 1.1 领域边界

- [x] 明确图片压缩与图片转换的边界：压缩负责文件体积，转换负责像素/格式/嵌入式输出。
- [x] 明确第一阶段输入：PNG、JPEG、WebP、BMP、静态 GIF；动画 GIF 和动画 WebP 在统一解码入口明确拒绝，不静默压缩首帧。
- [x] 明确第一阶段输出：PNG、JPEG、WebP。
- [x] 明确第一阶段不包含：动画 GIF/APNG/WebP、AVIF、JPEG XL、PNG 有损量化。
- [x] 明确格式模式边界：PNG 只接受无损模式，JPEG 只接受有损模式；正式压缩与估算共享同一校验。
- [~] 统一格式、模式、后端、元数据和进度枚举：实际 `CompressionMode`/`CompressionEngine` 已在结果、预览和估算响应中落地，输入侧的 `auto`/可选后端仍待扩展。
- [x] 统一压缩任务错误码和用户可读文案：native 已用 `CompressionErrorCode` 统一分类并保持现有字符串协议，前端已为已知错误码及 JPEG/WebP/PNG 参数、输入容器、尺寸和请求协议前缀补充中文文案，并保留冒号后的细节；未知错误原文透传。

### 1.2 数据契约

- [x] 新增 `CompressionFormat`。
- [~] 新增 `CompressionMode`：实际结果已返回 `lossless`/`lossy`；请求侧 `auto` 仍待产品定义。
- [~] 新增 `CompressionEngine`：实际结果已返回 `oxipng`、`image-jpeg`、`jpeg-encoder`、`libwebp`；可选后端与 `auto` 选择仍待扩展。
- [x] 新增 `MetadataPolicy`：已落地 `strip`、PNG→PNG/JPEG→JPEG/静态 WebP→WebP 的 `stripSafe` 与 `stripAll`；三种 `stripSafe` 只保留结构合法且有界的 ICC payload（不保证 ICC 内部色彩语义），移除 EXIF/GPS/XMP/COM/其他输入 metadata；WebP 由 RAII mux 删除 EXIF/XMP/旧 ICCP，允许合法 ALPH，拒绝动画、重复、坏 padding、截断和非白名单输出；正式压缩、预览与体积估算共用同一策略校验；WebP 元数据 `preserve` 仍待后续。
- [~] 新增 `CompressionPreset`：内置 `high-quality`、`balanced`、`small-size`、`custom` 已在前端落地，版本化跨页面协议待后续。
- [x] 新增统一任务状态：排队、读取、解码、规划、编码、校验、发布、完成、跳过、取消、失败；native 已用 `CompressionStage` 统一收敛阶段、终态判断和错误码分类，JSON/JSONL 仍保持原有字符串协议。
- [~] 新增结果字段：体积、节省、格式、目标达成、选中质量、跳过原因、实际模式和编码后端已落地；完整参数摘要已在压缩工作区展示并支持安全复制（指定目录路径不会复制），可选后端仍待后续。
- [x] 新增前端/原生命令请求和响应类型。
- [~] 新增参数版本号：压缩/估算 IPC 已使用 `schemaVersion=1` 并拒绝未知版本；自定义预设从 schema v1 开始，新字段按可选默认值兼容。历史 `metadataPolicy=preserve` 因语义不再支持会整体安全拒绝/不加载，当前不自动改写为 `strip`，避免静默改变用户意图；后续迁移版本与该边界仍需产品决策。

### 1.3 资源限制

- [x] 复用现有输入字节和像素限制：原生核心统一限制 32 MiB、尺寸和像素预算，前端导入也提前拦截超过 32 MiB 的文件。
- [x] 增加压缩单文件最大体积配置：前端偏好/自定义预设和 native raw/estimate 均支持 1–32 MiB，默认 32 MiB；只能收紧硬上限，并在导入、预览、估算与正式压缩前拒绝越界输入。
- [x] 增加压缩临时空间预估：预检返回候选编码所需的空间预算，工作台在批处理后显示最近一次预算。
- [x] 增加候选搜索最大次数：前端与自定义预设支持 1–12 次，默认 8；核心对请求继续执行同范围校验。
- [~] 增加单任务超时和取消边界：已补齐等待并发编码槽位、候选搜索和 WebP 有损质量评估像素遍历前后的可取消边界，并新增候选搜索/质量评估取消回归；实际编码阶段的超时策略仍待后续评估。
- [x] 限制默认并发编码数，预览、预估和正式压缩共享最多 2 个编码 slot，避免多张大图同时占满内存。

## 2. M1：Rust 压缩核心

### 2.1 临时文件与发布

- [x] 创建压缩临时目录和唯一临时文件名。
- [x] 临时文件只能由当前任务清理。
- [x] 编码结束后执行可解码校验。
- [x] 校验失败不得发布正式输出。
- [x] 非覆盖模式安全发布。
- [x] 覆盖同名文件安全替换。
- [x] 覆盖原图先备份到同目录 `bak`。
- [x] 发布失败恢复旧文件。
- [x] 删除源文件只在对应输出成功、输出可验证且未跳过后执行；删除失败会回滚。
- [x] 取消后清理未发布临时文件：已覆盖取消竞态和编码后不发布；批处理终态以取消优先，避免无失败项时误报完成；压缩工作台用独立中性取消态展示，并保留失败项重试入口；GIF spool 失败、取消和正常取帧均清理目录。
- [x] 进程异常后清理过期压缩临时目录：压缩编码在内存完成；GIF spool 锁先于目录创建，启动扫描只能清理成功获得锁的过期目录、无目录 stale lock 或 stale quarantine 文件，且通过不覆盖 quarantine 覆盖创建崩溃窗口，活跃实例会被跳过。

### 2.2 PNG 无损

- [x] 评估并固定 OxiPNG 版本（9.1.5）。
- [x] 完成 OxiPNG 许可证和依赖清单审查。
- [x] 支持优化级别 0–6 的内部映射。
- [x] 支持 `strip-safe`：输入 PNG→输出 PNG 时走 OxiPNG 9.1.5 raw-byte `StripChunks::Safe`，保留 `iCCP`/`sRGB`/`cICP` 等显示相关块，清除 EXIF、XMP、GPS/缩略图承载块和未知 ancillary chunks；输入 JPEG→输出 JPEG 时只保留结构合法且有界的 ICC payload（不保证 ICC 内部色彩语义），清除 EXIF、GPS、XMP、COM 和其他输入 metadata；坏 marker、截断、重复、不完整或超限输入明确拒绝。长度/CRC、解码、尺寸/颜色/Alpha、临时文件与原子发布均有覆盖，非同格式路径仍明确拒绝。
- [x] 支持 `strip-all`：当前编码器路径不复制输入元数据，并由 native 响应明确回报 `stripAll`。
- [x] 第一阶段 `strip` 实际验证：带 JPEG EXIF APP1 的输入在 PNG/JPEG/WebP 输出中不会被复制。
- [x] 支持透明像素优化开关：PNG 请求/估算支持可选 `pngOptimizeAlpha`，默认关闭；仅 PNG 接受，启用后明确提示可能改变完全透明像素的 RGB 值，输出仍执行尺寸与解码校验。
- [x] 保持宽度、高度、颜色类型、Alpha 语义正确：PNG 优化级别与 `stripSafe` 均通过解码后的 RGBA 逐点和尺寸回归验证。
- [x] 压缩后更大时返回带原因的 `skipped` 结果并默认跳过。
- [x] 验证 PNG 解码结果。
- [x] 补像素逐点一致测试：PNG 优化级别 0–6 均逐点验证 RGBA 输出与输入一致。

### 2.3 JPEG

- [x] 使用现有 Rust JPEG 编码能力完成第一阶段闭环。
- [x] 支持质量 1–100 的边界校验。
- [x] 支持渐进式 JPEG 开关：固定 `jpeg-encoder=0.7.1`（默认不启用 SIMD），仅 JPEG 输出接受 `jpegProgressive`；formal、preview、estimate 和目标候选搜索共用编码参数，默认路径继续使用原 `image` JPEG 编码器，输出回读校验 SOF marker、格式、尺寸和可解码性。
- [x] JPEG `stripSafe` 元数据清理：PNG 与 JPEG 仅允许同格式安全路径；JPEG 仅复制结构合法且有界的 ICC payload（不保证 ICC 内部色彩语义），移除 EXIF/GPS/XMP/COM/其他输入 metadata，并拒绝坏 marker、截断、重复、不完整、超限及无法闭合的 profile。
- [x] 支持优化熵编码：通过 `jpeg-encoder=0.7.1` 的 `jpegOptimizeHuffman` 开关生成优化 Huffman 表；仅 JPEG 生效，默认关闭并覆盖 formal、preview、estimate 和候选搜索路径。
- [x] 明确 Alpha 处理：JPEG 透明像素按已校验的 `#RRGGBB` 背景合成，默认白色，不允许静默丢失透明度。
- [x] 正确处理 EXIF Orientation：strip 解码入口统一应用 JPEG 1–8 姿态，非法/缺失标签安全忽略。
- [ ] 支持元数据保留/清理策略。
- [x] 验证输出可解码、尺寸正确、颜色通道正确；透明输入同时覆盖背景合成后的颜色回读。
- [ ] 评估 MozJPEG 后端，不在未审查许可证前强制引入。

  - 2026-10-01 调研结论：MozJPEG 官方说明其兼容 libjpeg API/ABI，适合作为 JPEG 后端候选；但其许可证说明包含 IJG 与 Modified BSD 条款，静态捆绑前必须补齐第三方声明与发布产物审计。libavif 官方仓库标注主库为 BSD 体系，但构建时可能引入 AOM/libyuv 等后端，不能仅凭主库许可证放行。当前只记录候选，不引入依赖、不改变默认编码路径。

### 2.4 WebP

- [x] 支持有损 WebP。
- [x] 支持无损 WebP。
- [x] 支持质量参数：有损 WebP 接受质量 1–100，并支持 method 0–6；method 仅影响编码耗时与压缩率，不代表画质。
- [x] 支持 Alpha 质量：有损 WebP 提供 0–100 控制，默认 100；前端、preview、estimate、正式压缩和目标候选搜索共用同一校验与编码参数，并覆盖透明度回读。
- [x] 支持编码 method 0–6；默认 4，正式压缩、预览、估算和候选搜索保持一致。
- [x] 支持分析遍数 `pass` 1–10；默认 1，仅有损 WebP 可用，正式压缩、预览、估算和候选搜索保持一致；该参数表示分析遍数，不等同于画质质量。
- [x] 支持编码 effort/near-lossless：无损 WebP 提供可选 `webpLosslessMethod=0..6`，由 libwebp 的 ARGB lossless 路径编码并通过像素级回读验证；省略参数时保留旧 `image` 编码路径。近无损继续使用 1–99 等级，并与 method 共用同一安全校验；`quality` 在 libwebp lossless 中仍表示压缩 effort（0–100），不与前端的 method 档位混用。
- [~] 支持 WebP 元数据保留/清理策略：WebP `stripSafe` 已完成窄范围实现：仅允许静态 WebP→WebP；有界 RIFF 解析只提取单个结构合法且不超过 4 MiB 的 ICCP，输出通过 RAII mux 删除 EXIF/XMP/旧 ICCP，允许合法 ALPH，且仅允许 VP8X、VP8/VP8L、ALPH 和最多一个合法 ICCP。动画块、重复块、坏 padding、截断/不完整数据、整数溢出、无效 ICC 结构和非白名单输出均拒绝；PNG/JPEG→WebP 与 `preserve` 仍拒绝。

  - `stripSafe` 已按该最小可审查方案落地：显式声明 `libwebp-sys2` 的 `mux` feature；仅对静态 WebP 输出在有界 RIFF 解析后允许保留经大小限制和结构校验的 ICCP，默认删除 EXIF/XMP（从而连同 EXIF 内嵌缩略图/GPS 一并删除），允许合法 ALPH，拒绝动画、重复块、坏 padding、非白名单输出、整数溢出和不完整 padding；以 RAII 封装 `WebPMux`/`WebPData`，保证 assemble 失败和早退路径都释放内存。
  - `preserve` 仍需先定义“原始字节保留”还是“可验证字段保留”：前者要求按输入格式提取并复制 WebP/PNG/JPEG 的原始块，后者至少需要 ICC/EXIF/XMP 的来源、大小、重复块、方向和 GPS 语义契约；不能把 `WebPMuxSetChunk` 成功当作安全或完整保留的证据。
  - 当前 `metadataPolicy=preserve` 在 native 入口明确拒绝，是有意的安全门禁而非遗漏。接入前必须由产品决定保留字段、跨格式行为、EXIF Orientation 是否重写、GPS/缩略图是否允许，以及重复/损坏字段的处理；下一阶段优先评估静态 WebP→WebP 的固定 allowlist（不透传未知私有 chunk），并补齐单 chunk/总 metadata 预算、RIFF/字段解析、WebPMux/WebPData RAII、组装后重新解析与尺寸/Alpha/可解码/输出上限回读，以及 preview/estimate/formal 一致和失败不发布测试。未闭合这些门禁前不得开放 preserve。
  - preview、estimate、formal 已共用 `encode_image_with_webp_method_alpha`/候选搜索和同一 mux 后处理；三条路径均回读检查输出尺寸/Alpha/可解码性，并验证无 `ANIM`/`ANMF`、仅允许 VP8X/VP8/VP8L/ALPH/单个合法 ICCP、RIFF 长度/奇偶 padding 和输出上限。ICCP、EXIF/XMP/旧 ICCP 清理及输出白名单均有回归覆盖。
  - `preserve` 仍需先定义“原始字节保留”还是“可验证字段保留”；WebP `stripSafe` 已补齐静态/动画、ICCP、边界和 preview/estimate/formal 共用路径测试，发布前仍需按 x64/ARM64 构建复核。
- [x] 保持透明度和透明边缘正确。
- [x] 验证输出可解码、尺寸正确、Alpha 正确。
- [x] 评估目标体积参数能否由底层后端直接支持：JPEG/WebP 有损均使用有界质量候选搜索，超目标返回明确的 `target_unmet`；WebP 有损的 RGB MAE、PSNR 与 Alpha 差异也会在预览、估算和正式结果中返回，便于同一输入下比较。

### 2.5 统一压缩命令

- [x] `compress_image`。
- [x] `preflight_compression`。
- [x] `estimate_image_compression`：只读内存编码和候选搜索，不接受发布路径或覆盖字段。
- [x] `preview_compression`。
- [x] `get_compression_progress`。
- [x] `cancel_compression`。
- [~] 所有命令使用显式 `jobId`：执行、进度和取消命令已绑定任务 ID；预检、预览和估算是只读请求，故不创建任务 ID。
- [x] 取消命令幂等：终态任务重复取消返回同一终态，未知任务仍明确报错。
- [~] 进度事件包含当前文件、总数、阶段和字节统计：当前文件与总数由前端队列状态显示，原生进度已补充可选输入/候选/最终输出字节数，前端已把已知阶段映射为中文；跨任务批处理的统一原生统计字段仍待后续。
- [x] 错误包含阶段、错误码和可读信息：终态进度保留 stage/error/code，前端统一格式化并显示可读错误；本轮已覆盖损坏 PNG/JPEG/GIF 的 `decode` 分类与发布保护。

## 3. M2：压缩策略与预估

### 3.1 预设

- [x] 高质量预设。
- [x] 平衡预设。
- [x] 小体积预设。
- [x] 自定义预设。
- [x] 预设切换时同步格式相关参数。
- [x] 不同格式不复用错误的质量语义。
- [x] 预设显示简短解释和适用场景。

### 3.2 无损/有损

- [x] PNG 默认无损。
- [x] JPEG 默认有损。
- [x] WebP 提供有损/无损切换。
- [x] 页面显式显示“有损”或“无损”。
- [x] 有损处理显示质量参数。
- [x] 无损处理不显示会误导用户的质量滑块。

### 3.3 目标体积

- [x] 支持设置最大输出体积（JPEG/WebP 有损）。
- [x] 支持设置目标体积：JPEG/WebP 有损按最大体积约束执行有界候选搜索，自动模式按候选尺寸联动，并在 preview/estimate/formal/CLI 返回目标状态和最终缩放档位。
- [x] 先调整质量，再调整尺寸：自动目标体积规划器按 100/75/50/25/10% 顺序逐档尝试，每档质量候选预算与总候选上限共享；固定 `targetResizePercent` 仍可独立使用，二者互斥。
- [x] 百分比缩放安全切片：`targetResizePercent` 默认关闭，范围 10–100，禁止放大，仅 JPEG/有损 WebP；Gateway/native/CLI 均做协议校验，预检/预览/估算/正式导出共享尺寸计算，前端偏好与自定义预设可保存该参数；缩放后的尺寸仍经过现有解码、尺寸、输出体积和发布保护。
- [x] 自动目标体积联动缩放：统一规划器携带候选尺寸、质量选择、候选计数和累计搜索耗时；限制 5 个缩放档位、每轮编码预算、输入/预览上限，并在准备、编码和发布前检查取消。
- [x] 前置重构门禁：不复制 preview/estimate/formal 的候选逻辑，使用同一 `prepare_and_choose_output` 返回准备输入、尺寸和选择结果；估算仍 writer-free，正式发布继续在 skipped 分支后才进入 writer。
- [x] 候选结果必须实际编码后测量。
- [x] 候选结果必须经过解码校验。
- [x] 目标不可达时不发布结果。
- [x] 显示最终采用参数和目标达成状态。
- [x] 限制搜索次数和最大耗时。

### 3.4 跳过规则

- [x] 默认启用“压缩后更大则跳过”。
- [x] 跳过项显示原因和统计；逐项展示原体积、候选/输出体积及节省或增加比例。
- [x] 跳过项不进入覆盖和删除源文件流程。
- [x] 用户可关闭跳过规则，并明确提示结果可能变大及覆盖风险；默认仍开启。

## 4. M3：压缩工作区 UI

### 4.1 页面入口

- [x] 侧栏新增“图片压缩”。
- [x] 页面使用现有 EmbedPix 模块化卡片布局。
- [x] 页面可在最小窗口访问全部核心操作；GIF/压缩工作台按需懒加载，已进入过的工作台仅隐藏不卸载。
- [x] 页面不出现无意义横向滚动条。
- [x] 窄窗口时源图片、预览、参数、输出卡片自然堆叠；低高度窗口使用紧凑间距，状态文本允许换行。

### 4.2 源图片卡片

- [x] 支持单张导入。
- [x] 支持多张导入。
- [x] 支持拖放导入。
- [x] 支持导入文件夹。
- [x] 支持继续添加。
- [x] 支持替换当前图片。
- [x] 支持移除单张图片。
- [x] 支持清空列表。
- [x] 显示文件名、尺寸、格式和原始体积。
- [x] 导入错误逐项显示。
- [x] 忙碌时禁用所有导入入口。

### 4.3 预览卡片

- [x] 原图/结果图切换。
- [x] 透明棋盘格。
- [x] 适应画布和 1:1 查看。
- [x] 显示原始尺寸和输出尺寸。
- [x] 显示原始体积、预计体积、已节省体积和比例。
- [x] 编码过程中显示当前阶段。
- [x] 编码失败显示失败原因。
- [x] 大图预览不阻塞整个批处理队列：批处理开始后不再启动新的原生预览请求，并清理尚未开始的预览计时器；已进入原生编码的旧请求通过独立原生 `jobId`、排队取消和编码检查点终止，且成功/失败/取消都会记录终态并释放 slot。

### 4.4 压缩参数卡片

- [x] 压缩模式选择：PNG 固定无损，JPEG 固定有损，WebP 可切换无损/有损；前端格式与模式控件、Gateway 归一化和 Rust `validate_compression_mode` 共同执行互斥校验。
- [x] 输出格式选择。
- [x] 预设选择。
- [x] 质量控制：JPEG/WebP 有损均支持 1–100。
- [x] 编码 effort 控制：无损 WebP 新增可选 `webpLosslessMethod=0..6`，默认不发送并保持原有 `image` 编码路径；preview/estimate/formal、Gateway、偏好、自定义预设和 native 校验共用同一范围，选中后使用 libwebp ARGB lossless 配置的 method 档位并回读验证像素一致性。
- [x] 目标体积开关。
- [x] 最大体积输入。
- [~] Alpha 保留开关：不提供独立开关；PNG/WebP 按格式语义保留 Alpha，JPEG 明确按背景色合成，工作区已显示实时处理说明，避免对 JPEG 暴露无效选项。
- [~] 元数据策略选择：第一阶段提供移除元数据，保留策略待后续。
- [x] 高级参数折叠：元数据、输出位置/文件名和覆盖策略默认收起；高频格式、质量和体积参数保持常显。
- [x] 参数错误即时提示：目标体积、输出位置、自定义文件名和子目录均在导出前显示错误。
- [x] 编码中禁止修改参数：工作台在 busy 状态禁用格式、质量、体积、路径、覆盖和预设控件。

### 4.5 输出卡片

- [x] 源文件夹输出。
- [x] 子文件夹输出。
- [x] 指定目录输出。
- [x] 自定义文件名规则：仅允许安全基础文件名，按目标格式强制扩展名，并与自动序号协作。
- [x] 自动序号避免重名。
- [x] 覆盖同名文件。
- [x] 覆盖原图并备份到 `bak`。
- [x] 删除源文件并二次确认；仅桌面源文件队列可用，并与覆盖原图互斥。
- [x] 压缩完成后打开文件夹。
- [x] 压缩完成后复制路径。

### 4.6 任务状态

- [x] 开始前执行预检。
- [x] 显示总进度。
- [x] 显示当前文件。
- [x] 显示成功/失败/跳过计数。
- [ ] 支持暂停。
- [ ] 支持继续。
- 阻塞评估：当前 `AtomicBool` 只提供取消，编码 slot 只能在任务开始前排队；`image` JPEG、libwebp `WebPEncode`、OxiPNG `optimize_from_memory` 都是不可恢复的同步调用，无法在帧/scan/chunk 边界安全挂起并保存编码器状态。候选搜索和质量评估可在候选/像素块之间延迟，但不能恢复正在执行的单次编码；暂停若强杀线程还会丢弃内存输出。真正支持需要可序列化的暂停状态、分阶段临时产物/磁盘预算、恢复协议字段和发布一致性测试，当前不实现。
- [x] 支持取消。
- [x] 支持仅重试失败项。
- [x] 支持复制失败详情。
- [x] 支持逐项打开输出文件夹。
- [x] 页面切换时任务状态保持一致：`AppShell` 始终挂载压缩视图，仅通过 `hidden` 与 `active` 切换，任务状态不随切页重置。

## 5. M4：设置、预设和工作区

- [x] 增加压缩默认预设：高质量、平衡、小体积和自定义预设均可用。
- [x] 增加默认输出格式：默认 WebP。
- [x] 增加默认元数据策略：默认移除元数据。
- [x] 增加默认“压缩后更大则跳过”，并兼容旧偏好/预设缺失字段。
- [x] 增加默认输出位置：默认输出到源文件夹。
- [x] 增加最大输入/输出限制：输入 32 MiB，原生输出与目标体积上限 128 MiB。
- [x] 压缩预设支持 JSON 导出。
- [x] 压缩预设支持 JSON 导入。
- [x] 未知字段兼容忽略。
- [x] 新增设置字段加入版本迁移：压缩偏好版本从 v2 升至 v3，旧版本安全补默认值。
- [x] 工作区保存压缩参数。
- [x] 工作区打开时校验源文件存在性：原生环境逐项读取，浏览器环境明确提示重新选择。
- [x] 缺失源文件显示逐项路径：解析诊断与原生读取失败均保留路径。
- [x] 工作区打开失败不得清空当前工作区：源文件读取完成前不替换现有列表。

## 6. M5：安全与异常流程

- [x] 空文件拒绝并显示原因。
- [x] 扩展名与真实格式不一致时按真实格式检测。
- [x] 损坏图片拒绝并保留其他任务。
- [x] 超大图片在解码前拒绝。
- [x] 路径穿越和 Windows 保留名拒绝。
- [x] 输出目录不可写时预检失败。
- [x] 磁盘空间不足时预检失败；无法可靠查询时保持未知，不误报。
- [x] 输出目标冲突时逐项显示。
- [x] 写入失败时恢复旧文件。
- [x] 删除源文件失败时保留新输出和源文件；压缩结果被跳过时也不会提前删除源文件。
- [x] 取消任务后可立即开始新任务。
- [x] 应用关闭时记录未完成任务并清理临时资源：活动任务队列已限制为 8 个，终态任务会释放容量；spool 跨进程锁和状态析构清理已完成，图片压缩/GIF 原生状态析构与工作区卸载都会主动请求取消；自绘关闭、Alt+F4 和系统关闭路径均通过原生 close-requested 监听进入有界取消，监听迟到注册、卸载清理和重复关闭均有测试。
- [x] 不在日志中记录图片内容或完整元数据；日志仅保留计数、耗时、错误类别/系统错误，路径信息按诊断需要保留。

## 7. M6：测试与门禁

### 7.1 前端

- [x] 类型检查。
- [x] ESLint。
- [x] 压缩参数纯逻辑测试。
- [x] 预设迁移测试：偏好 v1 可读入并安全补默认字段，保存后升级为 v2。
- [x] 目标体积搜索测试。
- [x] 批处理状态测试：取消优先于完成/失败，包含“无失败项但已取消”的边界。
- [~] 取消/重试测试已覆盖；暂停/继续因编码器不可恢复、暂停状态无法持久化且缺少临时产物/恢复协议，暂不实现。
- [x] 导入/移除/替换测试。
- [x] 响应式布局契约测试。
- [x] 键盘操作契约测试。
- [x] 工作区/预设 Blob URL 下载在 click 后延迟撤销，并覆盖 click 异常清理。

### 7.2 Rust

- [x] PNG 无损像素一致。
- [x] JPEG 参数边界和可解码性。
- [x] WebP 有损/无损/Alpha：静态有损后端、无损输出和 Alpha 回读已覆盖；ARM64 发布构建仍待验证。
- [ ] 元数据策略。
- [x] 预检和路径安全。
- [x] 临时文件和原子发布。
- [x] 覆盖原图回滚。
- [x] 删除源文件失败回滚。
- [x] 取消清理。
- [x] 并发任务冲突。
- [x] 资源上限和磁盘空间。

### 7.3 桌面 smoke

- [~] Windows x64 构建：本地已生成 `EmbedPix.exe` 与 `EmbedPix_0.7.0_x64-setup.exe`，并通过 Windows GUI subsystem=2 检查；完整 Tauri 构建仍因本机缺少 `TAURI_SIGNING_PRIVATE_KEY` 未完成签名。
- [ ] Windows ARM64 构建。
- [x] 压缩命令行输出、错误输出和退出码：`embedpix-cli` 使用 JSON/JSONL 事件输出成功与进度，错误事件写入 stdout、stderr 保留进程级诊断，退出码区分成功（0）、失败（1）和中断/部分失败（2）；CLI 现在支持 `jpegProgressive`、`jpegOptimizeHuffman` 与 `lossless + webpLosslessMethod=0..6`，并由 smoke 实际校验 JPEG SOF2 及 WebP 无损 method 0/6 输出；强制 CLI/OxiPNG smoke 已覆盖 PNG、JPEG、WebP、GIF 输出与二次解码。
- [x] x64 安装、启动、压缩、卸载：`EmbedPix_0.7.0_x64-setup.exe` 隔离 NSIS smoke 安装退出码为 0，`EmbedPix.exe` 通过 GUI subsystem=2 检查，启动 8 秒仍运行，卸载退出码为 0 且临时安装目录清理完成。
- [ ] ARM64 资产下载、SHA256、签名校验。
- [~] `latest.json` 与签名文件一致性：本地 fixture 已覆盖清单、URL、签名、摘要与尺寸；真实线上资产待发布时验收。
- [x] 本地 release fixture 能拒绝平台数、URL、时间、大小和 PE 边界错误。
- [x] release fixture 幂等校验：有效 `pub_date` 固定为 UTC 输入，重复执行契约校验产生一致的 manifest/asset summary。
- [x] 发布门禁收尾：provenance `workflow_ref`/`release_commit` 篡改拒绝与固定 fixture 重复执行一致性均已验证。
- [x] 发布资产完整性门禁：provenance 与 SHA256SUMS 篡改/重复条目拒绝、固定 fixture 幂等性均已验证。
- [x] 发布说明版本匹配：`docs/release-notes-v0.7.0.md` 标题与当前版本一致，并由 `check:release-config` 校验。
- [x] 安装包无控制台窗口：同一隔离 NSIS smoke 的 `EmbedPix.exe` 为 Windows GUI subsystem=2，启动后保持 GUI 进程运行。

## 8. M7：自动择优和高级编码器

- [ ] 自动尝试原格式无损候选。
- [x] 自动尝试原格式有损候选：JPEG/WebP 均已落地有界质量搜索。
- [x] 自动尝试 WebP 候选。
- [x] WebP 有损 method 0–6 评估：固定样本下编码结果可重复，method 变化可观测。
- [x] WebP 有损画质参考值：预览、估算和正式逐项结果展示 RGB MAE、PSNR 和 Alpha 差异像素；仅供相对比较，不作为主观画质或自动选优结论。
- [ ] 自动尝试 AVIF 候选前先评估包体积。
- [x] 按目标体积选择最高质量候选：JPEG/WebP 均已完成。
- [ ] 按视觉质量阈值过滤候选。
- [x] 记录并展示候选参数摘要：Rust 返回实际候选数量与搜索耗时，预览和逐项结果同时展示最终质量（旧核心响应缺失字段时安全隐藏）。
- [x] 质量结果可重复：JPEG/WebP 候选搜索回归测试重复执行并校验最终质量、候选数和编码字节一致。
- [ ] WebP 有损视觉质量门槛：通用 PSNR/Alpha 阈值与视觉质量选优仍需产品定义；当前仅闭合窄范围 `maxRgbMae`。
- [x] WebP 有损 `maxRgbMae` 最小闭环：默认关闭；仅允许有损 WebP + `maxOutputBytes`，校验 finite 0–255；设置后按 `maxCandidates` 有界扫描，在编码→解码→RGB MAE 后同时判断体积和阈值，选择满足条件的最高质量；未设置时保留旧字节二分路径、候选数量和输出不变。无候选满足时返回可解码回退并以 `quality_threshold_unmet` 或 `target_unmet` 阻止正式发布；preview/estimate/formal、取消、输出预算、Gateway 与前端摘要均已覆盖。
- [x] 高级参数可折叠且有解释：元数据、路径、覆盖策略集中在高级输出选项中。
- [x] preserve 解码资源限制：原生图片导出的 `metadataPolicy=preserve` 同样使用最大尺寸与解码分配上限；正常同尺寸透传、超尺寸/超分配拒绝且不触碰已有输出均有回归测试。
- [~] 评估 MozJPEG：已记录许可证、原生链接和包体积审查要求，尚未引入。
- [ ] 评估 PNG 有损量化许可证或替代算法。
- [ ] 评估 libavif 编码器依赖。

## 9. M8：动画压缩

- [x] GIF 连续相同帧合并，累计时长保持不变。
- [x] GIF 逐帧调色板量化与抖动模式。
- [ ] GIF 帧间透明区域优化：当前 GIF 编码每帧生成完整画布并固定 `DisposalMethod::Background`，差分帧需要新增子矩形坐标、透明像素/调色板策略和 disposal 选择；否则会在上一帧残留、透明边缘或首帧/重复帧场景改变合成结果。APNG 当前固定全画布 `dispose=Background`、`blend=Source`，WebP 动图通过 `add_frame` 接收全画布 RGBA，三条路径都没有现成安全的差分区域 API。可行阶段应先在 RGBA 合成参考帧上计算最小变化矩形，保留首帧/重复帧语义，分别验证 GIF disposal、APNG blend/dispose、WebP 解码合成后的每帧像素；同时限制矩形数量、总像素和内存/CPU预算，并覆盖透明边缘、完全透明帧、重复帧、首帧和跨帧累积 fixture。当前缺少统一的差分帧表示、格式级合成回读和预算协议，暂不实现。
- [x] APNG 帧重压缩与导出。
- [x] WebP 动画帧重压缩与导出。
- [x] 动画时长和循环次数保持，并对时间精度做格式化量化。
- [x] GIF、APNG、WebP 动画目标体积候选搜索与最终参数摘要。
- [x] 动画取消和临时帧清理。
- [x] 动画发布前按格式解码验证画布尺寸与帧数。

## 10. 里程碑验收

### Alpha：核心可运行

- [x] 单张 PNG/JPEG/WebP 可压缩。
- [x] 输出可解码。
- [x] 不覆盖源文件。
- [x] 核心单元测试通过。

### Beta：批处理可用

- [x] 多文件导入和队列。
- [x] 预览、进度、取消、重试。
- [x] 输出位置和覆盖策略。
- [x] 前端和 Rust 门禁通过。

### RC：可发布

- [~] 元数据策略完整：压缩工作区支持 `strip`、PNG→PNG/JPEG→JPEG/静态 WebP→WebP 的 `stripSafe` 和 `stripAll`；三种 `stripSafe` 均只保留结构合法且有界的 ICC payload，不保证 ICC 内部色彩语义，并移除 EXIF/GPS/XMP/注释；WebP `preserve` 与跨格式安全保留仍待后续。
- [x] 失败回滚完整。
- [~] 桌面 smoke 通过：本地 smoke 与窄窗口运行时复核已通过，签名预检已加入；`prepare-release.yml` 在签名预检前接入 cleanup smoke，清理失败会以非零状态阻断发布；真实发布资产安装/启动仍待下一次正式 release 验收。
- [x] 许可证清单完成。
- [x] 发布说明完成：`docs/release-notes-v0.7.0.md` 已存在并通过版本标题校验。
- [ ] x64 安装和启动通过。
- [ ] ARM64 资产校验通过。

## 11. 当前执行顺序

1. [x] 创建设计文档和本 TODO。
2. [~] M0 数据契约和资源限制：第一阶段契约完成，高级模式/后端枚举待扩展。
3. [~] M1 Rust 压缩核心与安全发布：PNG/JPEG/WebP、预览、目标搜索、OxiPNG、WebP method、无损 WebP 可选编码档位、schema 版本、活动任务上限和 GIF spool 跨进程锁已完成；目标体积自动组合搜索和 near-lossless 策略仍待后续。
4. [~] M2 PNG/JPEG/WebP 策略与预估：JPEG/WebP 有损目标体积搜索已完成，尺寸联动与更高阶自动择优待后续。
5. [x] M3 压缩工作区 UI。
6. [x] M4 设置、预设和工作区。
7. [~] M5 安全与异常流程：核心路径已覆盖，窗口关闭/持久化任务待补齐。
8. [~] M6 测试与门禁：现有门禁通过；暂停/继续受同步编码器不可恢复和缺少持久化恢复协议阻塞。
9. [~] Alpha/Beta/RC 验收：Alpha/Beta 当前功能门禁通过，RC 仍需真实发布资产验收。
10. [~] M7 自动择优：JPEG/WebP 有损候选和 WebP method 已完成，视觉质量阈值与 near-lossless 候选搜索待后续。
11. [~] M8 动画压缩：GIF/APNG/WebP 动画链路已覆盖，GIF 帧间透明区域优化仍待后续。

## 12. 暂不实现或需要额外决策

- [!] pngquant 直接捆绑：需要 GPLv3/商业许可决策或替代算法。
- [!] AVIF 默认启用：需要确认包体积、编码器依赖和构建时间。
- [!] JPEG XL：需要确认生态和发行收益。
- [!] ARM64 原生安装 smoke：需要 ARM64 runner 或真实 ARM64 设备。
- [!] macOS/Linux 自动更新：需要对应签名安装资产和发布流水线。
