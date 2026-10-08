# EmbedPix · 嵌图匠

EmbedPix 是一个面向嵌入式 UI 开发者的本地图片转换、压缩与动画制作工具。

当前目标：

- 图片预览、缩放与保持比例导出
- PNG、JPG、BMP、WebP、TIFF、ICO、RGB565 BIN 与 C 数组导出
- BMP 位深、JPEG 质量、RGB/BGR、大小端、扫描方向与行对齐控制
- PNG/JPEG/静态 WebP 压缩、目标体积、按需缩放、元数据策略与跳过更大结果
- GIF、动画 WebP、APNG 与 PNG 帧序列制作，支持图片批量导入和视频抽帧
- 输出位置、文件命名、覆盖保护、源文件删除与压缩结果回滚策略
- Windows、macOS、Linux 桌面 GUI

所有图片处理都在本机完成，不上传图片。转换和压缩使用桌面端原生处理路径；浏览器预览不等于原生导出。

## 输出与覆盖

图片转换和压缩支持源文件夹、子目录或指定目录等输出方式；GIF/动画导出支持选择文件或目录。默认不会覆盖同名文件，启用覆盖后才会写入；压缩替换原图时会先按界面策略创建备份。导出成功后才会执行可选的删除源文件操作，失败或取消不会发布半成品。

## 更新与发布

应用启动后会在后台检查更新，也可以在更新页面手动检查、下载和安装。发布使用 Tauri 签名更新包，并校验 manifest、下载地址、哈希和签名。私钥只允许通过发布环境密钥提供，不得提交到仓库或日志。

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
npm run check:types
npm run check:lint
npx vitest run
npm test
```

发布/桌面门禁：`npm run check:desktop-smoke`、`npm run check:compression-cli-smoke`、`npm run check:release-config`、`npm run check:release-deps`、`npm run check:release-fixture`、`npm run check:release-signing`。

`npm run build` 用于正式构建，可能生成构建产物；文档校验不要求运行它。

## 许可

MIT
