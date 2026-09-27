# EmbedPix v0.7.0

## 变更

- 新增桌面 smoke 脚本与 Windows CI 契约，统一验证关键桌面流程入口。
- GIF 视频工作区保存源类型、时长和帧率元数据，并在恢复不安全或不完整时提供提示。
- 统一前后端任务状态契约，改善 GIF/图片任务进度、取消和失败状态的一致性。

## 验证

- 前端测试、生产构建和桌面 smoke 契约通过。
- Rust fmt、check、test、clippy 通过。
- 发布流程继续执行跨平台构建、真实 minisign 验签、latest.json、provenance 和 SHA256SUMS 门禁。
