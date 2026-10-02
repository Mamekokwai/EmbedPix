# EmbedPix v0.7.9

## 发布内容

- 修复 macOS 构建中 `statvfs` 可用空间字段类型不一致导致的 Rust 编译失败。
- 修复 Linux 发布结果路径测试对 Windows 反斜杠路径的误判。
- 保留 v0.7.8 的标题栏关闭按钮可靠性修复及已有图片压缩、GIF、更新器改进。

## 验证

- 本地 Rust fmt、Clippy 和 280 项 Rust 测试通过。
- v0.7.9 发布后将复核 Linux、macOS、Windows 跨平台检查与签名资产。
