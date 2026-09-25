# EmbedPix v0.4.1

## 主要更新

- 增加批量任务暂停/继续，暂停时保留已完成项、失败项和可恢复队列状态。
- 增加安全的 `metadataPolicy=preserve` 受限直通：仅在后端明确支持且能保留原始元数据时允许透传，否则明确拒绝，不伪造保留结果。
- 延续 v0.4.0 的 GIF 目标体积、WebP/TIFF/ICO 静态输出、WebP/APNG 动图和响应式 UI 能力。
- 保留发布下载、安装、启动、卸载 smoke 及资源清理诊断。

## 兼容性与限制

- 发布目标仍为 Windows x64 和 ARM64。
- `metadataPolicy=preserve` 是受限直通，不代表所有格式都支持 ICC/EXIF 或完整色彩管理；不满足后端能力契约时会安全失败。
- v0.4.0 smoke 中发现的 PowerShell `ArgumentList` 与安装路径索引问题已分别由 `b5ae1a3`、`9c23e25` 修复，后续 smoke 使用安全参数数组和显式首路径选择。
