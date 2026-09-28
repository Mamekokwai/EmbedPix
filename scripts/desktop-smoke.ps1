[CmdletBinding()]
param(
  [string]$ReleaseTag,
  [string]$BundlePath,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-SmokeStep([string]$Name, [scriptblock]$Action) {
  Write-Host "[desktop-smoke] $Name"
  $global:LASTEXITCODE = 0
  & $Action
  $exitCode = $LASTEXITCODE
  if ($null -ne $exitCode -and $exitCode -ne 0) { throw "$Name failed with exit code $exitCode." }
}

if ($BundlePath) {
  if (-not (Test-Path -LiteralPath $BundlePath -PathType Leaf)) {
    throw "Tauri bundle was not found: $BundlePath"
  }
  Write-Host "[desktop-smoke] bundle exists: $BundlePath"
}

Invoke-SmokeStep 'release configuration and Windows GUI subsystem contract' {
  & (Join-Path $PSScriptRoot 'release-config-smoke.ps1')
}

Invoke-SmokeStep 'frontend contract and cleanup tests' {
  npm test -- --run
}

Invoke-SmokeStep 'GIF cancellation and spool cleanup tests' {
  cargo test --manifest-path src-tauri/Cargo.toml --locked commands::gif::tests::
}

Invoke-SmokeStep 'image export failure and rollback tests' {
  cargo test --manifest-path src-tauri/Cargo.toml --locked commands::export_image::tests::
}

if ($ReleaseTag) {
  $smokeArgs = @('-Repository', 'Mamekokwai/EmbedPix', '-Tag', $ReleaseTag)
  if ($SkipInstall) { $smokeArgs += '-SkipInstall' }
  Invoke-SmokeStep "published update asset smoke for $ReleaseTag" {
    & (Join-Path $PSScriptRoot 'release-smoke.ps1') @smokeArgs
  }
} else {
  Write-Host '[desktop-smoke] release asset smoke not requested; pass -ReleaseTag to verify latest.json, SHA256SUMS, signatures, install, startup, and uninstall.'
}

Write-Host '[desktop-smoke] all requested desktop smoke contracts passed.'
