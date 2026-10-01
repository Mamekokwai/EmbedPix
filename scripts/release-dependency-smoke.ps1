[CmdletBinding()]
param(
  [string]$InstallerPath,
  [string]$BinaryPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$manifest = Get-Content -Raw 'src-tauri/Cargo.toml'
if ($manifest -notmatch 'libwebp-sys2\s*=\s*\{\s*version\s*=\s*"=0\.2\.0"\s*,\s*features\s*=\s*\[\s*"static"\s*,\s*"mux"\s*\]\s*\}') {
  throw 'libwebp-sys2 must remain pinned to 0.2.0 with exactly the audited static and mux features.'
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
$notice = Get-Content -Raw 'NOTICE'

function Assert-NoUnreviewedCodecBackends([object[]]$Packages) {
  $unreviewedBackendNames = @(
    'mozjpeg', 'mozjpeg-sys',
    'libavif', 'libavif-sys',
    'aom', 'aom-sys', 'rav1e', 'rav1e-sys',
    'svt-av1', 'svt-av1-sys', 'libyuv', 'libyuv-sys',
    'dav1d', 'dav1d-sys'
  )
  $unreviewedBackends = @($Packages | Where-Object { $unreviewedBackendNames -contains $_.name })
  if ($unreviewedBackends.Count -eq 0) { return }
  $found = ($unreviewedBackends | ForEach-Object { "$($_.name)@$($_.version)" }) -join ', '
  throw "Unreviewed MozJPEG/libavif/AV1 backend dependency detected: $found. Before release, complete NOTICE, license/patent review, static-vs-dynamic link audit, per-architecture builds, and real runner encode/decode/install smoke."
}
Assert-NoUnreviewedCodecBackends $packages

$requiredNotices = @(
  @{ name = 'kamadak-exif'; version = '0.6.1'; license = 'BSD-2-Clause'; marker = 'kamadak-exif 0.6.1'; attribution = "KAMADA Ken'ichi" },
  @{ name = 'jpeg-encoder'; version = '0.7.1'; license = '(MIT OR Apache-2.0) AND IJG'; marker = 'jpeg-encoder 0.7.1'; attribution = 'Independent JPEG Group' },
  @{ name = 'oxipng'; version = '9.1.5'; license = 'MIT'; marker = 'OxiPNG 9.1.5'; attribution = 'Joshua Holmer' },
  @{ name = 'webp-animation'; version = '0.10.0'; license = 'MIT OR Apache-2.0'; marker = 'webp-animation 0.10.0'; attribution = 'Permission is hereby granted' },
  @{ name = 'libwebp-sys2'; version = '0.2.0'; license = 'BSD-3-Clause'; marker = 'libwebp-sys2 0.2.0 and 0.1.11'; attribution = 'Masaki Hara' },
  @{ name = 'libwebp-sys2'; version = '0.1.11'; license = 'BSD-3-Clause'; marker = 'libwebp-sys2 0.2.0 and 0.1.11'; attribution = 'Masaki Hara' }
)
foreach ($required in $requiredNotices) {
  $package = $packages | Where-Object { $_.name -eq $required.name -and $_.version -eq $required.version } | Select-Object -First 1
  if (-not $package -or $package.license -ne $required.license) {
    throw "Cargo metadata does not report $($required.name) $($required.version) with $($required.license)."
  }
  if ($notice -notmatch [regex]::Escape($required.marker) -or $notice -notmatch [regex]::Escape($required.attribution)) {
    throw "NOTICE does not contain the audited notice for $($required.name) $($required.version)."
  }
}
$webpPackage = $packages | Where-Object { $_.name -eq 'libwebp-sys2' -and $_.version -eq '0.2.0' } | Select-Object -First 1
if (-not $webpPackage -or $webpPackage.license -ne 'BSD-3-Clause') {
  throw 'Cargo metadata does not report libwebp-sys2 0.2.0 with BSD-3-Clause.'
}
$animationPackage = $packages | Where-Object { $_.name -eq 'webp-animation' -and $_.version -eq '0.10.0' } | Select-Object -First 1
if (-not $animationPackage -or $animationPackage.license -ne 'MIT OR Apache-2.0') {
  throw 'Cargo metadata does not report webp-animation 0.10.0 with MIT OR Apache-2.0.'
}

$tree = cargo tree --manifest-path src-tauri/Cargo.toml --locked -e features -i libwebp-sys2@0.2.0 | Out-String
if ($LASTEXITCODE -ne 0 -or $tree -notmatch 'libwebp-sys2 feature "static"' -or $tree -notmatch 'libwebp-sys2 feature "mux"' -or $tree -notmatch 'webp-animation') {
  throw 'The locked feature tree does not prove the audited static+mux libwebp path is active.'
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
  noticeAudit = $true
  staticFeatureTree = $true
  muxFeatureTree = $true
  unreviewedCandidateBackendsRejected = $true
  artifactSizes = [pscustomobject]$sizeReport
} | ConvertTo-Json -Depth 4
