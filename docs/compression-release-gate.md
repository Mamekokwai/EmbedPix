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

## 压缩核心合并后的强制门禁

```powershell
pwsh -NoProfile -File scripts/compression-cli-smoke.ps1 -RequireCompression
```

强制模式检查真实的 Tauri 原生契约：

- `preflight_compression`、`compress_image`、`cancel_compression` 入口存在；
- `path`、`source`、`directory`、`subfolder`、`original` 输出位置有契约入口；
- 输出经过现有原子发布/回滚入口；
- `skipIfLarger` 已进入原生或 gateway 契约。

现有 CLI smoke 仍检查真实支持的 image/GIF 输出：签名、SHA256 和二次解码。原生压缩真正可调用后，应再增加桌面 Tauri IPC fixture，检查 `skipIfLarger` 的跳过结果、输出位置实际路径、取消、失败清理和源文件不变；当前脚本不会越界假设 CLI 存在这些操作。

## 第三方编码器许可证清单

| 组件/编码器 | 当前状态 | 许可证/证据要求 | 发布阻塞 |
|---|---|---|---|
| `image` crate PNG/JPEG/WebP 基础能力 | 已在生产依赖 | 固定 Cargo.lock 版本，保留 Cargo license 追踪 | 否 |
| `gif` crate | 已在生产依赖 | 固定 Cargo.lock 版本，保留 Cargo license 追踪 | 否 |
| libwebp（由 `image` WebP feature 使用） | 间接依赖/需随依赖树复核 | 发布前核对上游许可证与 Cargo 依赖树，不单独宣称压缩后端 | 否，直到启用专用后端 |
| OxiPNG | 尚未引入 | 引入前固定版本、核对 MIT 许可证及完整依赖链，并加入 NOTICE/清单 | 是 |
| MozJPEG | 尚未引入 | 评估依赖链、静态链接和许可证后再启用 | 是 |
| pngquant | 未引入 | GPLv3/商业许可路径需明确，不得默认捆绑 | 是 |
| libavif/AV1 编码器 | 未引入 | 明确编码器、静态链接、专利/许可证和安装包体积影响 | 是 |

原则：新增编码器必须固定版本、完成许可证与版权清单、在 x64/ARM64 分别构建验证，并通过输出签名、SHA256、可解码和发布资产 smoke。
