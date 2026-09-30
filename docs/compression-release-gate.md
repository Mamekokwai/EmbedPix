# 图片压缩发布门禁

本文档只描述发布/验收侧契约。当前压缩核心是 Tauri 原生命令，不是 `embedpix-cli` 的 `op:"compress"`；CI 不虚构不存在的 CLI 操作。仓库变量 `EMBEDPIX_COMPRESSION_CLI_SMOKE` 设为 `true` 后，Windows CI 会切换到强制原生压缩契约检查。

## 当前可执行门禁

运行：

```powershell
npm run check:compression-cli-smoke
```

契约会构建 `embedpix-cli`，执行图片 PNG 输出、GIF 输出和 PNG 二次解码，并对每个结果检查：

- 文件存在且非空；
- PNG/GIF 文件签名正确；
- SHA256 可复现并输出 JSON 报告；
- 输出可再次被 CLI 解码。

当前阶段会明确报告压缩不通过 CLI 执行，不把图片转换 smoke 伪称为压缩 smoke。

`embedpix-cli` 的 `op:"compress"` 保持现有窄合约，内部固定使用 `metadataPolicy:"strip"`，不透传 `stripSafe` 或 `pngOptimizeAlpha`。`stripSafe` 属于 Tauri 原生 raw IPC 压缩路径，仅支持同格式 PNG/JPEG 或静态 WebP；CLI smoke 不伪造该字段，相关 ICC 保留与元数据清理由 native Rust 测试覆盖。

## 压缩核心合并后的强制门禁

```powershell
pwsh -NoProfile -File scripts/compression-cli-smoke.ps1 -RequireCompression
```

强制模式检查真实的 Tauri 原生契约：

- `preflight_compression`、独立的 `preview_compression`、`compress_image`、`cancel_compression` 入口存在；
- `path`、`source`、`directory`、`subfolder`、`original` 输出位置有契约入口；
- 输出经过现有原子发布/回滚入口；
- `skipIfLarger` 已进入原生或 gateway 契约。
- 独立的 `preview_compression` 只做解码/编码预览，不调用发布 writer、不执行文件写入/重命名/删除；输入受字节、尺寸、像素和 decoder allocation 限制。
- 图片原生压缩接收并校验 `maxOutputBytes`（不超过 128 MiB）与 `maxCandidates`（`1..=12`）；JPEG 使用有界质量候选搜索，PNG/WebP 无损输出在超过目标时返回 `target_unreachable`，WebP 有损当前不做质量候选搜索，超目标返回 `target_unmet`。
- GIF 目标体积搜索使用 `maxCandidates` 的 `1..=8` 上限；候选规划只做估算/编码，不调用发布 writer。
- 输出发布统一经过 `storage::MAX_OUTPUT_BYTES`（当前 128 MiB）和 `validate_output_size`；超限在 publish lease 之前失败并清理临时文件。
- 目标不可达的当前语义是 `selected=null` 加 `reason`（包含“不可达”），不是虚构的 `target_unreachable` CLI 操作；导出选择器在 `write_output_with_publish` 之前返回错误，因此不可达目标不会发布。

现有 CLI smoke 仍检查真实支持的 image/GIF 输出：签名、SHA256 和二次解码；它不会伪造压缩或目标搜索 CLI op。原生压缩与目标搜索通过静态 Rust/gateway 契约检查，后续可再增加桌面 Tauri IPC fixture，检查 `skipIfLarger`、`target_unreachable` 的实际结果、输出位置、取消、失败清理和源文件不变。

脚本的静态检查会在发布前失败于以下情况：预检函数调用 `write_exported_file` 或文件写入/重命名/删除 API；未调用输入解码校验；缺少输入字节、图像尺寸、像素数、decoder allocation 限制；目标搜索没有 `maxCandidates` 上限；候选阶段调用发布 writer；输出没有统一体积上限；或不可达目标没有在 publish writer 之前被拒绝。当前检查的是原生 Rust/Tauri 路径，不增加不存在的 CLI op。

目标体积门禁分别覆盖两条原生路径：GIF `plan_gif_compression` 使用 `maxCandidates` 的 `1..=8` 上限并以 `selected=null + reason` 表示不可达；图片 `compression.rs` 使用 `maxOutputBytes` 的 128 MiB 上限、`maxCandidates` 的 `1..=12` 上限和 JPEG 质量搜索，不可达结果在 `write_exported_file` 前以 `target_unreachable` 跳过。两条路径均不宣称存在 CLI 目标搜索操作。

当前工作树已接入 OxiPNG 9.1.5 并写入 `Cargo.lock`；普通 smoke 与严格 smoke 都会校验其版本、许可证入口和 `pngOptimizationLevel` 边界。若某个发布分支尚未包含该依赖，普通 smoke 只报告 pending，不宣称 PNG 优化后端已启用。接入后使用下面的严格门禁：

```powershell
pwsh -NoProfile -File scripts/compression-cli-smoke.ps1 -RequireCompression -RequireOxiPng
```

严格 OxiPNG 门禁要求：Cargo.toml 使用 `oxipng = { version = "=9.1.5", default-features = false }`，Cargo.lock 存在相同版本；`pngOptimizationLevel` 只能接受 `0..=6`；不得新增 `embedpix-cli` 的 PNG 优化 op。`binary`、默认 `zopfli`、`parallel` 和 `sanity-checks` feature 不纳入默认桌面包，除非另行完成体积与许可证评审。

