# EmbedPix v0.4.2

## 主要更新

- 修正 `metadataPolicy=preserve` 的位深处理，避免受限直通路径报告错误的输出位深。
- 增加导出文件回读与资源清理测试，覆盖成功、失败、取消和临时文件清理路径。
- 更新器支持带 ETag 的安全断点续传、Range 回退和失败重试，最终仍执行大小、SHA256 与 minisign 校验。
- 修复 UI 生命周期和短窗口场景下的状态清理与可达性问题。

## 兼容性与限制

- 发布目标仍为 Windows x64 和 ARM64。
- `metadataPolicy=preserve` 仍是受限直通，只在后端能力契约满足时允许；不代表所有格式都支持 ICC/EXIF 或完整色彩管理。
- 发布继续通过下载、签名、manifest、哈希、安装、启动和卸载 smoke gate，并受 production environment 审批保护。
