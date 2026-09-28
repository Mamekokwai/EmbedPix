function Assert-WindowsGuiSubsystem([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Installed executable is missing: $Path" }
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 0x100 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) { throw "Executable is not a Windows PE file: $Path" }
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
  if ($peOffset -lt 0 -or $peOffset -gt $bytes.Length - 0x60) { throw "Executable PE header is invalid: $Path" }
  if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or $bytes[$peOffset + 2] -ne 0 -or $bytes[$peOffset + 3] -ne 0) { throw "Executable PE signature is invalid: $Path" }
  $subsystem = [BitConverter]::ToUInt16($bytes, $peOffset + 0x5c)
  if ($subsystem -ne 2) { throw "Installed EmbedPix executable uses subsystem $subsystem; expected Windows GUI subsystem 2." }
  Write-Host "Verified Windows GUI subsystem for $Path."
}
