[CmdletBinding()]
param(
  [string]$CliPath,
  [string]$ReportPath,
  [switch]$RequireCompression
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-CliRequest([string]$Path, [hashtable]$Request, [string]$Label) {
  $requestPath = Join-Path $script:root "$Label.request.json"
  $stdoutPath = Join-Path $script:root "$Label.stdout.log"
  $stderrPath = Join-Path $script:root "$Label.stderr.log"
  $Request | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $requestPath -Encoding utf8NoBOM
  $inputText = Get-Content -Raw -LiteralPath $requestPath
  $stdout = $inputText | & $Path 2> $stderrPath | Out-String
  $exitCode = $LASTEXITCODE
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
  } else {
    ([BitConverter]::ToString($bytes[0..7])).Replace('-', '').ToLowerInvariant()
  }
  $expected = if ($Format -eq 'gif') { @('GIF87a', 'GIF89a') } else { @('89504e470d0a1a0a') }
  if ($expected -notcontains $signature) { throw "$Label output signature is invalid: $signature" }
  $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  [pscustomobject]@{ label = $Label; format = $Format; path = $Path; bytes = $file.Length; sha256 = $hash; signature = $signature }
}

function Assert-NativeCompressionContract([switch]$Required) {
  $sourcePath = Join-Path $repoRoot 'src-tauri/src/commands/compression.rs'
  $gatewayPath = Join-Path $repoRoot 'src/platform/compression/compressionGateway.ts'
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "Native compression source is missing: $sourcePath" }
  if (-not (Test-Path -LiteralPath $gatewayPath -PathType Leaf)) { throw "Compression gateway source is missing: $gatewayPath" }
  $source = Get-Content -Raw -LiteralPath $sourcePath
  $gateway = Get-Content -Raw -LiteralPath $gatewayPath
  $requiredTokens = @('pub async fn preflight_compression', 'pub async fn compress_image', 'pub fn cancel_compression', 'fn resolve_output_path', 'output_location', 'output_directory', 'output_subdirectory', 'replace_original', 'write_exported_file', 'COMPRESS_IMAGE_COMMAND')
  $missing = @($requiredTokens | Where-Object { $source -notmatch [regex]::Escape($_) -and $gateway -notmatch [regex]::Escape($_) })
  if ($missing.Count -gt 0) { throw "Native compression contract is missing: $($missing -join ', ')" }
  $hasSkipIfLarger = $source -match 'skip[_-]?if[_-]?larger' -or $gateway -match 'skip[_-]?if[_-]?larger'
  if ($Required -and -not $hasSkipIfLarger) { throw 'skipIfLarger is required by this smoke mode but is not present in the native compression contract.' }
  if (-not $hasSkipIfLarger) { Write-Warning 'skipIfLarger is not implemented in the native compression contract; no skip-if-larger claim is made.' }
  [pscustomobject]@{ nativeCommands = $true; outputLocations = @('path', 'source', 'directory', 'subfolder', 'original'); skipIfLarger = $hasSkipIfLarger; cliCompressionOperation = $false }
}

