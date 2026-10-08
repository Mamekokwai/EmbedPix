# EmbedPix v0.8.2

## 改进

- 图片转换支持 BMP、PNG、JPG、WebP、TIFF、ICO、RGB565 BIN 与 C 数组等输出，并保留嵌入式场景需要的位深、通道顺序、字节序、扫描方向和行对齐参数。
- 图片压缩工作区支持 PNG、JPEG 和静态 WebP，提供质量/无损策略、目标体积、按需缩放、元数据策略、跳过更大结果、批处理和输出位置控制。
- GIF 制作支持图片批量导入与视频抽帧，输出 GIF、动画 WebP、APNG 或 PNG 帧序列，并提供帧编辑、画布、时长、采样和自动压缩设置。
- 更新器支持启动后后台检查，以及更新页中的手动检查、下载和安装；发布链路校验签名、哈希、manifest 与 provenance。

- 优化图片转换与图片压缩工作区的导入、预览和参数布局。
- 精简格式说明与底部冗余文案，改善窄窗口下的空间利用。
- 优化输出格式按钮、压缩预览和交互状态的响应式表现。
- 修复预览拖动、参数摘要对齐及导出设置布局问题。

## 验证

- 类型检查、Lint 和全量 Vitest 测试通过。
- 发布相关门禁可使用 `npm run check:release-config`、`npm run check:release-fixture`、`npm run check:release-signing` 验证；桌面与压缩 smoke 分别使用 `npm run check:desktop-smoke` 和 `npm run check:compression-cli-smoke`。
