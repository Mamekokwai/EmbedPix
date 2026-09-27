# EmbedPix v0.6.2

## 变更

- 修复非 Windows 目标编译时更新 health marker 清理函数未使用导致的 clippy 失败。
- 保持安装器启动失败后清理 health marker 的更新恢复行为。

## 验证

- 版本文件保持 package、Cargo、Tauri 和 Cargo.lock 一致。
- 重新执行前端测试/构建和 Rust fmt、check、test、clippy 门禁。
