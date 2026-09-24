# 视频抽帧确定性 fixture

这两个文件用于本地视频抽帧 smoke 检查，不是发布媒体，也不代表真实长视频性能：

- `deterministic-320x180-2s.mp4`：320×180、10 fps、2 秒、H.264，27,296 bytes
- `deterministic-320x180-2s.webm`：320×180、10 fps、2 秒、VP9，29,292 bytes

生成环境：本机 FFmpeg 8.0。重新生成命令：

```powershell
ffmpeg -hide_banner -loglevel error -f lavfi -i "testsrc2=size=320x180:rate=10" -t 2 -c:v libx264 -preset medium -crf 28 -pix_fmt yuv420p -g 10 -movflags +faststart -y deterministic-320x180-2s.mp4
ffmpeg -hide_banner -loglevel error -f lavfi -i "testsrc2=size=320x180:rate=10" -t 2 -c:v libvpx-vp9 -b:v 0 -crf 35 -pix_fmt yuv420p -g 10 -y deterministic-320x180-2s.webm
```

SHA-256：

```text
deterministic-320x180-2s.mp4  3DE4E3DDF84A94E4932CAFFC14208F60DE090C6564960AB82322DC9E1497A7B7
deterministic-320x180-2s.webm 4F52C4995F706B3A4263D5F9292E1BD06F72C941D1BC2D7ADD89743511FA76CC
```

相关 smoke/回归检查：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --locked commands::gif::spool
npm test -- --run src/features/gif-maker/videoFrameExtraction.test.ts
```

后端测试覆盖 200 帧边界、单帧/总资源预算、成功读取、失败清理、取消清理和孤儿 spool 目录清理；浏览器 `HTMLVideoElement` 对 MP4/WebM 的真实 seek、解码和 `canvas.toBlob` 仍需桌面窗口 E2E，Rust 单测无法替代该部分证据。
