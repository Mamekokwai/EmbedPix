# EmbedPix v0.7.8

## 发布内容

- 修复 Linux/macOS Clippy 对磁盘空间计算的跨平台编译问题。
- 修复 Linux/macOS GIF spool 非阻塞错误码检查在严格警告模式下的编译问题。
- 将压缩 CLI 冒烟测试改为运行时生成确定性 PNG/GIF fixture，避免 CI checkout 缺少被忽略样例文件。
- 保留 v0.7.7 的签名轮换、图片压缩、GIF 制作、视频转 GIF 与更新器修复。

## 验证

- Rust 单元测试：285 项通过。
- 前端测试：421 项通过。
- 生产构建、桌面 smoke、发布配置、发布 fixture、依赖审计和压缩 CLI smoke：全部通过。
- GitHub Actions 的跨平台发布工作流将在 tag 推送后进行最终验收。
