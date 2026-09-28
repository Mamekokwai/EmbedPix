# EmbedPix v0.7.0

## 变更

- 新增桌面 smoke 脚本与 Windows CI 契约，统一验证关键桌面流程入口。
- GIF 视频工作区保存源类型、时长和帧率元数据，并在恢复不安全或不完整时提供提示。
- 统一前后端任务状态契约，改善 GIF/图片任务进度、取消和失败状态的一致性。

## 验证

- 前端测试、生产构建和桌面 smoke 契约通过。
- Rust fmt、check、test、clippy 通过。
- 发布流程继续执行跨平台构建、真实 minisign 验签、latest.json、provenance 和 SHA256SUMS 门禁。

## v0.7.0 发布 smoke 记录

- 已对真实 GitHub Release `v0.7.0` 执行发布 smoke：x64/ARM64 安装资产均完成下载、大小、SHA256SUMS 和独立 minisign 验证。
- x64 安装器静默安装成功；安装后的 `EmbedPix.exe` 使用 Windows GUI subsystem（subsystem=2），启动后保持运行至少 8 秒，并完成静默卸载与文件清理确认。
- ARM64 资产已完成下载和签名验证，但本次运行在 x64 runner 上，未执行原生 ARM64 安装/启动；该项仍需 ARM64 runner 验证。
- 本地 release fixture 与 17 个 updater tests 覆盖 manifest/Tag 状态、下载中断、断点续传、签名门禁以及 `.part`、`.etag` 和临时签名清理。

## 限制

- 安装失败后的自动回滚仍未支持；当前提供安装前完整校验、下载失败清理、首次启动健康诊断和失败日志路径。
