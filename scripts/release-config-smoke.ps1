[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing JSON configuration: $Path" }
  return Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json
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
$releaseNotesPath = "docs/release-notes-v$($package.version).md"
if (-not (Test-Path -LiteralPath $releaseNotesPath -PathType Leaf)) {
  throw "Missing release notes for source version $($package.version): $releaseNotesPath"
}
$releaseNotes = Get-Content -Raw -Encoding UTF8 -LiteralPath $releaseNotesPath
if ([string]::IsNullOrWhiteSpace($releaseNotes) -or $releaseNotes -notmatch "(?m)^# EmbedPix v$([regex]::Escape($package.version))\s*$") {
  throw "Release notes title does not match source version $($package.version): $releaseNotesPath"
}

if (-not $tauri.bundle.active -or -not $tauri.bundle.createUpdaterArtifacts -or $tauri.bundle.targets -ne 'nsis') {
  throw 'Tauri bundle must enable NSIS and updater artifacts.'
}
if (-not $tauri.plugins.updater.pubkey) { throw 'Tauri updater public key is missing.' }
$cleanupHelperPath = 'scripts/release-signing-preflight-cleanup.ps1'
$cleanupSmokePath = 'scripts/release-signing-preflight-cleanup-smoke.ps1'
$signingPreflightPath = 'scripts/release-signing-preflight.ps1'
foreach ($path in @('scripts/release-config-smoke.ps1', $cleanupHelperPath, $cleanupSmokePath, $signingPreflightPath)) {
  $bytes = [IO.File]::ReadAllBytes((Join-Path $repoRoot $path))
  if ($bytes.Length -lt 3 -or $bytes[0] -ne 0xEF -or $bytes[1] -ne 0xBB -or $bytes[2] -ne 0xBF) {
    throw "签名发布脚本必须使用 UTF-8 BOM，以兼容 Windows PowerShell 5.1：$path"
  }
}
if (-not $package.scripts.'check:release-signing-cleanup') {
  throw 'package.json is missing the signing cleanup smoke command.'
}
foreach ($path in @($cleanupHelperPath, $cleanupSmokePath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Signing cleanup contract is missing: $path" }
}
$cleanupHelper = Get-Content -Raw -Encoding UTF8 -LiteralPath $cleanupHelperPath
foreach ($required in @('Remove-ReleaseSigningProbeDirectory', 'MaxAttempts', 'Test-Path', '拒绝清理非签名预检创建的临时目录')) {
  if ($cleanupHelper -notmatch [regex]::Escape($required)) { throw "Signing cleanup helper is missing: $required" }
}
$cleanupSmoke = Get-Content -Raw -Encoding UTF8 -LiteralPath $cleanupSmokePath
foreach ($required in @('Remove-ReleaseSigningProbeDirectory', '-RemoveItem', '清理残留 smoke 未报告失败')) {
  if ($cleanupSmoke -notmatch [regex]::Escape($required)) { throw "Signing cleanup smoke is missing: $required" }
}
$signingPreflight = Get-Content -Raw -Encoding UTF8 -LiteralPath $signingPreflightPath
foreach ($required in @('ReportPath', 'trustedPublicKeyVerification', 'generatedAtUtc', '摘要已写入')) {
  if ($signingPreflight -notmatch [regex]::Escape($required)) { throw "Signing preflight report contract is missing: $required" }
}
$reportMatch = [regex]::Match($signingPreflight, '(?s)\$report\s*=\s*\[ordered\]@\{(?<body>.*?)\n\}')
if (-not $reportMatch.Success) { throw 'Signing preflight report object is missing.' }
$reportBody = $reportMatch.Groups['body'].Value
$reportFields = @([regex]::Matches($reportBody, '(?m)^\s{2}([A-Za-z][A-Za-z0-9]*)\s*=') | ForEach-Object { $_.Groups[1].Value })
$expectedReportFields = @('version', 'signingPreflight', 'trustedPublicKeyVerification', 'cleanup', 'generatedAtUtc')
if (($reportFields -join ',') -ne ($expectedReportFields -join ',')) {
  throw "Signing preflight report fields are not restricted to the safe contract: $($reportFields -join ', ')."
}
if ($reportBody -match '(?i)private|secret|password|probe|signature|TAURI_|env:') {
  throw 'Signing preflight report must not expose private material, probe paths, signatures, or environment values.'
}
if ($signingPreflight -notmatch '\[IO\.File\]::WriteAllText\([^\r\n]*\[Text\.UTF8Encoding\]::new\(\$false\)') {
  throw 'Signing preflight report must be written as UTF-8 without BOM.'
}
foreach ($required in @('reportPartPath', '[IO.File]::Replace', '[IO.File]::Move', '已有报告（如存在）已保留')) {
  if ($signingPreflight -notmatch [regex]::Escape($required)) { throw "Signing preflight report atomic write contract is missing: $required" }
}
$configKey = Decode-MinisignPublicKey $tauri.plugins.updater.pubkey 'tauri.conf.json updater pubkey'
$fileKey = Decode-MinisignPublicKey (Get-Content -Raw -Encoding UTF8 'src-tauri/update-public-key.txt') 'src-tauri/update-public-key.txt'
if ($configKey -ne $fileKey) { throw 'Tauri updater pubkey does not match src-tauri/update-public-key.txt.' }
$keyLines = @($configKey -split "\r?\n" | Where-Object { $_ -ne '' })
if ($keyLines.Count -ne 2 -or $keyLines[0] -notmatch '^untrusted comment: minisign public key: [A-F0-9]{16}$' -or $keyLines[1] -notmatch '^[A-Za-z0-9+/]+={0,2}$') {
  throw 'Trusted updater public key does not have the expected minisign structure.'
}

$mainSource = Get-Content -Raw -Encoding UTF8 'src-tauri/src/main.rs'
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

$releaseSmoke = Get-Content -Raw -Encoding UTF8 'scripts/release-smoke.ps1'
foreach ($required in @('embedpix-minisign-verifier', 'release-asset-contract.ps1', 'release-pe-contract.ps1', 'Assert-ReleaseAssetUrls', 'Assert-ReleaseAssetContract', 'Install')) {
  if ($releaseSmoke -notmatch [regex]::Escape($required)) { throw "Release smoke is missing: $required" }
}
$assetContract = Get-Content -Raw -Encoding UTF8 'scripts/release-asset-contract.ps1'
foreach ($required in @('latest.json', 'SHA256SUMS.txt', 'release-provenance.json', 'Get-ExpectedReleaseAssetNames', 'Assert-ReleaseChannel', 'Assert-ReleaseAssetUrls', 'Assert-ReleaseAssetContract', 'asset.size', 'pub_date', 'windows-x86_64', 'windows-aarch64')) {
  if ($assetContract -notmatch [regex]::Escape($required)) { throw "Release asset contract is missing: $required" }
}
$peContract = Get-Content -Raw -Encoding UTF8 'scripts/release-pe-contract.ps1'
foreach ($required in @('Assert-WindowsGuiSubsystem', 'peOffset -gt $bytes.Length - 0x60')) {
  if ($peContract -notmatch [regex]::Escape($required)) { throw "Release PE contract is missing: $required" }
}
if (-not (Test-Path -LiteralPath 'scripts/release-fixture-smoke.ps1' -PathType Leaf)) { throw 'Release fixture smoke is missing.' }
$fixtureSmoke = Get-Content -Raw -Encoding UTF8 'scripts/release-fixture-smoke.ps1'
foreach ($required in @('commands::update::tests::', 'Updater download and cache-cleanup tests failed', 'Windows console subsystem')) {
  if ($fixtureSmoke -notmatch [regex]::Escape($required)) { throw "Release fixture smoke is missing: $required" }
}
if (-not (Test-Path -LiteralPath 'scripts/release-dependency-smoke.ps1' -PathType Leaf)) { throw 'Release dependency smoke is missing.' }
$workflow = Get-Content -Raw -Encoding UTF8 '.github/workflows/prepare-release.yml'
foreach ($required in @('windows-x86_64', 'windows-aarch64', 'TAURI_SIGNING_PRIVATE_KEY', 'latest.json', 'overwrite_files: false', 'Run release dependency smoke', 'release-dependency-smoke.ps1 -InstallerPath', 'Run signing cleanup smoke', 'npm run check:release-signing-cleanup', 'Verify staged release contract before publish', 'Assert-ReleaseAssetContract -Release $release', 'WORKFLOW_REF: refs/tags/${{ needs.resolve.outputs.tag }}', 'Assert-WindowsGuiSubsystem $binary', 'Published latest.json version/platform count is invalid', 'Published latest.json platform mapping is invalid')) {
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
