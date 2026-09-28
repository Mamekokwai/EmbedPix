[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$assetContract = Join-Path $PSScriptRoot 'release-asset-contract.ps1'
$peContract = Join-Path $PSScriptRoot 'release-pe-contract.ps1'
if (-not (Test-Path -LiteralPath $assetContract -PathType Leaf)) { throw "Release asset contract is missing: $assetContract" }
if (-not (Test-Path -LiteralPath $peContract -PathType Leaf)) { throw "Release PE contract is missing: $peContract" }
. $assetContract
. $peContract

$repository = 'Mamekokwai/EmbedPix'
$version = (Get-Content -Raw (Join-Path (Split-Path -Parent $PSScriptRoot) 'package.json') | ConvertFrom-Json).version
if ([string]::IsNullOrWhiteSpace($version)) { throw 'Fixture version could not be read from package.json.' }
$tag = "v$version"
$root = Join-Path ([IO.Path]::GetTempPath()) ("embedpix-release-fixture-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null

function Expect-Rejection([string]$Label, [scriptblock]$Action) {
  try {
    & $Action
    throw "fixture accepted invalid case: $Label"
  } catch {
    if ($_.Exception.Message -like 'fixture accepted invalid case:*') { throw }
    Write-Host "[release-fixture] rejected $Label"
  }
}

try {
  $expected = @(Get-ExpectedReleaseAssetNames $version)
  $rawSignature = "untrusted comment: fixture`nAAAA`ntrusted comment: fixture`nAAAA"
  $encodedSignature = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($rawSignature))
  [IO.File]::WriteAllBytes((Join-Path $root "EmbedPix_${version}_x64-setup.exe"), [Text.Encoding]::UTF8.GetBytes('fixture-x64-installer'))
  [IO.File]::WriteAllBytes((Join-Path $root "EmbedPix_${version}_arm64-setup.exe"), [Text.Encoding]::UTF8.GetBytes('fixture-arm64-installer'))
  Set-Content -LiteralPath (Join-Path $root "EmbedPix_${version}_x64-setup.exe.sig") -Value $encodedSignature -NoNewline
  Set-Content -LiteralPath (Join-Path $root "EmbedPix_${version}_arm64-setup.exe.sig") -Value $encodedSignature -NoNewline

  $manifest = [ordered]@{
    version = $version
    notes = 'fixture'
    pub_date = (Get-Date).ToUniversalTime().ToString('o')
    platforms = [ordered]@{
      'windows-x86_64' = [ordered]@{
        signature = $encodedSignature
        url = "https://github.com/$repository/releases/download/$tag/EmbedPix_${version}_x64-setup.exe"
      }
      'windows-aarch64' = [ordered]@{
        signature = $encodedSignature
        url = "https://github.com/$repository/releases/download/$tag/EmbedPix_${version}_arm64-setup.exe"
      }
    }
  }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $root 'latest.json') -Encoding utf8NoBOM
  [ordered]@{
    repository = $repository
    release_tag = $tag
    release_commit = 'a'.PadRight(40, 'a')
    workflow_ref = "refs/tags/$tag"
    workflow_sha = 'b'.PadRight(40, 'b')
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'release-provenance.json') -Encoding utf8NoBOM
  $checksumNames = @($expected | Where-Object { $_ -ne 'SHA256SUMS.txt' })
  $checksumNames | Sort-Object | ForEach-Object {
    "$((Get-FileHash -LiteralPath (Join-Path $root $_) -Algorithm SHA256).Hash.ToLower())  $_"
  } | Set-Content -LiteralPath (Join-Path $root 'SHA256SUMS.txt') -Encoding utf8NoBOM

  $assets = @($expected | ForEach-Object {
    $name = $_
    [pscustomobject]@{
      name = $name
      browser_download_url = "https://github.com/$repository/releases/download/$tag/$name"
      size = (Get-Item -LiteralPath (Join-Path $root $name)).Length
    }
  })
  $release = [pscustomobject]@{ assets = $assets }
  Assert-ReleaseChannel -Release ([pscustomobject]@{ draft = $false; prerelease = $false }) -Tag $tag
  Assert-ReleaseChannel -Release ([pscustomobject]@{ draft = $false; prerelease = $true }) -Tag 'v0.7.0-rc.1'
  Expect-Rejection 'stable tag marked prerelease' { Assert-ReleaseChannel -Release ([pscustomobject]@{ draft = $false; prerelease = $true }) -Tag $tag }
  Expect-Rejection 'prerelease tag marked stable' { Assert-ReleaseChannel -Release ([pscustomobject]@{ draft = $false; prerelease = $false }) -Tag 'v0.7.0-rc.1' }
  Assert-ReleaseAssetContract -Release $release -Root $root -Repository $repository -Tag $tag | Out-Null
  Write-Host '[release-fixture] accepted valid manifest, asset set, signatures, URLs, pub_date, sizes, provenance, and checksums.'

  $originalDownloadUrl = $release.assets[0].browser_download_url
  $release.assets[0].browser_download_url = 'https://example.com/not-EmbedPix.exe'
  Expect-Rejection 'untrusted asset download URL' { Assert-ReleaseAssetUrls -Release $release -Repository $repository -Tag $tag }
  $release.assets[0].browser_download_url = $originalDownloadUrl

  $originalAssets = $release.assets
  $release.assets = @($originalAssets | Where-Object { $_.name -ne "EmbedPix_${version}_x64-setup.exe.sig" })
  Expect-Rejection 'missing installer signature asset' { Assert-ReleaseAssetContract -Release $release -Root $root -Repository $repository -Tag $tag | Out-Null }
  $release.assets = $originalAssets

  $originalManifest = Get-Content -Raw -LiteralPath (Join-Path $root 'latest.json')
  $invalidPlatformManifest = [ordered]@{
    version = $version
    notes = 'fixture'
    pub_date = (Get-Date).ToUniversalTime().ToString('o')
    platforms = [ordered]@{
      'windows-x86_64' = $manifest.platforms.'windows-x86_64'
      'windows-aarch64' = $manifest.platforms.'windows-aarch64'
      'unexpected' = $manifest.platforms.'windows-x86_64'
    }
  }
  $invalidPlatformManifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $root 'latest.json') -Encoding utf8NoBOM
  Expect-Rejection 'unexpected platform count' { Assert-ReleaseAssetContract -Release $release -Root $root -Repository $repository -Tag $tag | Out-Null }
  Set-Content -LiteralPath (Join-Path $root 'latest.json') -Value $originalManifest -NoNewline

  $wrongUrlManifest = $manifest | ConvertTo-Json -Depth 6 | ConvertFrom-Json
  $wrongUrlManifest.platforms.'windows-x86_64'.url = 'https://example.com/not-EmbedPix.exe'
  $wrongUrlManifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $root 'latest.json') -Encoding utf8NoBOM
  Expect-Rejection 'signature/url mismatch' { Assert-ReleaseAssetContract -Release $release -Root $root -Repository $repository -Tag $tag | Out-Null }
  Set-Content -LiteralPath (Join-Path $root 'latest.json') -Value $originalManifest -NoNewline

  $wrongSignatureManifest = $manifest | ConvertTo-Json -Depth 6 | ConvertFrom-Json
  $wrongSignatureManifest.platforms.'windows-x86_64'.signature = 'not-a-valid-signature'
  $wrongSignatureManifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $root 'latest.json') -Encoding utf8NoBOM
  Expect-Rejection 'signature mismatch' { Assert-ReleaseAssetContract -Release $release -Root $root -Repository $repository -Tag $tag | Out-Null }
  Set-Content -LiteralPath (Join-Path $root 'latest.json') -Value $originalManifest -NoNewline

  $futureManifest = $manifest | ConvertTo-Json -Depth 6 | ConvertFrom-Json
  $futureManifest.pub_date = (Get-Date).ToUniversalTime().AddHours(1).ToString('o')
  $futureManifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $root 'latest.json') -Encoding utf8NoBOM
  Expect-Rejection 'future pub_date' { Assert-ReleaseAssetContract -Release $release -Root $root -Repository $repository -Tag $tag | Out-Null }
  Set-Content -LiteralPath (Join-Path $root 'latest.json') -Value $originalManifest -NoNewline

  $originalSize = $release.assets[0].size
  $release.assets[0].size = $originalSize + 1
  Expect-Rejection 'asset size mismatch' { Assert-ReleaseAssetContract -Release $release -Root $root -Repository $repository -Tag $tag | Out-Null }
  $release.assets[0].size = $originalSize

  $validPe = New-Object byte[] 512
  $validPe[0] = 0x4d; $validPe[1] = 0x5a
  $validPe[0x3c] = 0x80
  $validPe[0x80] = 0x50; $validPe[0x81] = 0x45
  $validPe[0xdc] = 2
  $validPePath = Join-Path $root 'valid.exe'
  [IO.File]::WriteAllBytes($validPePath, $validPe)
  Assert-WindowsGuiSubsystem $validPePath

  $consolePe = [byte[]]$validPe.Clone()
  $consolePe[0xdc] = 3
  $consolePePath = Join-Path $root 'console.exe'
  [IO.File]::WriteAllBytes($consolePePath, $consolePe)
  Expect-Rejection 'Windows console subsystem' { Assert-WindowsGuiSubsystem $consolePePath }

  $overflowPe = New-Object byte[] 512
  $overflowPe[0] = 0x4d; $overflowPe[1] = 0x5a
  $overflowPe[0x3c] = 0x7f; $overflowPe[0x3d] = 0xff; $overflowPe[0x3e] = 0xff; $overflowPe[0x3f] = 0x7f
  $overflowPePath = Join-Path $root 'overflow.exe'
  [IO.File]::WriteAllBytes($overflowPePath, $overflowPe)
  Expect-Rejection 'out-of-range PE offset' { Assert-WindowsGuiSubsystem $overflowPePath }

  cargo test --manifest-path src-tauri/Cargo.toml --locked commands::update::tests::
  if ($LASTEXITCODE -ne 0) { throw 'Updater download and cache-cleanup tests failed.' }
  Write-Host '[release-fixture] updater interruption, resume, signature, and cache cleanup tests passed.'
  Write-Host '[release-fixture] all local release and PE boundary fixtures passed.'
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
