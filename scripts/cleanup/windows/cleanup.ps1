[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param()

$ErrorActionPreference = 'Continue'
$stopScript = Join-Path $PSScriptRoot 'stop-project-processes.ps1'
$cleanScript = Join-Path $PSScriptRoot 'clean-build-artifacts.ps1'
$childArguments = @{}
if ($WhatIfPreference) {
    $childArguments['WhatIf'] = $true
}

& $stopScript @childArguments
$stopExitCode = $LASTEXITCODE
if ($stopExitCode -ne 0) {
    exit 1
}

& $cleanScript @childArguments
$cleanExitCode = $LASTEXITCODE

if ($cleanExitCode -ne 0) {
    exit 1
}

exit 0
