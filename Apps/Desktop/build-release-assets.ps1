[CmdletBinding()]
param(
    [switch]$NoBuild,
    [switch]$StopRunning,
    [switch]$PortableOnly
)

$ErrorActionPreference = 'Stop'

$desktop = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $desktop '..\..')).Path
$staged = Join-Path $desktop 'target\release'
$dist = Join-Path $desktop 'dist'

if (-not $NoBuild) {
    $arguments = @{}
    if ($StopRunning) { $arguments.StopRunning = $true }
    & (Join-Path $desktop 'build-release.ps1') @arguments
}

foreach ($name in 'opc-monitor.exe', 'opc_vcam_win.dll', 'OpenPocketCineDesktop.dll', 'FFmpeg-LICENSE.txt') {
    if (-not (Test-Path (Join-Path $staged $name))) {
        throw "$name is not in $staged - run build-release.ps1 first."
    }
}

$cargo = Get-Content (Join-Path $desktop 'Cargo.toml') -Raw
$version = if ($cargo -match '(?m)^version\s*=\s*"([^"]+)"') { $Matches[1] } else { throw 'No workspace version in Cargo.toml.' }
$assetName = "OpenPocketCine-$version-windows-x64"
$portableRoot = Join-Path $dist $assetName
$zip = Join-Path $dist "$assetName.zip"

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $portableRoot) { Remove-Item -LiteralPath $portableRoot -Recurse -Force }
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
New-Item -ItemType Directory -Path $portableRoot | Out-Null

Copy-Item (Join-Path $staged 'opc-monitor.exe') $portableRoot
Get-ChildItem $staged -Filter '*.dll' | Copy-Item -Destination $portableRoot
Copy-Item (Join-Path $staged 'FFmpeg-LICENSE.txt') $portableRoot
Copy-Item (Join-Path $desktop 'installer\viewfinder.ico') $portableRoot
foreach ($name in 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md') {
    Copy-Item (Join-Path $repo $name) $portableRoot
}

Compress-Archive -Path (Join-Path $portableRoot '*') -DestinationPath $zip -CompressionLevel Optimal

if (-not $PortableOnly) {
    & (Join-Path $desktop 'build-installer.ps1') -NoBuild
}

$assets = @(Get-Item $zip)
$installer = Join-Path $dist "OpenPocketCine-Setup-$version.exe"
if (Test-Path $installer) { $assets += Get-Item $installer }
$assets += @(Get-ChildItem $dist -File | Where-Object {
    $_.Name -match '^ffmpeg-.*-source\.zip$' -or $_.Name -eq 'FFmpeg-BUILD-PROVENANCE.md'
})
$assets = @($assets | Sort-Object Name -Unique)
$checksums = $assets | ForEach-Object {
    $hash = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLowerInvariant()
    "$hash  $($_.Name)"
}
Set-Content -Path (Join-Path $dist 'SHA256SUMS.txt') -Value $checksums -Encoding utf8

Write-Host 'Release assets:'
$assets.FullName
Write-Host (Join-Path $dist 'SHA256SUMS.txt')
