function Remove-ReleaseSigningProbeDirectory {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [int]$MaxAttempts = 3,
    [int]$DelayMilliseconds = 50,
    [scriptblock]$RemoveItem
  )

  if ($MaxAttempts -lt 1) {
    throw '签名预检临时目录清理重试次数无效。'
  }

  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
  $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
  $leaf = [IO.Path]::GetFileName($fullPath)
  $parent = [IO.Path]::GetDirectoryName($fullPath).TrimEnd('\', '/')
  if ($parent -ne $tempRoot -or $leaf -notmatch '^embedpix-signing-preflight-[0-9a-f]{32}$') {
    throw '拒绝清理非签名预检创建的临时目录。'
  }

  $lastError = $null
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    if (-not (Test-Path -LiteralPath $fullPath)) {
      return
    }
    try {
      if ($null -eq $RemoveItem) {
        Remove-Item -LiteralPath $fullPath -Recurse -Force -ErrorAction Stop
      } else {
        & $RemoveItem $fullPath
      }
    } catch {
      $lastError = $_.Exception
    }
    if (-not (Test-Path -LiteralPath $fullPath)) {
      return
    }
    if ($attempt -lt $MaxAttempts) {
      Start-Sleep -Milliseconds $DelayMilliseconds
    }
  }

  $detail = if ($null -ne $lastError) { $lastError.Message } else { '删除后目录仍然存在。' }
  throw "无法清理签名预检临时目录；已重试 $MaxAttempts 次：$detail"
}
