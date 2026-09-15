# EmbedPix · 嵌图匠

EmbedPix 是一个面向嵌入式 UI 开发者的本地图片格式转换工具。

它专注于解决绘图软件无法精确导出单片机所需图片格式的问题，支持图片预览与缩放、BMP 位深、JPEG 质量、RGB565 原始数据和可直接用于固件的 C 数组，并提供大小端、RGB/BGR、扫描方向与行对齐控制。应用支持 Windows、macOS、Linux。

## 开发

```bash
npm install
npm run tauri dev
```

## 验证

```bash
npm test
npm run build
```
