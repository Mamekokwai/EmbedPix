# C4 实验结论

实验命令：

```text
cargo run --release --manifest-path src-tauri/Cargo.toml --bin gif_palette_experiment -- --output-dir=benchmarks/gif/c4
```

当前实现的三组对照均使用同一批确定性帧；`quality_mae_rgb` 是首帧 RGB 平均绝对误差，数值越低越好。峰值内存是 Windows 进程 PeakWorkingSet 的进程水位记录；FFmpeg 外部命令只记录命令级耗时和输出体积，未纳入同一进程峰值内存比较。

| 样本 | 模式 | 体积 | 耗时 | RGB MAE | 峰值内存 |
| --- | --- | ---: | ---: | ---: | ---: |
| landscape | none | 258069 B | 116 ms | 0 | 6.6 MiB |
| landscape | floydSteinberg | 379749 B | 656 ms | 0 | 7.2 MiB |
| portrait | none | 281069 B | 126 ms | 4 | 7.2 MiB |
| portrait | atkinson | 664129 B | 381 ms | 5 | 7.9 MiB |
| transparent-png | none | 273376 B | 83 ms | 3 | 7.9 MiB |
| transparent-png | atkinson | 230159 B | 441 ms | 6 | 7.9 MiB |
| game-recording | none | 2477929 B | 858 ms | 0 | 13.4 MiB |
| long-video | none | 1910765 B | 1502 ms | 4 | 14.5 MiB |

FFmpeg 8.0 的 `palettegen/paletteuse` 可执行且可用；对当前 GIF 输入重量化的体积/耗时分别为 landscape 9763 B/182 ms、portrait 732690 B/379 ms、transparent-png 204732 B/134 ms、game-recording 392663 B/332 ms、long-video 10077982 B/2799 ms。这不是与原始 PNG 帧完全同源的生产对比，因此只作为外部参考，不作为合并依据。

Gifski 在本机不可用，未接入或 vendoring 其实现。其仓库 Cargo 元数据声明 AGPL-3.0-or-later；FFmpeg 官方说明基础代码为 LGPL-2.1+，但启用 GPL 组件时整体受 GPL 约束。本机 FFmpeg `-version` 显示 `--enable-gpl`，因此没有将它作为生产依赖或分发组件。

结论：当前逐帧量化的无抖动模式在这些样本上体积和耗时最稳定；抖动显著增加耗时，画质代理没有稳定改善，不能仅凭本实验接入跨帧全局调色板。C4 只提交实验 harness 和数据，不改变生产编码器。
