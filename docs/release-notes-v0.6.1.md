# EmbedPix v0.6.1

## 变更

- 改进 GIF 工作区帧元数据 mismatch 报告。
- 优化窄窗口布局，提升小尺寸窗口下的可用性。
- 修复安装器启动失败后遗留 health marker 的问题。

## 验证

- 版本文件保持 package、Cargo、Tauri 和 Cargo.lock 一致。
- 发布流程继续执行跨平台构建、真实 minisign 验签、latest.json、provenance 和 SHA256SUMS 门禁。
