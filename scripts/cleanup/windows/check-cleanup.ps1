[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$scriptNames = @(
    'stop-project-processes.ps1',
    'clean-build-artifacts.ps1',
    'cleanup.ps1'
)
$failures = [System.Collections.Generic.List[string]]::new()
$stopContent = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'stop-project-processes.ps1') -Raw
$cleanContent = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'clean-build-artifacts.ps1') -Raw

if ($stopContent -notmatch 'embedpix\.exe') {
    $failures.Add('Windows process allowlist must include embedpix.exe')
}
foreach ($required in @('ReparsePoint', 'Resolve-Path', 'Refusing to clean reparse point')) {
    if ($cleanContent -notmatch [regex]::Escape($required)) {
        $failures.Add("Windows cleanup is missing reparse-point safety check: $required")
    }
}

foreach ($name in $scriptNames) {
    $path = Join-Path $PSScriptRoot $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        $failures.Add("Missing script: $path")
        continue
    }

    $content = Get-Content -LiteralPath $path -Raw
    if ($content -notmatch 'PSScriptRoot') {
        $failures.Add("Script does not resolve its own location: $path")
    }
    if ($content -match 'Stop-Process\s+-Name') {
        $failures.Add("Broad process-name stop found: $path")
    }
    if ($content -match 'Remove-Item[^\r\n]*node_modules') {
        $failures.Add("Whole node_modules removal found: $path")
    }
}

foreach ($name in @('stop-project-processes.sh', 'clean-build-artifacts.sh', 'cleanup.sh', 'check-cleanup.sh')) {
    $linuxPath = Join-Path $repoRoot "scripts\cleanup\linux\$name"
    if (-not (Test-Path -LiteralPath $linuxPath -PathType Leaf)) {
        $failures.Add("Missing paired Linux script: $linuxPath")
    }
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    exit 1
}

& (Join-Path $PSScriptRoot 'stop-project-processes.ps1') -WhatIf
if ($LASTEXITCODE -ne 0) { exit 1 }
& (Join-Path $PSScriptRoot 'clean-build-artifacts.ps1') -WhatIf
if ($LASTEXITCODE -ne 0) { exit 1 }
& (Join-Path $PSScriptRoot 'cleanup.ps1') -WhatIf
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Output 'Windows cleanup static and dry-run checks passed.'
exit 0
