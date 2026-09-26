# EmbedPix v0.6.0

## 变更

- 新增严格版本化的 `.embedpix-workspace.json` 工作区快照。
- 快照保存图片/GIF 参数、输出配置和帧元数据。
- 支持 Tauri 静态图片源恢复，并在浏览器环境提供降级提示。
- 工作区恢复失败时不覆盖现有配置，避免损坏当前工作区。

## 验证

- 前端 233 项测试与生产构建通过。
- Rust fmt、check、142 个库测试及 3 个 CLI 测试、clippy 通过。
- 发布流程继续执行跨平台构建、真实 minisign 验签、latest.json、provenance 和 SHA256SUMS 门禁。

## 限制

- WebP 有损质量参数不保证与外部编码器等价。
- 当前不支持 ICC/EXIF 原样保留和安装失败自动回滚。
