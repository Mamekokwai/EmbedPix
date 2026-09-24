# E5 GIF 质量预设基准

运行命令：

```text
cargo run --release --manifest-path src-tauri/Cargo.toml --bin gif_benchmark -- --quality-output-dir benchmarks/gif/e5
npm run check:gif-quality
```

三档使用同一确定性 `640×360` 长视频代理帧源，并实际调用现有 GIF Rust 编码路径：

| 预设 | 画布 | FPS | 颜色 | 帧数 | 编码速度 | 抖动 | 体积 | 耗时 | 首帧 RGB MAE |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| high-quality | 640×360 | 15 | 256 | 120 | 1 | none | 2,750,218 B | 13,801 ms | 3 |
| balanced | 480×270 | 12 | 128 | 96 | 10 | Floyd-Steinberg | 5,407,457 B | 3,298 ms | 5 |
| small-size | 320×180 | 8 | 64 | 32 | 30 | none | 322,160 B | 117 ms | 6 |

三档均使用当前后端的逐帧 NeuQuant 自适应调色板；本次不引入新的调色板依赖。采样间隔为 high-quality/balanced/small-size = 1/1/2，对应 UI 的 15/12/8 FPS 与 120/96/32 帧。现有 C5 自动压缩负责受限候选搜索，本 E5 预设基准固定参数，不把搜索耗时混入预设对比。阈值见 `thresholds.json`，包含耗时、体积、峰值内存和 MAE 上限。

峰值内存、完整输入参数和机器环境见 `quality-report.json`/`quality-report.csv`。MAE 是首帧 RGB 代理指标，不等价于完整动画时序感知质量；真实视觉质量仍需后续人工/窗口验收。
