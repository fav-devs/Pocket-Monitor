# Release assets for the Tauri app (Z4), in dist\tauri: the installer, a portable ZIP
# PocketMonitor-<version>-windows-x64.zip, the FFmpeg source zip and provenance when they
# are in dist\, and SHA256SUMS.txt over all of them. The LGPL FFmpeg gate runs in
# build-tauri-release.ps1. Parity with build-release-assets.ps1 (the old opc-monitor).
#
#   .\build-tauri-release-assets.ps1                    build, installer, ZIP, sums
#   .\build-tauri-release-assets.ps1 -NoBuild           package what target\pm-release holds
#   .\build-tauri-release-assets.ps1 -PortableOnly      no installer
#   .\build-tauri-release-assets.ps1 -FixedWebView2 C:\path\Microsoft.WebView2.FixedVersionRuntime.<v>.x64
#
# The portable ZIP needs the WebView2 runtime (Windows 11 ships it; Windows 10 gets it with
# Edge updates). Without it the app says so in a dialog and opens Microsoft's download page.
# -FixedWebView2 copies an unpacked Fixed Version runtime into the ZIP's WebView2\ folder
# (about 150 MB more); the app uses that folder when it is there.
[CmdletBinding()]
param(
    [switch]$NoBuild,
    [switch]$NoWeb,
    [switch]$StopRunning,
    [switch]$PortableOnly,
    [string]$FixedWebView2
)

$ErrorActionPreference = 'Stop'

$desktop = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $desktop '..\..')).Path
$staged = Join-Path $desktop 'target\pm-release'
$root = Join-Path $desktop 'dist'
$dist = Join-Path $root 'tauri'

if (-not $NoBuild) {
    $arguments = @{}
    if ($StopRunning) { $arguments.StopRunning = $true }
    if ($NoWeb) { $arguments.NoWeb = $true }
    & (Join-Path $desktop 'build-tauri-release.ps1') @arguments
}

foreach ($name in 'pocket-monitor.exe', 'opc_vcam_win.dll', 'OpenPocketCineDesktop.dll', 'FFmpeg-LICENSE.txt') {
    if (-not (Test-Path (Join-Path $staged $name))) {
        throw "$name is not in $staged - run build-tauri-release.ps1 first."
    }
}

$cargo = Get-Content (Join-Path $desktop 'Cargo.toml') -Raw
$version = if ($cargo -match '(?m)^version\s*=\s*"([^"]+)"') { $Matches[1] } else { throw 'No workspace version in Cargo.toml.' }
$assetName = "PocketMonitor-$version-windows-x64"
$portableRoot = Join-Path $dist $assetName
$zip = Join-Path $dist "$assetName.zip"

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $portableRoot) { Remove-Item -LiteralPath $portableRoot -Recurse -Force }
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
New-Item -ItemType Directory -Path $portableRoot | Out-Null

Copy-Item (Join-Path $staged 'pocket-monitor.exe') $portableRoot
Get-ChildItem $staged -Filter '*.dll' | Copy-Item -Destination $portableRoot
$ffmpegExe = Join-Path $staged 'ffmpeg.exe'
if (Test-Path $ffmpegExe) { Copy-Item $ffmpegExe $portableRoot }
Copy-Item (Join-Path $staged 'FFmpeg-LICENSE.txt') $portableRoot
Copy-Item (Join-Path $desktop 'installer\viewfinder.ico') $portableRoot
foreach ($name in 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md') {
    Copy-Item (Join-Path $repo $name) $portableRoot
}
if ($FixedWebView2) {
    if (-not (Test-Path (Join-Path $FixedWebView2 'msedgewebview2.exe'))) {
        throw "$FixedWebView2 is not an unpacked WebView2 Fixed Version runtime (no msedgewebview2.exe)."
    }
    Copy-Item $FixedWebView2 (Join-Path $portableRoot 'WebView2') -Recurse
}
Set-Content -Path (Join-Path $portableRoot 'README-portable.txt') -Encoding utf8 -Value @"
Pocket Monitor $version, portable

Run pocket-monitor.exe. Settings, logs and the LUT folder are in
%LOCALAPPDATA%\Pocket Monitor (shared with an installed copy; the first run copies an
older %LOCALAPPDATA%\OpenPocketCine across and leaves it in place); a portable copy in a
folder you can write to also logs beside itself (pocket-monitor.log).

Needs the Microsoft Edge WebView2 Runtime. Windows 11 has it. If Pocket Monitor says it
is missing, install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 or use the
installer, which installs it for you. A WebView2 folder beside the exe (a Fixed Version
runtime) is used instead when present.

The virtual camera device needs the installer (or Output > Install inside the app),
which registers opc_vcam_win.dll.
"@

Compress-Archive -Path (Join-Path $portableRoot '*') -DestinationPath $zip -CompressionLevel Optimal

if (-not $PortableOnly) {
    & (Join-Path $desktop 'build-tauri-installer.ps1') -NoBuild
}

$assets = @(Get-Item $zip)
$installer = Join-Path $dist "PocketMonitor-Setup-$version.exe"
if (-not $PortableOnly -and (Test-Path $installer)) { $assets += Get-Item $installer }
# The FFmpeg source and provenance an LGPL release carries, from dist\ or dist\tauri.
foreach ($folder in $root, $dist) {
    Get-ChildItem $folder -File -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -match '^ffmpeg-.*-source\.zip$' -or $_.Name -eq 'FFmpeg-BUILD-PROVENANCE.md'
    } | ForEach-Object {
        if ($_.DirectoryName -ne $dist) { Copy-Item $_.FullName $dist -Force }
        $assets += Get-Item (Join-Path $dist $_.Name)
    }
}
$assets = @($assets | Sort-Object Name -Unique)
$checksums = $assets | ForEach-Object {
    $hash = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLowerInvariant()
    "$hash  $($_.Name)"
}
Set-Content -Path (Join-Path $dist 'SHA256SUMS.txt') -Value $checksums -Encoding utf8

Write-Host 'Release assets:'
$assets.FullName
Write-Host (Join-Path $dist 'SHA256SUMS.txt')
