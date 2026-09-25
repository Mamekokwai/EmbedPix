# Release checklist

每个版本发布前按顺序执行；已有 Release 不删除、不重建，修复应进入下一版本或经明确授权后单独处理。

## 版本与资产

- [ ] package.json、Cargo.toml、Cargo.lock、tauri.conf.json 和 tag 版本一致
- [ ] Windows x64/ARM64 安装包和 `.sig` 成对存在
- [ ] 资产集合恰为 7 项：4 个安装资产、`latest.json`、`SHA256SUMS.txt`、`release-provenance.json`
- [ ] `latest.json` 版本、平台 URL、Base64 minisign 签名与资产一致
- [ ] provenance 指向发布 tag/commit，SHA256SUMS 可对下载文件复算
- [ ] Release 为非 draft、非 prerelease（除非版本明确为预发布）

## 安装与更新 smoke

- [ ] 真实下载所有资产并验证 HTTP、大小、SHA256 和签名结构
- [ ] Windows runner 静默安装 x64 包成功
- [ ] 从安装目录启动应用，启动窗口保持运行至少 8 秒
- [ ] 更新失败时 `.part` 和不完整缓存被清理，错误状态可定位
- [ ] 签名、manifest 或哈希不一致时安装前阻断，不启动安装器

## 回归矩阵

| 场景 | x64 | ARM64 | 预期 |
| --- | --- | --- | --- |
| 下载并校验安装包 | [ ] | [ ] | HTTP、大小、SHA256、签名均通过 |
| 静默安装 | [ ] | [ ] | 安装器退出码为 0 |
| 安装后启动 | [ ] | [ ] | 进程可启动并保持运行 |
| 篡改安装包 | [ ] | [ ] | SHA256/签名失败且不安装 |
| 篡改 manifest | [ ] | [ ] | 版本/平台/签名校验失败 |
| 下载中断 | [ ] | [ ] | 临时文件清理，可重试 |

自动门禁：`scripts/release-smoke.ps1` 负责发布资产下载、7 项集合、manifest Base64 minisign 结构、SHA256 和 Windows x64 安装/启动 smoke；发布工作流在上传后执行它，不改变生产审批配置。

## v0.4.0 发布准备

- [ ] GIF 目标体积正式导出验收通过
- [ ] 静态 WebP、TIFF、ICO 输出验收通过
- [ ] WebP/APNG 动图输出验收通过
- [ ] 响应式 UI 矩阵验收通过
- [ ] 安装、启动、卸载 smoke 通过，资源清理无残留
- [ ] `metadataPolicy=preserve` 仍明确暂不支持；原因是当前编码链不保留 ICC/EXIF，未完成真实色彩管理与元数据 round-trip 契约
- [ ] 仅完成上述验收后再创建 `v0.4.0` tag；本次版本准备不创建 tag、不触发发布
