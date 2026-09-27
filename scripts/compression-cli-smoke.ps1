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

  $imageEvent = Invoke-CliRequest $CliPath @{ id = 'image-smoke'; op = 'image'; inputPath = $pngInput; outputPath = $pngOutput; format = 'png' } 'image'
  $imageResult = Assert-Output $pngOutput 'png' 'image'
  $decodeOutput = Join-Path $script:root 'decoded-again.png'
  [void](Invoke-CliRequest $CliPath @{ id = 'decode-smoke'; op = 'image'; inputPath = $pngOutput; outputPath = $decodeOutput; format = 'png' } 'decode')
  $decodeResult = Assert-Output $decodeOutput 'png' 'decoded image'

  $gifEvent = Invoke-CliRequest $CliPath @{ id = 'gif-smoke'; op = 'gif'; outputPath = $gifOutput; width = 32; height = 32; loopMode = 'forever'; loopCount = 0; frames = @(@{ path = $pngInput; durationMs = 100 }, @{ path = $pngInput; durationMs = 100 }) } 'gif'
  $gifResult = Assert-Output $gifOutput 'gif' 'GIF'

  $report = [ordered]@{
    cli = (Resolve-Path -LiteralPath $CliPath).Path
    compressionCommand = if ($RequireCompression) { 'required' } else { ' 준비后可通过 -RequireCompression 启用' }
    outputs = @($imageResult, $decodeResult, $gifResult)
    decodeValidated = $true
    compressionCoreAvailable = $false
  }

  if ($RequireCompression) {
    $compressionOutput = Join-Path $script:root 'compressed.png'
    $compressionEvent = Invoke-CliRequest $CliPath @{ id = 'compression-smoke'; op = 'compress'; inputPath = $pngInput; outputPath = $compressionOutput; format = 'png'; preset = 'balanced' } 'compression'
    $compressionResult = Assert-Output $compressionOutput 'png' 'compressed image'
    $report.compressionCoreAvailable = $true
    $report.outputs += $compressionResult
  } else {
    Write-Warning 'Compression CLI operation is not enabled; pass -RequireCompression after the compress operation lands in embedpix-cli.'
  }

  $json = $report | ConvertTo-Json -Depth 8
  if ($ReportPath) { $json | Set-Content -LiteralPath $ReportPath -Encoding utf8NoBOM }
  Write-Output $json
} finally {
  Remove-Item -LiteralPath $script:root -Recurse -Force -ErrorAction SilentlyContinue
}
