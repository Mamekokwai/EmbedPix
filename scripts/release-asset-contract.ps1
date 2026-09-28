function Get-ExpectedReleaseAssetNames([string]$Version) {
  @(
    "EmbedPix_${Version}_x64-setup.exe",
    "EmbedPix_${Version}_x64-setup.exe.sig",
    "EmbedPix_${Version}_arm64-setup.exe",
    "EmbedPix_${Version}_arm64-setup.exe.sig",
    'latest.json', 'SHA256SUMS.txt', 'release-provenance.json'
  )
}

function Assert-ReleaseChannel {
  param(
    [Parameter(Mandatory = $true)] [object]$Release,
    [Parameter(Mandatory = $true)] [string]$Tag
  )

  if ($Release.draft) { throw "Release $Tag is draft." }
  $tagIsPrerelease = $Tag.TrimStart('v') -match '-'
  if ([bool]$Release.prerelease -ne $tagIsPrerelease) {
    throw "Release $Tag prerelease state does not match its version tag."
  }
}

function Assert-MinisignText([string]$Encoded, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Encoded)) { throw "$Label signature is empty." }
  try { $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Encoded.Trim())) } catch { throw "$Label signature is not valid base64." }
  $lines = @($decoded -split "\r?\n" | Where-Object { $_ -ne '' })
  $b64 = '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
  if ($lines.Count -lt 4 -or $lines[0] -notmatch '^untrusted comment: .+$' -or $lines[1] -notmatch $b64 -or $lines[2] -notmatch '^trusted comment: .+$' -or $lines[3] -notmatch $b64) {
    throw "$Label signature does not have a valid minisign structure."
  }
}

function Assert-ReleaseAssetContract {
  param(
    [Parameter(Mandatory = $true)] [object]$Release,
    [Parameter(Mandatory = $true)] [string]$Root,
    [Parameter(Mandatory = $true)] [string]$Repository,
    [Parameter(Mandatory = $true)] [string]$Tag
  )

  $version = $Tag.TrimStart('v')
  $expected = @(Get-ExpectedReleaseAssetNames $version)
  $actual = @($Release.assets | ForEach-Object name)
  if ($actual.Count -ne $expected.Count -or @($expected | Where-Object { $actual -notcontains $_ }).Count -ne 0) {
    throw "Release assets do not match the expected seven-asset set: $($actual -join ', ')"
  }
  foreach ($asset in @($Release.assets)) {
    $path = Join-Path $Root $asset.name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Downloaded release asset is missing: $($asset.name)" }
    $file = Get-Item -LiteralPath $path
    if ($null -eq $asset.size -or [uint64]$asset.size -ne [uint64]$file.Length) {
      throw "Downloaded release asset size mismatch for $($asset.name)."
    }
  }

  $latest = Get-Content -Raw (Join-Path $Root 'latest.json') | ConvertFrom-Json
  if ($latest.version -ne $version) { throw 'latest.json version mismatch.' }
  $manifestFields = @($latest.PSObject.Properties.Name)
  if ($manifestFields.Count -ne 4 -or $manifestFields -notcontains 'version' -or $manifestFields -notcontains 'notes' -or $manifestFields -notcontains 'pub_date' -or $manifestFields -notcontains 'platforms') {
    throw 'latest.json root schema is invalid.'
  }
  [DateTimeOffset]$pubDate = $latest.pub_date
  if ($pubDate -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) { throw 'latest.json pub_date is in the future.' }
  $platforms = @($latest.platforms.PSObject.Properties.Name)
  if ($platforms.Count -ne 2 -or $platforms -notcontains 'windows-x86_64' -or $platforms -notcontains 'windows-aarch64') {
    throw 'latest.json platform set mismatch.'
  }
  $expectedPlatformAssets = @{
    'windows-x86_64' = "EmbedPix_${version}_x64-setup.exe"
    'windows-aarch64' = "EmbedPix_${version}_arm64-setup.exe"
  }
  foreach ($platform in $platforms) {
    $platformFields = @($latest.platforms.$platform.PSObject.Properties.Name)
    if ($platformFields.Count -ne 2 -or $platformFields -notcontains 'signature' -or $platformFields -notcontains 'url') {
      throw "$platform manifest schema is invalid."
    }
    $encoded = $latest.platforms.$platform.signature
    $assetName = $expectedPlatformAssets[$platform]
    $expectedUrl = "https://github.com/$Repository/releases/download/$Tag/$assetName"
    if ($latest.platforms.$platform.url -ne $expectedUrl) { throw "$platform manifest URL does not match $expectedUrl." }
    $assetSignature = (Get-Content -Raw (Join-Path $Root "$assetName.sig")).Trim()
    if ($encoded.Trim() -ne $assetSignature) { throw "$platform manifest signature does not match $assetName.sig." }
    Assert-MinisignText $encoded $platform
  }

  $provenance = Get-Content -Raw (Join-Path $Root 'release-provenance.json') | ConvertFrom-Json
  if ($provenance.repository -ne $Repository -or $provenance.release_tag -ne $Tag -or
      $provenance.workflow_ref -ne "refs/tags/$Tag" -or
      $provenance.release_commit -notmatch '^[0-9a-fA-F]{40}$' -or
      $provenance.workflow_sha -notmatch '^[0-9a-fA-F]{40}$') {
    throw 'release-provenance.json does not match the published tag or immutable commit format.'
  }
  $checks = Get-Content (Join-Path $Root 'SHA256SUMS.txt')
  $checkedNames = @()
  foreach ($line in $checks) {
    if ($line -notmatch '^([0-9a-fA-F]{64})\s+(.+)$') { throw "Invalid SHA256SUMS line: $line" }
    $assetName = $Matches[2]
    if ($checkedNames -contains $assetName -or -not ($expected -contains $assetName)) { throw "Unexpected or duplicate SHA256SUMS asset: $assetName" }
    $checkedNames += $assetName
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Root $assetName)).Hash
    if ($actualHash -ine $Matches[1]) { throw "SHA256 mismatch for $assetName." }
  }
  $checksumExpected = @($expected | Where-Object { $_ -ne 'SHA256SUMS.txt' })
  if ((@($checkedNames | Sort-Object) -join ',') -ne (@($checksumExpected | Sort-Object) -join ',')) {
    throw 'SHA256SUMS.txt does not cover the expected published assets.'
  }

  [pscustomobject]@{ version = $version; assetCount = $actual.Count; platformCount = $platforms.Count }
}
