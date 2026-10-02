# EmbedPix v0.7.16

## 发布内容

- 增加标题栏关闭链路回归门禁，固定关闭按钮和原生关闭事件都必须经过统一的任务清理后销毁路径。
- 固定 Tauri `core:window:allow-destroy` capability 契约，避免后续权限或窗口控制重构导致关闭按钮失效。
- 不改变图片、GIF、更新协议及导出行为。

## 验证

- 前端类型检查、lint、测试和生产构建通过。
- Rust fmt 与 clippy（`-D warnings`）通过。
- Windows x64/ARM64 签名安装包、更新清单和发布资产由发布流水线复核。
