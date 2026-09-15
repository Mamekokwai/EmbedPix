[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path.TrimEnd('\')
$allowedProcessNames = @(
    'node.exe', 'npm.exe', 'npx.exe', 'pnpm.exe', 'yarn.exe', 'bun.exe',
    'cargo.exe', 'rustc.exe', 'tauri.exe', 'vite.exe', 'embedpix.exe'
)

Write-Output "Project root: $repoRoot"
$candidates = @(
    Get-CimInstance Win32_Process | Where-Object {
        $name = [string]$_.Name
        $commandLine = [string]$_.CommandLine
        $allowedProcessNames -contains $name.ToLowerInvariant() -and
            $commandLine.IndexOf($repoRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $_.ProcessId -ne $PID
    } | Sort-Object ProcessId
)

if ($candidates.Count -eq 0) {
    Write-Output 'No project-scoped dev/build processes found.'
    exit 0
}

$failures = [System.Collections.Generic.List[string]]::new()
foreach ($candidate in $candidates) {
    $description = "{0} (PID {1})" -f $candidate.Name, $candidate.ProcessId
    Write-Output ("Found: {0}`n  {1}" -f $description, $candidate.CommandLine)
    if (-not $PSCmdlet.ShouldProcess($description, 'Stop')) {
        continue
    }

    try {
        Stop-Process -Id $candidate.ProcessId -Force -ErrorAction Stop
        Write-Output "Stopped: $description"
    } catch {
        $failures.Add("${description}: $($_.Exception.Message)")
    }
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    exit 1
}

exit 0
