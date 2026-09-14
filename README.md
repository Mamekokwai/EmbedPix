# EngiFormat

EngiFormat 是一个面向嵌入式 UI 开发者的本地图片格式转换工具。

当前目标：

- 图片预览、缩放与保持比例导出
- PNG、JPG、BMP 格式转换
- BMP 位深与嵌入式像素格式控制
- Windows、macOS、Linux 桌面 GUI

## 开发

```bash
npm install
npm run dev
```

运行 Tauri 桌面开发模式：

```bash
npm run tauri dev
```

核心图片处理在 Rust 中按需执行，不运行常驻后台进程。各平台需要安装对应的 Tauri 桌面运行环境。

## 验证

```bash
npm test
npm run build
```

## 许可

MIT
