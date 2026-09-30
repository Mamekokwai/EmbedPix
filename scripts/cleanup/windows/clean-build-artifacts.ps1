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

function Assert-NoReparsePoints {
    param([Parameter(Mandatory)][string]$Path)

    $reparseAttribute = [IO.FileAttributes]::ReparsePoint
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($fullPath -ne $repoRoot -and -not $fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean path outside project root: $fullPath"
    }
    $current = $fullPath
    while ($true) {
        if (Test-Path -LiteralPath $current) {
            $ancestor = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if ($ancestor.Attributes -band $reparseAttribute) {
                throw "Refusing to clean reparse-point parent: $current; remove the link first so cleanup cannot recurse through it"
            }
        }
        if ($current -eq $repoRoot) {
            break
        }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) {
            throw "Refusing to clean path without project-root parent: $fullPath"
        }
        $current = $parent.FullName.TrimEnd('\')
    }

    $rootItem = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $items = @($rootItem)
    if ($rootItem.PSIsContainer) {
        $items += @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop |
                Where-Object { $_.Attributes -band $reparseAttribute })
    }

    foreach ($item in $items) {
        if (-not ($item.Attributes -band $reparseAttribute)) {
            continue
        }
        $resolvedPath = (Resolve-Path -LiteralPath $item.FullName -ErrorAction Stop).Path
        if (-not $resolvedPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to clean reparse point outside project root: $($item.FullName) -> $resolvedPath"
        }
        throw "Refusing to clean reparse point: $($item.FullName); remove the link first so cleanup cannot recurse through it"
    }
}

foreach ($target in $targets) {
    $path = [IO.Path]::GetFullPath((Join-Path $repoRoot $target.RelativePath))
    if (-not $path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        Write-Error "Refusing to clean path outside project root: $path"
        exit 1
    }

    try {
        Assert-NoReparsePoints -Path $path
    } catch {
        Write-Error $_.Exception.Message
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
