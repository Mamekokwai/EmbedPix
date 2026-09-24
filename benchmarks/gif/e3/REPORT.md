# E3 性能与回归基准

运行命令：

```text
cargo run --release --manifest-path src-tauri/Cargo.toml --bin gif_benchmark -- --output-dir benchmarks/gif/e3
npm run check:gif-benchmark
```

本次记录来自 Windows x86_64、64 位进程，生成器为 `deterministic-rgba-frame-generator`。输入参数、输出体积、峰值磁盘、耗时、峰值内存和失败率见同目录 `baseline.json`/`baseline.csv`。

覆盖样本：大图 `2048×2048`、既有长视频代理 `120` 帧、`200` 帧上限、混合源尺寸 `40` 帧，以及既有横屏、竖屏、透明 PNG 和游戏录屏样本。

回归门槛见 `thresholds.json`：失败率必须为 0；每个样本分别限制耗时、峰值内存和输出体积。峰值磁盘按基准输出目录中已观测的最大输出文件大小记录；当前编码路径不产生额外磁盘帧缓存。

限制：`long-video` 和 `two-hundred-frames` 是确定性合成 RGBA 帧，不包含真实视频容器解码、关键帧 seek 或硬件解码开销；真实长视频矩阵仍需真实媒体样本补充。
