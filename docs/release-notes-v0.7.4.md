# EmbedPix v0.7.4

## 变更

- 修复 Windows 发布签名预检脚本的 PowerShell 参数块顺序，避免 GitHub Actions 在签名前解析失败。
- 保留 v0.7.3 的 Rust Clippy 严格门禁修复，以及 v0.7.2 的压缩工作台滑动对比预览和 JPEG/WebP 视觉质量门槛。

## 验证

- 本地完成 PowerShell AST 解析、发布配置、依赖、fixture/PE 边界与签名清理 smoke。
- 发布工作流继续执行前端、Rust、签名、x64/ARM64 安装包、更新清单和真实安装启动门禁。

## 兼容性与限制

- 不改变 updater 公钥、更新协议或已有输出覆盖策略。
- Windows x64/ARM64 真实安装资产与签名结果以 v0.7.4 发布工作流验收为准。
