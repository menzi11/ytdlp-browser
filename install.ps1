# Build the native messaging launcher, write the host manifest, register registry keys.
# ASCII-only on purpose: Windows PowerShell 5.1 misparses UTF-8 scripts without a BOM
# when they contain non-ASCII text, so this file stays ASCII and README.md carries Chinese.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -ExtensionId <id>
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
param([switch]$Uninstall, [string]$ExtensionId)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$hostDir = Join-Path $root 'host'
$exe = Join-Path $hostDir 'ytdlp-host.exe'
$manifest = Join-Path $hostDir 'manifest.json'
$hostName = 'com.mengke.ytdlp'
$idFile = Join-Path $root 'tools\extension-id.txt'

# Chromium forks each read their own registry subtree; write all of them so the
# extension works in CentBrowser / Chrome / Edge without reinstalling.
$hives = @(
  'HKCU:\SOFTWARE\Google\Chrome\NativeMessagingHosts',
  'HKCU:\SOFTWARE\CentBrowser\NativeMessagingHosts',
  'HKCU:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts'
)

if ($Uninstall) {
  foreach ($h in $hives) {
    $k = Join-Path $h $hostName
    if (Test-Path $k) { Remove-Item $k -Recurse -Force; Write-Output "removed $k" }
  }
  if (Test-Path $manifest) { Remove-Item $manifest -Force; Write-Output "removed $manifest" }
  Write-Output 'done.'
  exit 0
}

# 1) Compile the launcher with the .NET Framework compiler that ships with Windows.
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found: $csc" }
& $csc /nologo /target:exe /codepage:65001 /optimize+ "/out:$exe" (Join-Path $hostDir 'launcher.cs')
if ($LASTEXITCODE -ne 0) { throw "compile failed with exit code $LASTEXITCODE" }
Write-Output "compiled: $exe"

# 2) Write the host manifest.
# CentBrowser 5.3 ignores manifest.key when loading unpacked extensions and derives
# its own ID, so allow both the pinned ID and the ID the browser actually assigned.
$ids = @()
if (Test-Path $idFile) { $ids += (Get-Content $idFile -Raw).Trim() }
if ($ExtensionId) { $ids += $ExtensionId.Trim() }
$ids = @($ids | Where-Object { $_ } | Select-Object -Unique)
if ($ids.Count -eq 0) { throw "no extension id: neither $idFile nor -ExtensionId" }
$origins = ($ids | ForEach-Object { "`"chrome-extension://$_/`"" }) -join ', '

$manifestJson = @"
{
  "name": "$hostName",
  "description": "yt-dlp downloader native host",
  "path": "$($exe -replace '\\', '\\\\')",
  "type": "stdio",
  "allowed_origins": [ $origins ]
}
"@
[System.IO.File]::WriteAllText($manifest, $manifestJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Output "manifest: $manifest"
Write-Output "allowed ids: $($ids -join ', ')"

# 3) Register every hive.
foreach ($h in $hives) {
  $k = Join-Path $h $hostName
  if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
  Set-ItemProperty -Path $k -Name '(default)' -Value $manifest
  Write-Output "registered: $k"
}

Write-Output ''
Write-Output 'Install complete. Next: open chrome://extensions, enable Developer mode,'
Write-Output "click 'Load unpacked' and pick: $root\extension"
