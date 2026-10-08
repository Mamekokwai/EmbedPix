# EmbedPix · 嵌图匠

EmbedPix 是一个面向嵌入式 UI 开发者的本地图片转换、压缩与动画制作工具。

它专注于解决绘图软件无法精确导出单片机所需图片格式的问题，支持图片预览与缩放、BMP 位深、JPEG 质量、RGB565 原始数据和可直接用于固件的 C 数组，并提供大小端、RGB/BGR、扫描方向与行对齐控制。另支持 PNG/JPEG/静态 WebP 压缩、目标体积、GIF/动画 WebP/APNG/PNG 帧序列制作。应用支持 Windows、macOS、Linux，图片不上传云端。

默认不覆盖同名文件；输出位置、命名、覆盖和删除源文件策略均在界面中明确设置。更新页支持后台检查、手动下载和安装签名更新。

## 开发

```bash
npm install
npm run tauri dev
```

## 验证

```bash
npm run check:types
npm run check:lint
npx vitest run
npm test
```

发布/桌面门禁：`npm run check:desktop-smoke`、`npm run check:compression-cli-smoke`、`npm run check:release-config`、`npm run check:release-fixture`。
