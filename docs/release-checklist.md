# Release checklist

每个版本发布前按顺序执行；已有 Release 不删除、不重建，修复应进入下一版本或经明确授权后单独处理。

## 版本与资产

- [ ] package.json、Cargo.toml、Cargo.lock、tauri.conf.json 和 tag 版本一致
- [ ] 当前版本存在对应发布说明，标题为 `# EmbedPix v<version>`
- [ ] `npm run check:release-config`、`npm run check:release-deps` 和 `npm run check:release-fixture` 通过：NSIS/updater 开启、公钥一致、静态 WebP 依赖版本/许可证/feature、GUI subsystem、manifest/资产和 PE 边界契约存在
- [ ] Windows x64/ARM64 安装包和 `.sig` 成对存在
- [ ] 资产集合恰为 7 项：4 个安装资产、`latest.json`、`SHA256SUMS.txt`、`release-provenance.json`
- [ ] `latest.json` 版本、notes、平台 URL、Base64 minisign 签名与资产一致
- [ ] provenance 指向发布 tag/commit，SHA256SUMS 可对下载文件复算
- [ ] Release 非 draft，且 prerelease 状态与 Tag 是否包含预发布标识一致；稳定 Tag 不得标为 prerelease，预发布 Tag 不得伪装为稳定版

## 安装与更新 smoke

- [ ] 真实下载所有资产并验证 HTTP、大小、SHA256 和签名结构
- [ ] Windows runner 静默安装 x64 包成功
- [ ] 从安装目录启动应用，启动窗口保持运行至少 8 秒
- [ ] 安装后的 `EmbedPix.exe` 为 Windows GUI subsystem（subsystem=2），不残留控制台窗口
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

自动门禁：`scripts/release-config-smoke.ps1` 负责发布配置、公钥一致性和脚本契约；`scripts/release-fixture-smoke.ps1` 用临时伪造数据覆盖 7 项资产集合、manifest schema、平台 URL/签名、受信任 GitHub 下载 URL、`pub_date`、资产大小和 PE 边界负例；发布工作流在 publish 前用同一 release contract 校验本地资产并检查 x64/ARM64 构建产物的 GUI subsystem，publish 后由 `scripts/release-smoke.ps1` 先限制下载到精确的 GitHub release URL，再负责真实资产下载、SHA256、独立 minisign、安装后 PE GUI subsystem 和 Windows x64 安装/启动 smoke；不改变生产审批配置。

## v0.7.0 真实发布 smoke 记录

- 已对 GitHub Release `v0.7.0` 执行真实 smoke：x64/ARM64 资产均完成下载、大小、SHA256SUMS 和独立 minisign 验证。
- x64 安装器静默安装成功，安装后的 `EmbedPix.exe` 为 GUI subsystem=2，应用保持运行至少 8 秒，随后静默卸载并确认安装文件已移除。
- ARM64 安装器未在 x64 runner 上执行安装和启动；其资产下载、大小和签名已验证，原生 ARM64 安装/启动仍需 ARM64 runner 记录。
- 更新下载中断、断点续传、签名门禁和 `.part`/`.etag`/临时签名清理由本地 fixture 与 17 个 updater tests 覆盖；安装失败自动回滚仍未实现，当前行为是安装前阻断、失败诊断和首次启动健康 marker。

## v0.4.0 发布准备

- [ ] GIF 目标体积正式导出验收通过
- [ ] 静态 WebP、TIFF、ICO 输出验收通过
- [ ] WebP/APNG 动图输出验收通过
- [ ] 响应式 UI 矩阵验收通过
- [ ] 安装、启动、卸载 smoke 通过，资源清理无残留
- [ ] `metadataPolicy=preserve` 仍明确暂不支持；原因是当前编码链不保留 ICC/EXIF，未完成真实色彩管理与元数据 round-trip 契约
- [ ] 仅完成上述验收后再创建 `v0.4.0` tag；本次版本准备不创建 tag、不触发发布
