$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

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
$cleanupHelper = Join-Path $PSScriptRoot 'release-signing-preflight-cleanup.ps1'
if (-not (Test-Path -LiteralPath $cleanupHelper -PathType Leaf)) {
  throw "签名预检清理 helper 不存在：$cleanupHelper"
}
. $cleanupHelper

Push-Location $root
$probeDirectory = Join-Path ([IO.Path]::GetTempPath()) ("embedpix-signing-preflight-" + [guid]::NewGuid().ToString('N'))
$failure = $null
$cleanupFailure = $null
try {
  & $configSmoke | Out-Host
  if (-not $?) {
    throw '更新公钥或发布配置校验失败。'
  }

  New-Item -ItemType Directory -Path $probeDirectory -Force | Out-Null
  $probeInput = Join-Path $probeDirectory 'probe.bin'
  $probeSignature = "$probeInput.sig"
  [IO.File]::WriteAllBytes($probeInput, [Text.Encoding]::UTF8.GetBytes('EmbedPix signing preflight'))

  # Keep the private key in the inherited environment; never put it in argv or output.
  & npx --no-install tauri signer sign $probeInput *> $null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $probeSignature -PathType Leaf)) {
    throw '签名私钥无法解析、密码不正确或无法完成探针签名。'
  }

  $verifierManifest = Join-Path $root 'tools/minisign-verifier/Cargo.toml'
  $verifierBase = Join-Path $root 'tools/minisign-verifier/target/release/embedpix-minisign-verifier'
  $verifier = if (Test-Path -LiteralPath "$verifierBase.exe" -PathType Leaf) { "$verifierBase.exe" } else { $verifierBase }
  if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
    & cargo build --manifest-path $verifierManifest --release --locked --quiet *> $null
    if ($LASTEXITCODE -ne 0) {
      throw '无法构建独立 minisign verifier。'
    }
    $verifier = if (Test-Path -LiteralPath "$verifierBase.exe" -PathType Leaf) { "$verifierBase.exe" } else { $verifierBase }
  }
  if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
    throw '独立 minisign verifier 构建后仍不存在。'
  }

  $publicKey = Join-Path $root 'src-tauri/update-public-key.txt'
  & $verifier $publicKey $probeInput $probeSignature *> $null
  if ($LASTEXITCODE -ne 0) {
    throw '签名私钥对应的公钥与 EmbedPix 受信更新公钥不匹配。'
  }
} catch {
  $failure = $_.Exception
}
finally {
  try {
    Remove-ReleaseSigningProbeDirectory -Path $probeDirectory
  } catch {
    $cleanupFailure = $_.Exception
  }
  Pop-Location
}

if ($null -ne $failure) {
  if ($null -ne $cleanupFailure) {
    throw "签名预检失败：$($failure.Message)；清理失败：$($cleanupFailure.Message)"
  }
  throw $failure
}
if ($null -ne $cleanupFailure) {
  throw $cleanupFailure
}

Write-Host '签名预检通过：私钥可用且与受信更新公钥匹配，发布配置有效。'
