# EmbedPix v0.7.19

## 发布内容

- 视频生 GIF 窄窗口下，视频文件名与分辨率信息支持悬停查看完整内容。
- GIF、WebP 和 PNG 帧序列导出进度阶段统一使用中文，状态反馈更易读。
- 不改变抽帧、编码、输出覆盖策略、native IPC 或更新协议。

## 验证

- 前端类型检查、lint、完整 Vitest 测试和生产构建通过。
- Rust fmt、clippy、检查与发布 fixture 门禁通过。
- Windows x64/ARM64 签名安装包、更新清单和发布资产由发布流水线复核。
