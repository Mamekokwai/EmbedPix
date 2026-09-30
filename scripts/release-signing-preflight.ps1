$ErrorActionPreference = 'Stop'

$privateKey = $env:TAURI_SIGNING_PRIVATE_KEY
if ([string]::IsNullOrWhiteSpace($privateKey)) {
  throw '缺少 TAURI_SIGNING_PRIVATE_KEY。请在受控的 GitHub Secret 或本机安全环境变量中配置签名私钥。'
}

# Minisign encrypted keys require a password, while plain keys do not.
if ($privateKey -match 'minisign encrypted secret key' -and [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD)) {
  throw '当前 TAURI_SIGNING_PRIVATE_KEY 是加密私钥，但未配置 TAURI_SIGNING_PRIVATE_KEY_PASSWORD。'
}

$configSmoke = Join-Path $PSScriptRoot 'release-config-smoke.ps1'
if (-not (Test-Path -LiteralPath $configSmoke -PathType Leaf)) {
  throw "发布配置 smoke 脚本不存在：$configSmoke"
}
& $configSmoke | Out-Host
if (-not $?) {
  throw '更新公钥或发布配置校验失败。'
}

Write-Host '签名预检通过：私钥变量已配置，更新公钥与发布配置有效。'
