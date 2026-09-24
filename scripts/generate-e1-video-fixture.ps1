param(
  [string]$OutputPath = ".tmp/e1-video.mp4",
  [int]$DurationSeconds = 2
)

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory) {
  New-Item -ItemType Directory -Force $outputDirectory | Out-Null
}

# Deterministic synthetic frames keep the E1 browser evidence small and reproducible.
ffmpeg -y -f lavfi -i "testsrc=size=160x120:rate=10" -t $DurationSeconds -pix_fmt yuv420p -movflags +faststart $OutputPath
Get-Item $OutputPath | Select-Object FullName, Length
