# EmbedPix v0.4.0

## 主要更新

- GIF 目标体积搜索进入正式导出链路。
- 支持 WebP、TIFF、ICO 静态输出。
- 支持 WebP/APNG 动图输出。
- 响应式 UI 覆盖窄窗口、长文件名、键盘导航和失败状态。
- 发布流程增加真实下载、安装、启动、卸载 smoke，以及安装器/进程/临时资源清理诊断。

## 兼容性与限制

- 发布目标仍为 Windows x64 和 ARM64。
- `metadataPolicy=preserve` 暂不支持。当前编码链默认生成清理后的输出，不保留 ICC/EXIF；真实色彩管理和元数据 round-trip 尚未形成可验证契约，因此不会宣称支持 preserve。
- smoke gate 验证发布资产、manifest Base64 minisign 结构、SHA256、静默安装、启动存活和卸载清理。
