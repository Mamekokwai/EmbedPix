# EmbedPix v0.5.1

## 修复

- 修复 GIF job expiry 测试的跨平台时间处理，确保 Windows/Linux/macOS CI 使用一致的过期判定。
- 延续 v0.5.0 的更新安装健康诊断、真实发布签名 smoke、资源清理和输出体验改进。

## 限制

- 发布目标仍为 Windows x64 和 ARM64。
- WebP 有损质量、ICC/EXIF 原样保留和安装失败自动回滚仍不作为已支持能力。
