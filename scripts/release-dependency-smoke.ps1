[CmdletBinding()]
param(
  [string]$InstallerPath,
  [string]$BinaryPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$manifest = Get-Content -Raw 'src-tauri/Cargo.toml'
if ($manifest -notmatch 'libwebp-sys2\s*=\s*\{\s*version\s*=\s*"=0\.2\.0"\s*,\s*features\s*=\s*\["static"\]\s*\}') {
  throw 'libwebp-sys2 must remain pinned to 0.2.0 with the static feature.'
}
if ($manifest -notmatch 'webp-animation\s*=\s*\{[^}]*features\s*=\s*\["static"\]') {
  throw 'webp-animation must retain its static feature.'
}
$lock = Get-Content -Raw 'src-tauri/Cargo.lock'
if ($lock -notmatch '(?s)name = "libwebp-sys2"\s+version = "0\.2\.0"') {
  throw 'Cargo.lock does not contain libwebp-sys2 0.2.0.'
}

$metadataJson = cargo metadata --manifest-path src-tauri/Cargo.toml --locked --format-version 1 | Out-String
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect locked Cargo metadata.' }
$packages = ($metadataJson | ConvertFrom-Json).packages
$webpPackage = $packages | Where-Object { $_.name -eq 'libwebp-sys2' -and $_.version -eq '0.2.0' } | Select-Object -First 1
if (-not $webpPackage -or $webpPackage.license -ne 'BSD-3-Clause') {
  throw 'Cargo metadata does not report libwebp-sys2 0.2.0 with BSD-3-Clause.'
}
$animationPackage = $packages | Where-Object { $_.name -eq 'webp-animation' -and $_.version -eq '0.10.0' } | Select-Object -First 1
if (-not $animationPackage -or $animationPackage.license -ne 'MIT OR Apache-2.0') {
  throw 'Cargo metadata does not report webp-animation 0.10.0 with MIT OR Apache-2.0.'
}

$tree = cargo tree --manifest-path src-tauri/Cargo.toml --locked -e features -i libwebp-sys2@0.2.0 | Out-String
if ($LASTEXITCODE -ne 0 -or $tree -notmatch 'libwebp-sys2 feature "static"' -or $tree -notmatch 'webp-animation') {
  throw 'The locked feature tree does not prove the static libwebp path is active.'
}

$sizeReport = [ordered]@{}
foreach ($entry in @(
  [pscustomobject]@{ label = 'installer'; path = $InstallerPath },
  [pscustomobject]@{ label = 'binary'; path = $BinaryPath }
)) {
  if ([string]::IsNullOrWhiteSpace($entry.path)) { continue }
  if (-not (Test-Path -LiteralPath $entry.path -PathType Leaf)) { throw "$($entry.label) artifact is missing: $($entry.path)" }
  $sizeReport["$($entry.label)Bytes"] = (Get-Item -LiteralPath $entry.path).Length
}

[pscustomobject]@{
  libwebpVersion = $webpPackage.version
  libwebpLicense = $webpPackage.license
  webpAnimationVersion = $animationPackage.version
  webpAnimationLicense = $animationPackage.license
  staticFeatureTree = $true
  artifactSizes = [pscustomobject]$sizeReport
} | ConvertTo-Json -Depth 4
