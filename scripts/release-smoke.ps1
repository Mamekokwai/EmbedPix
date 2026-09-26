[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string]$Repository,
  [Parameter(Mandatory = $true)] [string]$Tag,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'EmbedPix release smoke' }
$release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repository/releases/tags/$Tag"
if ($release.draft -or $release.prerelease) { throw "Release $Tag is draft or prerelease." }

$version = $Tag.TrimStart('v')
$publicKeyPath = Join-Path ([IO.Path]::GetTempPath()) ("embedpix-updater-public-key-" + [guid]::NewGuid() + '.pub')
$expected = @(
  "EmbedPix_${version}_x64-setup.exe",
  "EmbedPix_${version}_x64-setup.exe.sig",
  "EmbedPix_${version}_arm64-setup.exe",
  "EmbedPix_${version}_arm64-setup.exe.sig",
  'latest.json', 'SHA256SUMS.txt', 'release-provenance.json'
)
$actual = @($release.assets | ForEach-Object name)
if ($actual.Count -ne $expected.Count -or @($expected | Where-Object { $actual -notcontains $_ }).Count -ne 0) {
  throw "Release assets do not match the expected seven-asset set: $($actual -join ', ')"
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("embedpix-release-smoke-" + [guid]::NewGuid())
$diagnosticRoot = if ($env:GITHUB_WORKSPACE) { Join-Path $env:GITHUB_WORKSPACE 'release-smoke-diagnostics' } else { Join-Path ([IO.Path]::GetTempPath()) 'embedpix-release-smoke-diagnostics' }
New-Item -ItemType Directory -Path $root | Out-Null
try {
  foreach ($asset in $release.assets) {
    Invoke-WebRequest -Headers $headers -Uri $asset.browser_download_url -OutFile (Join-Path $root $asset.name)
  }
  $latest = Get-Content -Raw (Join-Path $root 'latest.json') | ConvertFrom-Json
  if ($latest.version -ne $version) { throw 'latest.json version mismatch.' }
  $platforms = @($latest.platforms.PSObject.Properties.Name)
  if ($platforms.Count -ne 2 -or $platforms -notcontains 'windows-x86_64' -or $platforms -notcontains 'windows-aarch64') {
    throw 'latest.json platform set mismatch.'
  }
  foreach ($platform in $platforms) {
    $encoded = $latest.platforms.$platform.signature
    try { $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) } catch { throw "$platform signature is not valid base64." }
    $lines = @($decoded -split "\r?\n" | Where-Object { $_ -ne '' })
    $b64 = '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
    if ($lines.Count -lt 4 -or $lines[0] -notmatch '^untrusted comment: .+$' -or $lines[1] -notmatch $b64 -or $lines[2] -notmatch '^trusted comment: .+$' -or $lines[3] -notmatch $b64) {
      throw "$platform signature does not have a valid minisign structure."
    }
  }
  $provenance = Get-Content -Raw (Join-Path $root 'release-provenance.json') | ConvertFrom-Json
  if ($provenance.repository -ne $Repository -or $provenance.release_tag -ne $Tag -or
      $provenance.workflow_ref -ne "refs/tags/$Tag" -or
      $provenance.release_commit -notmatch '^[0-9a-fA-F]{40}$' -or
      $provenance.workflow_sha -notmatch '^[0-9a-fA-F]{40}$') {
    throw 'release-provenance.json does not match the published tag or immutable commit format.'
  }
  $checks = Get-Content (Join-Path $root 'SHA256SUMS.txt')
  $checkedNames = @()
  foreach ($line in $checks) {
    if ($line -notmatch '^([0-9a-fA-F]{64})\s+(.+)$') { throw "Invalid SHA256SUMS line: $line" }
    $assetName = $Matches[2]
    if ($checkedNames -contains $assetName -or -not ($expected -contains $assetName)) { throw "Unexpected or duplicate SHA256SUMS asset: $assetName" }
    $checkedNames += $assetName
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $root $assetName)).Hash
    if ($actualHash -ine $Matches[1]) { throw "SHA256 mismatch for $assetName." }
  }
  $checksumExpected = @($expected | Where-Object { $_ -ne 'SHA256SUMS.txt' })
  $checkedSet = (@($checkedNames | Sort-Object) -join ',')
  $expectedSet = (@($checksumExpected | Sort-Object) -join ',')
  if ($checkedSet -ne $expectedSet) {
    throw 'SHA256SUMS.txt does not cover the expected published assets.'
  }
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
