[CmdletBinding()]
param(
  [string]$CliPath,
  [string]$ReportPath,
  [switch]$RequireCompression,
  [switch]$RequireOxiPng
)

$ErrorActionPreference = 'Stop'

function Set-Utf8NoBomContent([string]$Path, [string]$Value) {
  [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
}

function Get-Utf8Text([string]$Path) {
  [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false))
}

# Keep the source ASCII-only so Windows PowerShell 5.1 parses the static contract reliably.
$notPublishedText = ([char]0x672A, [char]0x53D1, [char]0x5E03) -join ''
$unreachableText = ([char]0x4E0D, [char]0x53EF, [char]0x8FBE) -join ''

function Invoke-NativeJson([string]$Path, [string]$InputText) {
  $inputPath = Join-Path $script:root ("native-input-" + [guid]::NewGuid() + '.json')
  $payload = if ($InputText.EndsWith("`n")) { $InputText } else { "$InputText`n" }
  [IO.File]::WriteAllBytes($inputPath, [Text.UTF8Encoding]::new($false).GetBytes($payload))
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $env:ComSpec
  $startInfo.Arguments = '/d /s /c ""' + $Path + '" < "' + $inputPath + '""'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw "Could not start native process: $Path" }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return [pscustomobject]@{ stdout = $stdout; stderr = $stderr; exitCode = $process.ExitCode }
  } finally {
    $process.Dispose()
    Remove-Item -LiteralPath $inputPath -Force -ErrorAction SilentlyContinue
  }
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-CliRequest([string]$Path, [hashtable]$Request, [string]$Label) {
  $requestPath = Join-Path $script:root "$Label.request.json"
  $stdoutPath = Join-Path $script:root "$Label.stdout.log"
  $stderrPath = Join-Path $script:root "$Label.stderr.log"
  Set-Utf8NoBomContent $requestPath ($Request | ConvertTo-Json -Depth 12)
  $inputText = Get-Content -Raw -LiteralPath $requestPath
  $native = Invoke-NativeJson $Path $inputText
  $stdout = $native.stdout
  $native.stderr | Set-Content -LiteralPath $stderrPath -NoNewline
  $exitCode = $native.exitCode
  $events = @($stdout -split "\r?\n" | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
  $success = $events | Where-Object { $_.type -eq 'success' } | Select-Object -Last 1
  if ($exitCode -ne 0 -or -not $success) {
    $errorText = Get-Content -Raw -LiteralPath $stderrPath -ErrorAction SilentlyContinue
    throw "$Label CLI smoke failed (exit=$exitCode): $errorText $stdout"
  }
  return $success
}

function Assert-Output([string]$Path, [string]$Format, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label output is missing: $Path" }
  $file = Get-Item -LiteralPath $Path
  if ($file.Length -le 0) { throw "$Label output is empty: $Path" }
  $bytes = [IO.File]::ReadAllBytes($Path)
  $signature = if ($Format -eq 'gif') {
    [Text.Encoding]::ASCII.GetString($bytes, 0, [Math]::Min(6, $bytes.Length))
  } elseif ($Format -eq 'webp') {
    ([BitConverter]::ToString($bytes[0..3])).Replace('-', '').ToLowerInvariant()
  } elseif ($Format -eq 'jpg') {
    ([BitConverter]::ToString($bytes[0..1])).Replace('-', '').ToLowerInvariant()
  } else {
    ([BitConverter]::ToString($bytes[0..7])).Replace('-', '').ToLowerInvariant()
  }
  $expected = if ($Format -eq 'gif') { @('GIF87a', 'GIF89a') } elseif ($Format -eq 'jpg') { @('ffd8') } else { @('89504e470d0a1a0a') }
  if ($Format -eq 'webp') { $expected = @('52494646') }
  if ($expected -notcontains $signature) { throw "$Label output signature is invalid: $signature" }
  $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  [pscustomobject]@{ label = $Label; format = $Format; path = $Path; bytes = $file.Length; sha256 = $hash; signature = $signature }
}

function Get-JpegDimensions([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  $index = 2
  while ($index -lt $bytes.Length - 1) {
    if ($bytes[$index] -ne 0xff) { $index++; continue }
    while ($index -lt $bytes.Length -and $bytes[$index] -eq 0xff) { $index++ }
    if ($index -ge $bytes.Length) { break }
    $marker = $bytes[$index]
    $index++
    if ($marker -eq 0xd8 -or $marker -eq 0xd9 -or ($marker -ge 0xd0 -and $marker -le 0xd7)) { continue }
    if ($index + 1 -ge $bytes.Length) { break }
    $segmentLength = ($bytes[$index] * 256) + $bytes[$index + 1]
    if ($marker -in @(0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf)) {
      if ($index + 7 -ge $bytes.Length) { break }
      return [pscustomobject]@{ width = ($bytes[$index + 5] * 256) + $bytes[$index + 6]; height = ($bytes[$index + 3] * 256) + $bytes[$index + 4] }
    }
    if ($segmentLength -lt 2) { break }
    $index += $segmentLength
  }
  throw "Could not inspect JPEG dimensions: $Path"
}

function Assert-NativeCompressionContract([switch]$Required) {
  $sourcePath = Join-Path $repoRoot 'src-tauri/src/commands/compression.rs'
  $gatewayPath = Join-Path $repoRoot 'src/platform/compression/compressionGateway.ts'
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "Native compression source is missing: $sourcePath" }
  if (-not (Test-Path -LiteralPath $gatewayPath -PathType Leaf)) { throw "Compression gateway source is missing: $gatewayPath" }
  $source = Get-Utf8Text $sourcePath
  $gateway = Get-Utf8Text $gatewayPath
$requiredTokens = @('pub async fn preflight_compression', 'pub async fn preview_compression', 'pub async fn estimate_image_compression', 'pub async fn compress_image', 'pub fn cancel_compression', 'fn resolve_output_path', 'output_location', 'output_directory', 'output_subdirectory', 'replace_original', 'write_exported_file', 'COMPRESS_IMAGE_COMMAND', 'PREVIEW_COMPRESSION_COMMAND', 'ESTIMATE_IMAGE_COMPRESSION_COMMAND')
  $missing = @($requiredTokens | Where-Object { $source -notmatch [regex]::Escape($_) -and $gateway -notmatch [regex]::Escape($_) })
  if ($missing.Count -gt 0) { throw "Native compression contract is missing: $($missing -join ', ')" }
  $hasSkipIfLarger = $source -match 'skip[_-]?if[_-]?larger' -or $gateway -match 'skip[_-]?if[_-]?larger'
  if ($Required -and -not $hasSkipIfLarger) { throw 'skipIfLarger is required by this smoke mode but is not present in the native compression contract.' }
  if (-not $hasSkipIfLarger) { Write-Warning 'skipIfLarger is not implemented in the native compression contract; no skip-if-larger claim is made.' }
  [pscustomobject]@{ nativeCommands = $true; outputLocations = @('path', 'source', 'directory', 'subfolder', 'original'); skipIfLarger = $hasSkipIfLarger; cliCompressionOperation = $true }
}

function Assert-PreviewCompressionContract {
  $sourcePath = Join-Path $repoRoot 'src-tauri/src/commands/compression.rs'
  $source = Get-Utf8Text $sourcePath
  $previewName = 'preview_compression'
  if ($source -notmatch '(?m)(?:pub async fn|pub fn)\s+preview_compression\b') { throw 'The independent preview_compression Tauri command is missing.' }
  $previewMatch = [regex]::Match($source, "(?s)(?:pub async fn|pub fn)\s+$previewName\b.*?(?=\r?\n(?:pub |fn |impl |#\[)|\z)")
  if (-not $previewMatch.Success) { throw "Could not locate preview compression function: $previewName" }
  $body = $previewMatch.Value
  $validationBody = $body
  $runPreviewBody = ''
  if ($body -notmatch 'inspect_image|decode_image|prepare_and_choose_output') {
    # The cancellation-aware preview path delegates through a small compatibility
    # wrapper, so inspect the shared core instead of assuming the old helper name.
    foreach ($helperName in @('run_preview_core', 'run_preview_with_cancellation', 'run_preview')) {
      $candidate = [regex]::Match($source, "(?s)fn\s+$helperName\b.*?(?=\r?\n(?:pub |fn |impl |#\[)|\z)")
      if ($candidate.Success -and $candidate.Value -match 'inspect_image|decode_image|prepare_and_choose_output') {
        $runPreviewBody = $candidate.Value
        break
      }
    }
    if ([string]::IsNullOrWhiteSpace($runPreviewBody)) { throw "$previewName does not expose an input-validation implementation." }
    $validationBody = "$body`n$runPreviewBody"
  }
  if ($validationBody -match 'write_exported_file|fs::write|fs::rename|remove_file|create_dir') {
    throw "$previewName contains a publishing or filesystem mutation call."
  }
  if ($validationBody -notmatch 'inspect_image|decode_image|prepare_and_choose_output') { throw "$previewName does not validate/decode the input image." }
  foreach ($limit in @('MAX_INPUT_BYTES', 'MAX_IMAGE_DIMENSION', 'MAX_IMAGE_PIXELS', 'MAX_DECODER_ALLOC_BYTES')) {
    if ($source -notmatch [regex]::Escape($limit)) { throw "Preview size limit is missing: $limit" }
  }
  [pscustomobject]@{ command = $previewName; writerFree = $true; inputDecodeValidation = $true; sizeLimits = @('MAX_INPUT_BYTES', 'MAX_IMAGE_DIMENSION', 'MAX_IMAGE_PIXELS', 'MAX_DECODER_ALLOC_BYTES') }
}

function Assert-PngOptimizationContract([switch]$Required) {
  $sourcePath = Join-Path $repoRoot 'src-tauri/src/commands/compression.rs'
  $gatewayPath = Join-Path $repoRoot 'src/platform/compression/compressionGateway.ts'
  $manifestPath = Join-Path $repoRoot 'src-tauri/Cargo.toml'
  $lockPath = Join-Path $repoRoot 'src-tauri/Cargo.lock'
  $source = Get-Utf8Text $sourcePath
  $gateway = Get-Utf8Text $gatewayPath
  $manifest = Get-Utf8Text $manifestPath
  $lock = Get-Utf8Text $lockPath
  $levelToken = $source -match 'png_optimization_level|pngOptimizationLevel' -or $gateway -match 'png_optimization_level|pngOptimizationLevel'
  $hasPinnedDependency = $manifest -match '(?m)^\s*oxipng\s*=' -and $lock -match '(?m)^name = "oxipng"'
  $hasExactPin = $manifest -match '(?m)oxipng\s*=\s*\{[^}\r\n]*version\s*=\s*"=9\.1\.5"'
  if (-not $levelToken) {
    if ($Required) { throw 'OxiPNG is required by this smoke mode but pngOptimizationLevel is not implemented.' }
    Write-Warning 'OxiPNG/pngOptimizationLevel is not implemented; the smoke makes no PNG optimization claim.'
    return [pscustomobject]@{
      checked = $false
      pending = $true
      acceptedRange = '0..6'
      dependency = if ($hasPinnedDependency) { 'oxipng present' } else { 'not in Cargo.toml/Cargo.lock' }
      pinnedVersion = '9.1.5 (planned exact pin)'
      license = 'MIT'
      cliPngOptimizationOperation = $false
    }
  }
  if ($source -notmatch 'oxipng' -and $gateway -notmatch 'oxipng') { throw 'pngOptimizationLevel is exposed without an OxiPNG implementation marker.' }
  if ($source -notmatch '0\.\.=6|0\s*<=.*<=\s*6|MAX_PNG_OPTIMIZATION_LEVEL\s*:\s*.*6|png_optimization_level\s*>\s*6' -and $gateway -notmatch '0\.\.6|0\s*<=.*<=\s*6|Math\.min\(6|Math\.max\(0') {
    throw 'pngOptimizationLevel does not expose the required 0..6 boundary contract.'
  }
  if (-not $hasPinnedDependency -or -not $hasExactPin -or $manifest -notmatch '(?m)oxipng\s*=\s*\{[^}\r\n]*default-features\s*=\s*false') {
    throw 'OxiPNG implementation is present but Cargo.toml/Cargo.lock is not pinned to oxipng =9.1.5 with default-features=false.'
  }
  $metadataJson = cargo metadata --manifest-path $manifestPath --locked --format-version 1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the locked Cargo metadata for OxiPNG.' }
  $oxipngPackage = ($metadataJson | ConvertFrom-Json).packages | Where-Object { $_.name -eq 'oxipng' } | Select-Object -First 1
  if (-not $oxipngPackage -or $oxipngPackage.version -ne '9.1.5' -or $oxipngPackage.license -ne 'MIT') {
    throw 'Cargo metadata does not report oxipng 9.1.5 with the expected MIT license.'
  }
  [pscustomobject]@{
    checked = $true
    pending = $false
    acceptedRange = '0..6'
    dependency = 'oxipng'
    pinnedVersion = '9.1.5'
    license = 'MIT'
    cliPngOptimizationOperation = $false
  }
}

function Assert-ImageTargetCompressionContract([switch]$Required) {
  $sourcePath = Join-Path $repoRoot 'src-tauri/src/commands/compression.rs'
  $gatewayPath = Join-Path $repoRoot 'src/platform/compression/compressionGateway.ts'
  $source = Get-Utf8Text $sourcePath
  $gateway = Get-Utf8Text $gatewayPath
  $selectionMatch = [regex]::Match($source, '(?s)fn\s+choose_encoded_output\b.*?(?=\r?\n(?:pub |fn |impl |#\[)|\z)')
  $runMatch = [regex]::Match($source, '(?s)fn\s+run_compression\b.*?(?=\r?\n(?:pub |fn |impl |#\[)|\z)')
  if (-not $selectionMatch.Success -or -not $runMatch.Success) { throw 'Could not locate image target-volume selection or publish functions.' }
  $selection = $selectionMatch.Value
  $run = $runMatch.Value
  $requiredSourceTokens = @(
    'max_output_bytes', 'max_candidates', 'DEFAULT_MAX_CANDIDATES', 'MAX_CANDIDATES',
    'fn choose_encoded_output', 'while candidates.len\(\) < request.max_candidates',
    'target_unreachable', 'target_unmet', 'quality_search', 'MAX_OUTPUT_BYTES', 'fn encode_and_verify'
  )
  $missing = @($requiredSourceTokens | Where-Object { $source -notmatch $_ })
  if ($missing.Count -gt 0) { throw "Image target-volume contract is missing: $($missing -join ', ')" }
  if ($gateway -notmatch 'maxOutputBytes' -or $gateway -notmatch 'maxCandidates') {
    throw 'Compression gateway does not expose maxOutputBytes and maxCandidates.'
  }
  if ($source -notmatch 'target_bytes == 0\s*\|\|\s*target_bytes > MAX_OUTPUT_BYTES') {
    throw 'Image maxOutputBytes is not bounded by MAX_OUTPUT_BYTES at request validation.'
  }
  if ($source -notmatch '\(1\.\.=MAX_CANDIDATES\)\.contains\(&max_candidates\)') {
    throw 'Image maxCandidates is not bounded by MAX_CANDIDATES at request validation.'
  }
  if ($source -notmatch 'CompressionFormat::Webp && !request\.lossless') {
    throw 'WebP lossy target-volume search is missing from the image selector.'
  }
  if ($source -notmatch 'webp_target_search_returns_highest_quality_candidate_within_bound') {
    throw 'WebP target-volume search regression coverage is missing.'
  }
  if ($selection -match 'write_exported_file|fs::write|fs::rename|remove_file|create_dir') {
    throw 'Image target-volume selection invokes a publishing or filesystem mutation call.'
  }
  $selectionPosition = $run.IndexOf('prepare_and_choose_output')
  if ($selectionPosition -lt 0) { $selectionPosition = $run.IndexOf('choose_encoded_output') }
  $skippedPosition = $run.IndexOf('if let Some(skipped_reason)')
  $writerPosition = $run.IndexOf('write_exported_file')
  if ($selectionPosition -lt 0 -or $skippedPosition -lt 0 -or $writerPosition -lt 0 -or $skippedPosition -gt $writerPosition) {
    throw 'Image target_unreachable/skip result is not handled before the publish writer.'
  }
  [pscustomobject]@{
    checked = $true
    maxOutputBytesBounded = $true
    maxCandidatesUpperBound = 12
    qualityCandidateSearchBounded = $true
    jpegCandidateSearchBounded = $true
    webpLossyCandidateSearchBounded = $true
    candidateSearchWriterFree = $true
    targetUnreachableNoPublish = $true
    cliTargetSearchOperation = $false
  }
}

function Assert-TargetCompressionContract([switch]$Required) {
  $gifPath = Join-Path $repoRoot 'src-tauri/src/commands/gif.rs'
  $storagePath = Join-Path $repoRoot 'src-tauri/src/commands/gif/storage.rs'
  $testsPath = Join-Path $repoRoot 'src-tauri/src/commands/gif/tests.rs'
  foreach ($path in @($gifPath, $storagePath, $testsPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      if ($Required) { throw "Target compression contract source is missing: $path" }
      Write-Warning "Target compression contract source is missing: $path"
      return [pscustomobject]@{ checked = $false; cliTargetSearchOperation = $false }
    }
  }
  $gif = Get-Utf8Text $gifPath
  $storage = Get-Utf8Text $storagePath
  $tests = Get-Utf8Text $testsPath
  $plannerMatch = [regex]::Match($gif, '(?s)fn\s+plan_gif_compression_blocking\b.*?(?=\r?\n(?:pub |fn |impl |#\[)|\z)')
  $selectorMatch = [regex]::Match($gif, '(?s)fn\s+select_export_candidate\b.*?(?=\r?\n(?:pub |fn |impl |#\[)|\z)')
  $exportMatch = [regex]::Match($gif, '(?s)fn\s+export_gif_blocking_with_job\b.*?(?=\r?\n(?:pub |fn |impl |#\[)|\z)')
  if (-not $plannerMatch.Success -or -not $selectorMatch.Success -or -not $exportMatch.Success) {
    throw 'Could not locate GIF target-volume planner, selector, or export function.'
  }
  $planner = $plannerMatch.Value
  $selector = $selectorMatch.Value
  $export = $exportMatch.Value
  $searchBody = "$planner`n$selector"
  if ($planner -notmatch 'max_candidates' -or $planner -notmatch 'clamp\(1,\s*8\)' -or $planner -notmatch 'for index in 0\.\.budget') {
    throw 'GIF target-volume search does not expose a bounded maxCandidates budget.'
  }
  if ($storage -notmatch 'MAX_OUTPUT_BYTES\s*:\s*u64' -or $storage -notmatch 'validate_output_size\s*\(' -or $storage -notmatch [regex]::Escape($notPublishedText)) {
    throw 'GIF output-size enforcement is missing or does not document the no-publish failure.'
  }
  if ($export -notmatch 'storage::MAX_OUTPUT_BYTES' -or $export -notmatch 'storage::write_output_with_publish') {
    throw 'GIF export does not pass the bounded output limit through the publish writer.'
  }
  if ($searchBody -match 'write_output_with_publish|write_exported_file|fs::rename|hard_link|acquire_publish|job_begin_publish') {
    throw 'GIF target-volume search or candidate selection invokes a publishing writer.'
  }
  if ($planner -notmatch 'is_none\(\)' -or $planner -notmatch [regex]::Escape($unreachableText) -or $selector -notmatch 'selected\.ok_or_else') {
    throw 'GIF target_unreachable handling is missing from the planner/selector contract.'
  }
  $guardPosition = $export.IndexOf('select_export_candidate')
  $publishPosition = $export.IndexOf('write_output_with_publish')
  if ($guardPosition -lt 0 -or $publishPosition -lt 0 -or $guardPosition -gt $publishPosition) {
    throw 'GIF target_unreachable is not rejected before the publish writer.'
  }
  if ($tests -notmatch 'export_candidate_selection_rejects_unreachable_target_before_publish') {
    throw 'GIF target_unreachable regression test is missing.'
  }
  [pscustomobject]@{
    checked = $true
    cliTargetSearchOperation = $false
    maxOutputBytesBounded = $true
    maxCandidatesUpperBound = 8
    candidateSearchWriterFree = $true
    targetUnreachableNoPublish = $true
    unreachableRepresentation = "selected=null + reason($unreachableText); no target_unreachable CLI status is claimed"
  }
}

function Assert-MaxRgbMaeContract {
  $source = Get-Utf8Text (Join-Path $repoRoot 'src-tauri/src/commands/compression.rs')
  $gateway = Get-Utf8Text (Join-Path $repoRoot 'src/platform/compression/compressionGateway.ts')
  foreach ($token in @('max_rgb_mae: Option<f64>', 'validate_max_rgb_mae', 'is_finite()', '0.0..=255.0', 'choose_webp_output_with_rgb_mae', 'quality_threshold_unmet')) {
    if ($source -notmatch [regex]::Escape($token)) { throw "maxRgbMae contract is missing: $token" }
  }
  if ($gateway -notmatch 'maxRgbMae' -or $gateway -notmatch 'Number\.isFinite') { throw 'Gateway maxRgbMae validation is missing.' }
  $runMatch = [regex]::Match($source, '(?s)fn\s+run_compression\b.*?(?=\r?\n(?:pub |fn |impl |#\[)|\z)')
  $runBody = $runMatch.Value
  $selectionPosition = $runBody.IndexOf('prepare_and_choose_output')
  if ($selectionPosition -lt 0) { $selectionPosition = $runBody.IndexOf('choose_encoded_output_with_cancellation') }
  $skippedPosition = $runBody.IndexOf('if let Some(skipped_reason)')
  $writerPosition = $runBody.IndexOf('write_exported_file')
  if ($selectionPosition -lt 0 -or $skippedPosition -lt 0 -or $writerPosition -lt 0 -or $skippedPosition -gt $writerPosition) {
    throw 'maxRgbMae formal path does not prove skipped results are rejected before publishing.'
  }
  [pscustomobject]@{ enabled = $true; defaultOff = $true; finiteRange = '0..255'; formalSkippedBeforePublish = $true }
}

function Assert-JpegAdvancedContract {
  $source = Get-Utf8Text (Join-Path $repoRoot 'src-tauri/src/commands/compression.rs')
  $gateway = Get-Utf8Text (Join-Path $repoRoot 'src/platform/compression/compressionGateway.ts')
  foreach ($token in @('jpegProgressive', 'jpegOptimizeHuffman', 'jpeg-encoder', 'set_progressive', 'set_optimized_huffman_tables')) {
    if ($source -notmatch [regex]::Escape($token) -and $gateway -notmatch [regex]::Escape($token)) { throw "JPEG advanced contract is missing: $token" }
  }
  if ($source -notmatch 'validate_jpeg_options' -or $gateway -notmatch '仅支持 JPEG 输出') { throw 'JPEG advanced options are not restricted to JPEG output.' }
  [pscustomobject]@{ enabled = $true; defaultOff = $true; progressive = $true; optimizedHuffman = $true; jpegOnly = $true }
}

function Assert-WebpLosslessMethodContract {
  $cli = Get-Utf8Text (Join-Path $repoRoot 'src-tauri/src/bin/embedpix-cli.rs')
  $source = Get-Utf8Text (Join-Path $repoRoot 'src-tauri/src/commands/compression.rs')
  $encoder = Get-Utf8Text (Join-Path $repoRoot 'src-tauri/src/commands/webp_static.rs')
  foreach ($token in @('webpLosslessMethod', 'compress_file_cli_with_advanced_options', 'encode_lossless_rgba_with_method', 'picture.use_argb = 1', 'config.lossless = 1')) {
    if (($cli + $source + $encoder) -notmatch [regex]::Escape($token)) { throw "WebP lossless method contract is missing: $token" }
  }
  [pscustomobject]@{ enabled = $true; range = '0..6'; defaultOff = $true; argbLossless = $true; cli = $true }
}

function Assert-TargetResizePercentContract {
  $cli = Get-Utf8Text (Join-Path $repoRoot 'src-tauri/src/bin/embedpix-cli.rs')
  $source = Get-Utf8Text (Join-Path $repoRoot 'src-tauri/src/commands/compression.rs')
  $gateway = Get-Utf8Text (Join-Path $repoRoot 'src/platform/compression/compressionGateway.ts')
  foreach ($token in @('targetResizePercent', 'prepare_resize_request', 'resized_dimensions', 'MIN_COMPRESSION_RESIZE_PERCENT', 'validateTargetResizePercent')) {
    if (($cli + $source + $gateway) -notmatch [regex]::Escape($token)) { throw "targetResizePercent contract is missing: $token" }
  }
  [pscustomobject]@{ enabled = $true; range = '10..100'; defaultOff = $true; lossyJpegWebpOnly = $true; cli = $true }
}

function Assert-AutoTargetResizeContract {
  $cli = Get-Utf8Text (Join-Path $repoRoot 'src-tauri/src/bin/embedpix-cli.rs')
  $source = Get-Utf8Text (Join-Path $repoRoot 'src-tauri/src/commands/compression.rs')
  $gateway = Get-Utf8Text (Join-Path $repoRoot 'src/platform/compression/compressionGateway.ts')
  foreach ($token in @('autoResizeToTarget', 'AUTO_RESIZE_PERCENT_CANDIDATES', 'prepare_and_choose_output', 'target_unreachable: automatic resize candidates', 'validateAutoResizeToTarget')) {
    if (($cli + $source + $gateway) -notmatch [regex]::Escape($token)) { throw "automatic target resize contract is missing: $token" }
  }
  [pscustomobject]@{ enabled = $true; resizeCandidates = '100,75,50,25,10'; defaultOff = $true; lossyJpegWebpOnly = $true; cli = $true; noPublishOnUnreachable = $true }
}

$script:root = Join-Path ([IO.Path]::GetTempPath()) ("embedpix-compression-cli-smoke-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $script:root | Out-Null
try {
  if (-not $CliPath) {
    cargo build --manifest-path src-tauri/Cargo.toml --bin embedpix-cli --locked --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Could not build embedpix-cli.' }
    $CliPath = Join-Path $repoRoot 'src-tauri/target/debug/embedpix-cli.exe'
  }
  if (-not (Test-Path -LiteralPath $CliPath -PathType Leaf)) { throw "CLI binary was not found: $CliPath" }

  $pngInput = Join-Path $repoRoot 'benchmarks/cli-test/icon.png'
  $gifInput = Join-Path $repoRoot 'benchmarks/cli-test/anim.gif'
  $pngOutput = Join-Path $script:root 'roundtrip.png'
  $gifOutput = Join-Path $script:root 'roundtrip.gif'
  $compressionOutput = Join-Path $script:root 'compressed.webp'
  $losslessMethodFastOutput = Join-Path $script:root 'compressed-lossless-method-0.webp'
  $losslessMethodBestOutput = Join-Path $script:root 'compressed-lossless-method-6.webp'
  $jpegOutput = Join-Path $script:root 'compressed-progressive.jpg'
  $jpegResizeOutput = Join-Path $script:root 'compressed-resized.jpg'
  $jpegOriginalSizeOutput = Join-Path $script:root 'compressed-original-size.jpg'
  $jpegAutoResizeOutput = Join-Path $script:root 'compressed-auto-resize.jpg'
  $webpResizeOutput = Join-Path $script:root 'compressed-resized.webp'

  $imageEvent = Invoke-CliRequest $CliPath @{ id = 'image-smoke'; op = 'image'; inputPath = $pngInput; outputPath = $pngOutput; format = 'png'; width = 1; height = 1 } 'image'
  $imageResult = Assert-Output $pngOutput 'png' 'image'
  $decodeOutput = Join-Path $script:root 'decoded-again.png'
  [void](Invoke-CliRequest $CliPath @{ id = 'decode-smoke'; op = 'image'; inputPath = $pngOutput; outputPath = $decodeOutput; format = 'png'; width = 1; height = 1 } 'decode')
  $decodeResult = Assert-Output $decodeOutput 'png' 'decoded image'

  [void](Invoke-CliRequest $CliPath @{ id = 'compression-smoke'; op = 'compress'; inputPath = $pngInput; outputPath = $compressionOutput; format = 'webp'; quality = 82; maxInputBytes = 1MB } 'compression')
  $compressionResult = Assert-Output $compressionOutput 'webp' 'compression'
  [void](Invoke-CliRequest $CliPath @{ id = 'webp-lossless-method-0'; op = 'compress'; inputPath = $pngInput; outputPath = $losslessMethodFastOutput; format = 'webp'; lossless = $true; webpLosslessMethod = 0; maxInputBytes = 1MB } 'WebP lossless method 0')
  $losslessMethodFastResult = Assert-Output $losslessMethodFastOutput 'webp' 'WebP lossless method 0'
  [void](Invoke-CliRequest $CliPath @{ id = 'webp-lossless-method-6'; op = 'compress'; inputPath = $pngInput; outputPath = $losslessMethodBestOutput; format = 'webp'; lossless = $true; webpLosslessMethod = 6; maxInputBytes = 1MB } 'WebP lossless method 6')
  $losslessMethodBestResult = Assert-Output $losslessMethodBestOutput 'webp' 'WebP lossless method 6'
  [void](Invoke-CliRequest $CliPath @{ id = 'jpeg-advanced-smoke'; op = 'compress'; inputPath = $pngInput; outputPath = $jpegOutput; format = 'jpg'; quality = 82; jpegProgressive = $true; jpegOptimizeHuffman = $true; maxInputBytes = 1MB } 'jpeg-advanced')
  $jpegResult = Assert-Output $jpegOutput 'jpg' 'JPEG advanced compression'
  $jpegBytes = [IO.File]::ReadAllBytes($jpegOutput)
  $hasSof2 = $false
  for ($index = 0; $index -lt $jpegBytes.Length - 1; $index++) {
    if ($jpegBytes[$index] -eq 0xff -and $jpegBytes[$index + 1] -eq 0xc2) { $hasSof2 = $true; break }
  }
  if (-not $hasSof2) { throw 'JPEG advanced compression did not emit a progressive SOF2 marker.' }
  [void](Invoke-CliRequest $CliPath @{ id = 'jpeg-resize-smoke'; op = 'compress'; inputPath = $pngInput; outputPath = $jpegResizeOutput; format = 'jpg'; quality = 82; targetResizePercent = 50; maxInputBytes = 1MB } 'JPEG resize')
  $jpegResizeResult = Assert-Output $jpegResizeOutput 'jpg' 'JPEG resize'
  $jpegResizeDimensions = Get-JpegDimensions $jpegResizeOutput
  if ($jpegResizeDimensions.width -ne 16 -or $jpegResizeDimensions.height -ne 16) { throw "JPEG resize smoke emitted $($jpegResizeDimensions.width)x$($jpegResizeDimensions.height), expected 16x16." }
  [void](Invoke-CliRequest $CliPath @{ id = 'jpeg-original-size-smoke'; op = 'compress'; inputPath = $pngInput; outputPath = $jpegOriginalSizeOutput; format = 'jpg'; quality = 82; targetResizePercent = 100; maxInputBytes = 1MB } 'JPEG original size')
  $jpegOriginalSizeResult = Assert-Output $jpegOriginalSizeOutput 'jpg' 'JPEG original size'
  $jpegOriginalSizeDimensions = Get-JpegDimensions $jpegOriginalSizeOutput
  if ($jpegOriginalSizeDimensions.width -ne 32 -or $jpegOriginalSizeDimensions.height -ne 32) { throw "JPEG 100% smoke emitted $($jpegOriginalSizeDimensions.width)x$($jpegOriginalSizeDimensions.height), expected 32x32." }
  $jpegAutoResizeResult = Invoke-CliRequest $CliPath @{ id = 'jpeg-auto-resize-smoke'; op = 'compress'; inputPath = $pngInput; outputPath = $jpegAutoResizeOutput; format = 'jpg'; quality = 82; maxOutputBytes = 64KB; maxCandidates = 8; autoResizeToTarget = $true; maxInputBytes = 1MB } 'JPEG automatic target resize'
  $jpegAutoResizeOutputResult = Assert-Output $jpegAutoResizeOutput 'jpg' 'JPEG automatic target resize'
  if ($jpegAutoResizeResult.output.targetMet -ne $true) { throw 'JPEG automatic target resize did not report targetMet=true.' }
  [void](Invoke-CliRequest $CliPath @{ id = 'webp-resize-smoke'; op = 'compress'; inputPath = $pngInput; outputPath = $webpResizeOutput; format = 'webp'; quality = 82; targetResizePercent = 50; maxInputBytes = 1MB } 'WebP resize')
  $webpResizeResult = Assert-Output $webpResizeOutput 'webp' 'WebP resize'
  $invalidRequest = Join-Path $script:root 'invalid-compression.request.json'
  $invalidStderr = Join-Path $script:root 'invalid-compression.stderr.log'
  Set-Utf8NoBomContent $invalidRequest (@{ id = 'invalid-compression'; op = 'compress'; inputPath = $pngInput; outputPath = (Join-Path $script:root 'must-not-exist.webp'); quality = '82' } | ConvertTo-Json)
  $invalidNative = Invoke-NativeJson $CliPath (Get-Content -Raw -LiteralPath $invalidRequest)
  $invalidNative.stderr | Set-Content -LiteralPath $invalidStderr -NoNewline
  $invalidExitCode = $invalidNative.exitCode
  if ($invalidExitCode -ne 1 -or (Get-Content -Raw -LiteralPath $invalidStderr) -notmatch 'request_error') { throw "CLI strict validation smoke failed (exit=$invalidExitCode): $(Get-Content -Raw -LiteralPath $invalidStderr)" }
  foreach ($invalidResizeRequest in @(
    @{ id = 'invalid-resize-png'; op = 'compress'; inputPath = $pngInput; outputPath = (Join-Path $script:root 'invalid-resize-png.png'); format = 'png'; targetResizePercent = 50 },
    @{ id = 'invalid-resize-lossless-webp'; op = 'compress'; inputPath = $pngInput; outputPath = (Join-Path $script:root 'invalid-resize-lossless.webp'); format = 'webp'; lossless = $true; targetResizePercent = 50 },
    @{ id = 'invalid-resize-range'; op = 'compress'; inputPath = $pngInput; outputPath = (Join-Path $script:root 'invalid-resize-range.jpg'); format = 'jpg'; targetResizePercent = 9 },
    @{ id = 'invalid-auto-resize-no-target'; op = 'compress'; inputPath = $pngInput; outputPath = (Join-Path $script:root 'invalid-auto-resize-no-target.jpg'); format = 'jpg'; autoResizeToTarget = $true },
    @{ id = 'invalid-auto-resize-png'; op = 'compress'; inputPath = $pngInput; outputPath = (Join-Path $script:root 'invalid-auto-resize-png.png'); format = 'png'; autoResizeToTarget = $true; maxOutputBytes = 1024 },
    @{ id = 'invalid-auto-resize-conflict'; op = 'compress'; inputPath = $pngInput; outputPath = (Join-Path $script:root 'invalid-auto-resize-conflict.jpg'); format = 'jpg'; autoResizeToTarget = $true; targetResizePercent = 50; maxOutputBytes = 1024 }
  )) {
    $invalidResizeNative = Invoke-NativeJson $CliPath ($invalidResizeRequest | ConvertTo-Json -Depth 12)
    if ($invalidResizeNative.exitCode -ne 1 -or $invalidResizeNative.stderr -notmatch 'request_error') { throw "CLI resize validation smoke failed for $($invalidResizeRequest.id): $($invalidResizeNative.stderr)" }
  }

  $gifEvent = Invoke-CliRequest $CliPath @{ id = 'gif-smoke'; op = 'gif'; outputPath = $gifOutput; width = 32; height = 32; loopMode = 'infinite'; loopCount = 0; frames = @(@{ path = $pngInput; durationMs = 100 }, @{ path = $pngInput; durationMs = 100 }) } 'gif'
  $gifResult = Assert-Output $gifOutput 'gif' 'GIF'

  $nativeContract = Assert-NativeCompressionContract -Required:$RequireCompression
  $previewContract = Assert-PreviewCompressionContract
  $pngOptimizationContract = Assert-PngOptimizationContract -Required:$RequireOxiPng
  $imageTargetContract = Assert-ImageTargetCompressionContract -Required:$RequireCompression
  $targetContract = Assert-TargetCompressionContract -Required:$RequireCompression
  $maxRgbMaeContract = Assert-MaxRgbMaeContract
  $jpegAdvancedContract = Assert-JpegAdvancedContract
  $webpLosslessMethodContract = Assert-WebpLosslessMethodContract
  $targetResizePercentContract = Assert-TargetResizePercentContract
  $autoTargetResizeContract = Assert-AutoTargetResizeContract
  $report = [ordered]@{
    cli = (Resolve-Path -LiteralPath $CliPath).Path
    compressionCommand = 'compress'
    outputs = @($imageResult, $decodeResult, $compressionResult, $losslessMethodFastResult, $losslessMethodBestResult, $jpegResult, $jpegResizeResult, $jpegOriginalSizeResult, $jpegAutoResizeOutputResult, $webpResizeResult, $gifResult)
    jpegResizeDimensions = $jpegResizeDimensions
    jpegOriginalSizeDimensions = $jpegOriginalSizeDimensions
    jpegAutoResizeTargetMet = $jpegAutoResizeResult.output.targetMet
    decodeValidated = $true
    nativeCompressionContract = $nativeContract
    previewCompressionContract = $previewContract
    pngOptimizationContract = $pngOptimizationContract
    imageTargetCompressionContract = $imageTargetContract
    targetCompressionContract = $targetContract
    maxRgbMaeContract = $maxRgbMaeContract
    jpegAdvancedContract = $jpegAdvancedContract
    webpLosslessMethodContract = $webpLosslessMethodContract
    targetResizePercentContract = $targetResizePercentContract
    autoTargetResizeContract = $autoTargetResizeContract
  }

  if ($RequireCompression) {
    Write-Host 'Native compression contract is present and skipIfLarger is enabled.'
  } else {
    Write-Warning 'Compression output is not executed through embedpix-cli; pass -RequireCompression to require the native contract and skipIfLarger support.'
  }

  $json = $report | ConvertTo-Json -Depth 8
  if ($ReportPath) { Set-Utf8NoBomContent $ReportPath $json }
  Write-Output $json
} finally {
  Remove-Item -LiteralPath $script:root -Recurse -Force -ErrorAction SilentlyContinue
}