## 第三方编码器许可证清单

| 组件/编码器 | 当前状态 | 许可证/证据要求 | 发布阻塞 |
|---|---|---|---|
| `image` crate PNG/JPEG/WebP 基础能力 | 已在生产依赖 | 固定 Cargo.lock 版本，保留 Cargo license 追踪 | 否 |
| `gif` crate | 已在生产依赖 | 固定 Cargo.lock 版本，保留 Cargo license 追踪 | 否 |
| `kamadak-exif` 0.6.1 | 已接入 JPEG Orientation 归一化，版本已固定 | BSD-2-Clause；纯 Rust，无 C/cc/build.rs；按 x64/ARM64 构建复核 Cargo.lock 与许可证清单 | 否 |
| `webp-animation` 0.10.0 → `libwebp-sys2` 0.2.0/0.1.11 | 已在生产依赖，`static` feature；静态 WebP 有损复用同一绑定，`libwebp-sys2` 0.2.0 额外固定 `mux` feature，`cargo tree` 可见两层 libwebp sys crate | Rust crate 元数据为 MIT OR Apache-2.0；`libwebp` 上游为 BSD-3-Clause，并需保留 `PATENTS`/版权与许可证文本；发布前按 x64/ARM64 实际安装包复核 | 否，现有动画链路和静态有损基础路径已接入；effort/目标候选及 ARM64 发布构建仍待评估 |
| OxiPNG 9.1.5 | 已接入当前工作树，Cargo.lock 已固定；默认 feature 全部关闭 | [crates.io 9.1.5](https://crates.io/crates/oxipng/9.1.5) 与上游 [oxipng/oxipng](https://github.com/oxipng/oxipng) 均标注 MIT；固定 `=9.1.5`、`default-features=false`，提交 Cargo.lock，并用 `cargo metadata --locked` 复核 bitvec/indexmap/libdeflater/log/rgb/rustc-hash 及完整依赖许可证 | 是，直到严格 OxiPNG 门禁与包体积对比通过 |
| MozJPEG | 尚未引入 | 上游 [mozilla/mozjpeg](https://github.com/mozilla/mozjpeg) 的发布构建需按 BSD 系列许可证文件逐项核对；评估 C/汇编静态链接、Windows 工具链和专利/版权清单后再启用 | 是 |
| pngquant | 未引入 | GPLv3/商业许可路径需明确，不得默认捆绑 | 是 |
| libavif/AV1 编码器 | 未引入 | 明确编码器、静态链接、专利/许可证和安装包体积影响 | 是 |

原则：新增编码器必须固定版本、完成许可证与版权清单、在 x64/ARM64 分别构建验证，并通过输出签名、SHA256、可解码和发布资产 smoke。

当前自动依赖门禁：`scripts/release-dependency-smoke.ps1` 使用 `cargo metadata --locked` 和 feature tree 验证 `kamadak-exif 0.6.1`、`oxipng 9.1.5`、`webp-animation 0.10.0`、`libwebp-sys2 0.2.0/0.1.11` 的许可证，并检查 `NOTICE` 中存在对应版本、许可证和版权标记；同时验证静态 feature 链路。Windows 构建阶段同时记录 `EmbedPix.exe` 和 NSIS 安装包字节数。当前不设置未经评审的硬性体积上限，体积预算需以同一提交、同一目标平台的基线对比后单独批准。

### 编码器包体积评估建议

- 不从 Cargo.lock 的源码体积推断安装包增量；以同一提交、同一 profile、同一目标平台做“基线构建 vs 单后端构建”的 `EmbedPix.exe`、MSI/NSIS 安装包和附带 DLL/静态链接产物对比。
- libwebp 当前已经通过 `webp-animation` 的 `static` feature 进入原生依赖，静态 WebP 元数据清理额外使用固定的 `mux` feature；重点是确认是否重复打包两套 `libwebp-sys2`、静态链接是否把编码器完整带入每个架构，而不是把它当作全新依赖。
- OxiPNG 9.1.5 的 crate 元数据要求 Rust 1.74.0；本项目当前 toolchain 为 1.94.1。接入前用 `cargo tree --locked -e features -i oxipng`、`cargo metadata --locked` 和 release 二进制大小差分评估；只有在 `pngOptimizationLevel=0`、`6`、越界值拒绝、PNG 输出可解码、许可证清单和 x64/ARM64 构建均通过后才纳入默认后端。
- OxiPNG 9.1.5 的默认 feature 包含 `binary`、`parallel`、`zopfli`、`filetime`；桌面库当前使用 `default-features=false`，避免把 CLI、Zopfli、并行通道和额外文件时间依赖带入安装包。任何启用额外 feature 的变更都必须重新做包体积与耗时评估。
- MozJPEG 属于原生 C/汇编后端，必须额外记录编译器、静态/动态链接方式、运行库和最终安装包增量；没有实际 release 构建前不写固定 MB 结论。
- 建议把“安装包增量、最终可执行文件增量、依赖许可证变更、各架构结果”作为同一份发布附件，并为新后端设置经评审的增量预算；超预算时改为可选后端或延后发布。
