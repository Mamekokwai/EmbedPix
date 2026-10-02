# EmbedPix v0.7.7

## 发布内容

- 修复签名轮换预检对 Tauri 外层 Base64 公钥与签名的解码流程。
- 更新 EmbedPix updater 受信公钥配置，支持新的无密码签名密钥。
- 保留图片压缩、GIF 制作、视频转 GIF 与更新器稳定性修复。

## 验证

- 本地签名预检已使用新密钥完成真实签名与独立 minisign 校验。
- 发布配置、前端测试、生产构建、桌面 smoke 与 release fixture 将在发布前门禁中复核。
