[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string]$Repository,
  [Parameter(Mandatory = $true)] [string]$Tag,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'EmbedPix release smoke' }
$githubToken = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } elseif ($env:GH_TOKEN) { $env:GH_TOKEN } else { $null }
if ($githubToken) { $headers.Authorization = "Bearer $githubToken" }

$assetContract = Join-Path $PSScriptRoot 'release-asset-contract.ps1'
$peContract = Join-Path $PSScriptRoot 'release-pe-contract.ps1'
if (-not (Test-Path -LiteralPath $assetContract -PathType Leaf)) { throw "Release asset contract is missing: $assetContract" }
if (-not (Test-Path -LiteralPath $peContract -PathType Leaf)) { throw "Release PE contract is missing: $peContract" }
. $assetContract
. $peContract

$configSmoke = Join-Path $PSScriptRoot 'release-config-smoke.ps1'
if (-not (Test-Path -LiteralPath $configSmoke -PathType Leaf)) { throw "Release config smoke is missing: $configSmoke" }
$global:LASTEXITCODE = 0
& $configSmoke
$configExitCode = $LASTEXITCODE
if ($null -ne $configExitCode -and $configExitCode -ne 0) { throw "Release configuration smoke failed with exit code $configExitCode." }

$release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repository/releases/tags/$Tag"
$version = $Tag.TrimStart('v')
Assert-ReleaseChannel -Release $release -Tag $Tag
Assert-ReleaseAssetUrls -Release $release -Repository $Repository -Tag $Tag
$publicKeyPath = Join-Path ([IO.Path]::GetTempPath()) ("embedpix-updater-public-key-" + [guid]::NewGuid() + '.pub')

$root = Join-Path ([IO.Path]::GetTempPath()) ("embedpix-release-smoke-" + [guid]::NewGuid())
$diagnosticRoot = if ($env:GITHUB_WORKSPACE) { Join-Path $env:GITHUB_WORKSPACE 'release-smoke-diagnostics' } else { Join-Path ([IO.Path]::GetTempPath()) 'embedpix-release-smoke-diagnostics' }
New-Item -ItemType Directory -Path $root | Out-Null
try {
  foreach ($asset in $release.assets) {
    Invoke-WebRequest -Headers $headers -Uri $asset.browser_download_url -OutFile (Join-Path $root $asset.name)
  }
  Assert-ReleaseAssetContract -Release $release -Root $root -Repository $Repository -Tag $Tag | Out-Null
  $decodedPublicKey = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((Get-Content -Raw 'src-tauri/update-public-key.txt').Trim()))
  [IO.File]::WriteAllText($publicKeyPath, $decodedPublicKey, (New-Object Text.UTF8Encoding($false)))
  cargo build --manifest-path tools/minisign-verifier/Cargo.toml --release --locked --quiet
  $verifierBase = Join-Path $PSScriptRoot '..\tools\minisign-verifier\target\release\embedpix-minisign-verifier'
  $verifier = @("$verifierBase.exe", $verifierBase) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not (Test-Path -LiteralPath $verifier)) { throw 'Independent minisign verifier was not built.' }
  foreach ($installerName in @("EmbedPix_${version}_x64-setup.exe", "EmbedPix_${version}_arm64-setup.exe")) {
    $signatureName = "$installerName.sig"
    $rawSignaturePath = Join-Path $root "$signatureName.raw"
    $rawSignature = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((Get-Content -Raw (Join-Path $root $signatureName)).Trim()))
    [IO.File]::WriteAllText($rawSignaturePath, $rawSignature, (New-Object Text.UTF8Encoding($false)))
    & $verifier $publicKeyPath (Join-Path $root $installerName) $rawSignaturePath
    if ($LASTEXITCODE -ne 0) { throw "Independent minisign verification failed for $installerName." }
  }
  Write-Host 'ARM64 coverage: asset download, SHA256, and minisign verification passed; native ARM64 install/startup is not executed on the x64 runner.'
  if ($SkipInstall) { Write-Host "Release asset smoke passed for $Tag (install skipped)."; exit 0 }
  if ($env:RUNNER_OS -ne 'Windows' -and $PSVersionTable.Platform -ne 'Win32NT') { throw 'Installer smoke requires Windows.' }
  $installer = Join-Path $root "EmbedPix_${version}_x64-setup.exe"
  $installerLog = Join-Path $root 'installer.log'
  $process = Start-Process -FilePath $installer -ArgumentList @('/S', "/LOG=$installerLog") -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "Installer exited with code $($process.ExitCode)." }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\EmbedPix\EmbedPix.exe'),
    (Join-Path $env:LOCALAPPDATA 'EmbedPix\EmbedPix.exe')
  ) | Where-Object { Test-Path -LiteralPath $_ }
  if (-not $candidates) { throw 'Installed EmbedPix executable was not found.' }
  $installedExecutable = $candidates | Select-Object -First 1
  Assert-WindowsGuiSubsystem $installedExecutable
  $app = Start-Process -FilePath $installedExecutable -PassThru
  Start-Sleep -Seconds 8
  [ordered]@{
    executable = $installedExecutable
    process_id = $app.Id
    exited = $app.HasExited
    exit_code = if ($app.HasExited) { $app.ExitCode } else { $null }
  } | ConvertTo-Json | Set-Content (Join-Path $root 'startup.json')
  if ($app.HasExited -and $app.ExitCode -ne 0) { throw "Installed application exited with code $($app.ExitCode)." }
  if (-not $app.HasExited) { Stop-Process -Id $app.Id -Force }
  $uninstaller = @(
    (Join-Path (Split-Path $installedExecutable) 'uninstall.exe'),
    (Join-Path $env:LOCALAPPDATA 'EmbedPix\uninstall.exe')
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $uninstaller) { throw 'Installed uninstaller was not found.' }
  $uninstallerLog = Join-Path $root 'uninstaller.log'
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "/LOG=$uninstallerLog") -PassThru -Wait
  if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with code $($uninstall.ExitCode)." }
  if (Test-Path -LiteralPath $installedExecutable) { throw 'Installer smoke left the application installed.' }
  Write-Host "Release download, verification, installation, and startup smoke passed for $Tag."
} catch {
  New-Item -ItemType Directory -Force -Path $diagnosticRoot | Out-Null
  $_ | Out-String | Set-Content (Join-Path $diagnosticRoot 'failure.txt')
  if (Test-Path -LiteralPath $root) {
    Copy-Item -LiteralPath $root -Destination (Join-Path $diagnosticRoot 'run') -Recurse -Force
  }
  throw
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $publicKeyPath -Force -ErrorAction SilentlyContinue
}
