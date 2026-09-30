$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'release-signing-preflight-cleanup.ps1'
. $helper

function New-ProbePath {
  Join-Path ([IO.Path]::GetTempPath()) ("embedpix-signing-preflight-" + [guid]::NewGuid().ToString('N'))
}

$successPath = New-ProbePath
New-Item -ItemType Directory -Path $successPath -Force | Out-Null
Set-Content -LiteralPath (Join-Path $successPath 'probe.bin') -Value 'probe' -NoNewline
Remove-ReleaseSigningProbeDirectory -Path $successPath
if (Test-Path -LiteralPath $successPath) {
  throw '清理成功 smoke 未移除探针目录。'
}

$failurePath = New-ProbePath
New-Item -ItemType Directory -Path $failurePath -Force | Out-Null
$failure = $null
try {
  Remove-ReleaseSigningProbeDirectory -Path $failurePath -MaxAttempts 2 -DelayMilliseconds 1 -RemoveItem {
    param($ignoredPath)
  }
} catch {
  $failure = $_.Exception
}
if ($null -eq $failure -or $failure.Message -notmatch '无法清理签名预检临时目录' -or $failure.Message -notmatch [regex]::Escape($failurePath)) {
  throw '清理残留 smoke 未报告失败。'
}
if (-not (Test-Path -LiteralPath $failurePath)) {
  throw '清理残留 smoke 未保留残留目录供诊断。'
}
Remove-ReleaseSigningProbeDirectory -Path $failurePath

Write-Host '签名预检清理 smoke 通过：成功清理和残留失败判定均符合契约。'