function Assert-PreviewCompressionContract {
  $sourcePath = Join-Path $repoRoot 'src-tauri/src/commands/compression.rs'
  $source = Get-Content -Raw -LiteralPath $sourcePath
  $previewName = if ($source -match '(?m)\bpreview_compression\b') { 'preview_compression' } else { 'preflight_compression' }
  $previewMatch = [regex]::Match($source, "(?s)(?:pub async fn|pub fn)\s+$previewName\b.*?(?=\r?\n(?:pub |fn |impl |#\[)|\z)")
  if (-not $previewMatch.Success) { throw "Could not locate preview compression function: $previewName" }
  $body = $previewMatch.Value
  $validationBody = $body
  $runPreviewBody = ''
  if ($body -notmatch 'inspect_image|decode_image') {
    $runPreviewMatch = [regex]::Match($source, '(?s)fn\s+run_preview\b.*?(?=\r?\n(?:pub |fn |impl |#\[)|\z)')
    if (-not $runPreviewMatch.Success) { throw "$previewName does not expose an input-validation implementation." }
    $runPreviewBody = $runPreviewMatch.Value
    $validationBody = "$body`n$runPreviewBody"
  }
  if ($validationBody -match 'write_exported_file|fs::write|fs::rename|remove_file|create_dir') {
    throw "$previewName contains a publishing or filesystem mutation call."
  }
  if ($validationBody -notmatch 'inspect_image|decode_image') { throw "$previewName does not validate/decode the input image." }
  foreach ($limit in @('MAX_INPUT_BYTES', 'MAX_IMAGE_DIMENSION', 'MAX_IMAGE_PIXELS', 'MAX_DECODER_ALLOC_BYTES')) {
    if ($source -notmatch [regex]::Escape($limit)) { throw "Preview size limit is missing: $limit" }
  }
  [pscustomobject]@{ command = $previewName; writerFree = $true; inputDecodeValidation = $true; sizeLimits = @('MAX_INPUT_BYTES', 'MAX_IMAGE_DIMENSION', 'MAX_IMAGE_PIXELS', 'MAX_DECODER_ALLOC_BYTES') }
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
  $gif = Get-Content -Raw -LiteralPath $gifPath
  $storage = Get-Content -Raw -LiteralPath $storagePath
  $tests = Get-Content -Raw -LiteralPath $testsPath
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
  if ($storage -notmatch 'MAX_OUTPUT_BYTES\s*:\s*u64' -or $storage -notmatch 'validate_output_size\s*\(' -or $storage -notmatch '未发布') {
    throw 'GIF output-size enforcement is missing or does not document the no-publish failure.'
  }
  if ($export -notmatch 'storage::MAX_OUTPUT_BYTES' -or $export -notmatch 'storage::write_output_with_publish') {
    throw 'GIF export does not pass the bounded output limit through the publish writer.'
  }
  if ($searchBody -match 'write_output_with_publish|write_exported_file|fs::rename|hard_link|acquire_publish|job_begin_publish') {
    throw 'GIF target-volume search or candidate selection invokes a publishing writer.'
  }
  if ($planner -notmatch 'is_none\(\)' -or $planner -notmatch '不可达' -or $selector -notmatch 'selected\.ok_or_else') {
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
    unreachableRepresentation = 'selected=null + reason(不可达); no target_unreachable CLI status is claimed'
  }
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

  $imageEvent = Invoke-CliRequest $CliPath @{ id = 'image-smoke'; op = 'image'; inputPath = $pngInput; outputPath = $pngOutput; format = 'png'; width = 1; height = 1 } 'image'
  $imageResult = Assert-Output $pngOutput 'png' 'image'
  $decodeOutput = Join-Path $script:root 'decoded-again.png'
  [void](Invoke-CliRequest $CliPath @{ id = 'decode-smoke'; op = 'image'; inputPath = $pngOutput; outputPath = $decodeOutput; format = 'png'; width = 1; height = 1 } 'decode')
  $decodeResult = Assert-Output $decodeOutput 'png' 'decoded image'

  $gifEvent = Invoke-CliRequest $CliPath @{ id = 'gif-smoke'; op = 'gif'; outputPath = $gifOutput; width = 32; height = 32; loopMode = 'infinite'; loopCount = 0; frames = @(@{ path = $pngInput; durationMs = 100 }, @{ path = $pngInput; durationMs = 100 }) } 'gif'
  $gifResult = Assert-Output $gifOutput 'gif' 'GIF'

  $nativeContract = Assert-NativeCompressionContract -Required:$RequireCompression
  $previewContract = Assert-PreviewCompressionContract
  $targetContract = Assert-TargetCompressionContract -Required:$RequireCompression
  $report = [ordered]@{
    cli = (Resolve-Path -LiteralPath $CliPath).Path
    compressionCommand = 'not exposed by embedpix-cli; native Tauri contract checked separately'
    outputs = @($imageResult, $decodeResult, $gifResult)
    decodeValidated = $true
    nativeCompressionContract = $nativeContract
    previewCompressionContract = $previewContract
    targetCompressionContract = $targetContract
  }

  if ($RequireCompression) {
    Write-Host 'Native compression contract is present and skipIfLarger is enabled.'
  } else {
    Write-Warning 'Compression output is not executed through embedpix-cli; pass -RequireCompression to require the native contract and skipIfLarger support.'
  }

  $json = $report | ConvertTo-Json -Depth 8
  if ($ReportPath) { $json | Set-Content -LiteralPath $ReportPath -Encoding utf8NoBOM }
  Write-Output $json
} finally {
  Remove-Item -LiteralPath $script:root -Recurse -Force -ErrorAction SilentlyContinue
}
