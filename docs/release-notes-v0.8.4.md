# EmbedPix v0.8.4

## 修复

- 修复 Windows 更新器安装完成后未自动重新启动应用的问题。
- 修复非 Windows 构建执行 Clippy 时更新器辅助函数触发 `dead_code` 的问题。
- 保留 Windows 更新接力安装和测试环境中的更新器契约验证。

## 验证

- Rust 格式检查、Clippy、更新器测试通过。
- 前端类型检查、Lint 和 Vitest 测试通过。
