[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing JSON configuration: $Path" }
  return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Decode-MinisignPublicKey([string]$Encoded, [string]$Label) {
  try {
    return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Encoded.Trim())).Trim()
  } catch {
    throw "$Label is not valid base64."
  }
}

$package = Read-JsonFile 'package.json'
$tauri = Read-JsonFile 'src-tauri/tauri.conf.json'
$cargoVersionLine = Select-String -Path 'src-tauri/Cargo.toml' -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
if (-not $cargoVersionLine) { throw 'src-tauri/Cargo.toml has no package version.' }
$cargoVersion = $cargoVersionLine.Matches[0].Groups[1].Value
if ($package.version -ne $cargoVersion -or $package.version -ne $tauri.version) {
  throw "Source version mismatch: package=$($package.version) cargo=$cargoVersion tauri=$($tauri.version)."
}

if (-not $tauri.bundle.active -or -not $tauri.bundle.createUpdaterArtifacts -or $tauri.bundle.targets -ne 'nsis') {
  throw 'Tauri bundle must enable NSIS and updater artifacts.'
}
if (-not $tauri.plugins.updater.pubkey) { throw 'Tauri updater public key is missing.' }
$configKey = Decode-MinisignPublicKey $tauri.plugins.updater.pubkey 'tauri.conf.json updater pubkey'
$fileKey = Decode-MinisignPublicKey (Get-Content -Raw 'src-tauri/update-public-key.txt') 'src-tauri/update-public-key.txt'
if ($configKey -ne $fileKey) { throw 'Tauri updater pubkey does not match src-tauri/update-public-key.txt.' }
$keyLines = @($configKey -split "\r?\n" | Where-Object { $_ -ne '' })
if ($keyLines.Count -ne 2 -or $keyLines[0] -notmatch '^untrusted comment: minisign public key: [A-F0-9]{16}$' -or $keyLines[1] -notmatch '^[A-Za-z0-9+/]+={0,2}$') {
  throw 'Trusted updater public key does not have the expected minisign structure.'
}

$mainSource = Get-Content -Raw 'src-tauri/src/main.rs'
foreach ($required in @(
  '#![cfg_attr(windows, windows_subsystem = "windows")]',
  'fn has_explicit_arguments',
  'fn prepare_cli_console',
  'AttachConsole',
  'AllocConsole'
)) {
  if ($mainSource -notmatch [regex]::Escape($required)) { throw "Windows console/subsystem contract is missing: $required" }
}
if (-not (Test-Path -LiteralPath 'src-tauri/src/bin/embedpix-cli.rs' -PathType Leaf)) {
  throw 'Dedicated embedpix-cli binary is missing; GUI executable must not become the CLI entry point.'
}

$releaseSmoke = Get-Content -Raw 'scripts/release-smoke.ps1'
foreach ($required in @('embedpix-minisign-verifier', 'release-asset-contract.ps1', 'release-pe-contract.ps1', 'Assert-ReleaseAssetContract', 'Install')) {
  if ($releaseSmoke -notmatch [regex]::Escape($required)) { throw "Release smoke is missing: $required" }
}
$assetContract = Get-Content -Raw 'scripts/release-asset-contract.ps1'
foreach ($required in @('latest.json', 'SHA256SUMS.txt', 'release-provenance.json', 'Get-ExpectedReleaseAssetNames', 'Assert-ReleaseAssetContract', 'asset.size', 'pub_date', 'windows-x86_64', 'windows-aarch64')) {
  if ($assetContract -notmatch [regex]::Escape($required)) { throw "Release asset contract is missing: $required" }
}
$peContract = Get-Content -Raw 'scripts/release-pe-contract.ps1'
foreach ($required in @('Assert-WindowsGuiSubsystem', 'peOffset -gt $bytes.Length - 0x60')) {
  if ($peContract -notmatch [regex]::Escape($required)) { throw "Release PE contract is missing: $required" }
}
if (-not (Test-Path -LiteralPath 'scripts/release-fixture-smoke.ps1' -PathType Leaf)) { throw 'Release fixture smoke is missing.' }
$workflow = Get-Content -Raw '.github/workflows/prepare-release.yml'
foreach ($required in @('windows-x86_64', 'windows-aarch64', 'TAURI_SIGNING_PRIVATE_KEY', 'latest.json', 'overwrite_files: false')) {
  if ($workflow -notmatch [regex]::Escape($required)) { throw "Release workflow is missing: $required" }
}

[pscustomobject]@{
  version = $package.version
  bundleTarget = $tauri.bundle.targets
  updaterArtifacts = $tauri.bundle.createUpdaterArtifacts
  trustedKeyMatches = $true
  guiSubsystemContract = $true
  releaseSmokeContract = $true
  workflowAssetContract = $true
} | ConvertTo-Json -Depth 4
