# EmbedPix v0.7.5

## 变更

- 修复 Windows 发布签名预检脚本的首行 BOM/空白兼容性，确保 GitHub Actions PowerShell 能稳定解析 `[CmdletBinding()]`。
- 保留 v0.7.4 的签名预检修复、v0.7.3 的 Rust Clippy 严格门禁修复，以及 v0.7.2 的压缩工作台改进。

## 验证

- 本地确认脚本 UTF-8 BOM 位于属性块首字符，并通过 PowerShell AST 解析、发布配置、fixture/PE 边界和签名清理 smoke。
- 发布工作流继续执行前端、Rust、签名、x64/ARM64 安装包、更新清单和真实安装启动门禁。

## 兼容性与限制

- 不改变 updater 公钥、更新协议或已有输出覆盖策略。
- Windows x64/ARM64 真实安装资产与签名结果以 v0.7.5 发布工作流验收为准。
