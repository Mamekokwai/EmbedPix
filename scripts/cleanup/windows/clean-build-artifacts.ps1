[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path.TrimEnd('\')
$rootPrefix = "$repoRoot\"
$targets = @(
    [pscustomobject]@{ Label = 'frontend dist'; RelativePath = 'dist' },
    [pscustomobject]@{ Label = 'Vite cache'; RelativePath = 'node_modules\.vite' },
    [pscustomobject]@{ Label = 'Tauri target'; RelativePath = 'src-tauri\target' }
)

foreach ($target in $targets) {
    $path = [IO.Path]::GetFullPath((Join-Path $repoRoot $target.RelativePath))
    if (-not $path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        Write-Error "Refusing to clean path outside project root: $path"
        exit 1
    }

    if (-not (Test-Path -LiteralPath $path)) {
        Write-Output "Skip: $($target.Label) is absent ($path)"
        continue
    }

    if ($PSCmdlet.ShouldProcess($path, "Remove $($target.Label)")) {
        try {
            Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
            Write-Output "Removed: $($target.Label) ($path)"
        } catch {
            Write-Error "Failed to remove $($target.Label): $($_.Exception.Message)"
            exit 1
        }
    }
}

exit 0
