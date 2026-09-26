# EmbedPix v0.5.2

## 变更

- 新增预设迁移数据契约，降低版本升级时的兼容风险。
- 新增图片与 GIF 预设 JSON 导入/导出，便于备份、迁移和共享配置。

## 验证

- 前端 229 项测试与生产构建通过。
- Rust fmt、check、142 个库测试及 3 个 CLI 测试、clippy 通过。
- 发布流程继续执行跨平台构建、真实 minisign 验签、latest.json、provenance 和 SHA256SUMS 门禁。

## 限制

- WebP 有损质量参数不保证与外部编码器等价。
- 当前不支持 ICC/EXIF 原样保留和安装失败自动回滚。
