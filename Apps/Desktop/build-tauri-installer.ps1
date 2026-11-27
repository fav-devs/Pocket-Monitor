# Wraps target\pm-release (build-tauri-release.ps1) in the Pocket Monitor installer:
# dist\tauri\PocketMonitor-Setup-<version>.exe, Inno Setup 6, installer\PocketMonitor.iss.
# It upgrades an existing opc-monitor install in place (same AppId and folder), registers
# the virtual camera, and installs the WebView2 runtime when the PC lacks it (Z3, R8, R12).
#
#   .\build-tauri-installer.ps1                       build, then package
#   .\build-tauri-installer.ps1 -NoBuild              package what target\pm-release holds
#   .\build-tauri-installer.ps1 -WebView2Bootstrapper C:\path\MicrosoftEdgeWebview2Setup.exe
#
# Without -WebView2Bootstrapper the Evergreen bootstrapper is downloaded once from Microsoft
# into installer\MicrosoftEdgeWebview2Setup.exe (not committed) and reused after that.
[CmdletBinding()]
param(
    [switch]$NoBuild,
    [switch]$NoWeb,
    [switch]$StopRunning,
    [string]$WebView2Bootstrapper
)

$ErrorActionPreference = 'Stop'

$desktop = $PSScriptRoot
$staged = Join-Path $desktop 'target\pm-release'
$dist = Join-Path $desktop 'dist\tauri'
$installer = Join-Path $desktop 'installer'

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

# The Evergreen WebView2 bootstrapper (R8).
if (-not $WebView2Bootstrapper) {
    $WebView2Bootstrapper = Join-Path $installer 'MicrosoftEdgeWebview2Setup.exe'
    if (-not (Test-Path $WebView2Bootstrapper)) {
        Write-Host 'Downloading the WebView2 Evergreen bootstrapper…'
        Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $WebView2Bootstrapper -UseBasicParsing
    }
}
if (-not (Test-Path $WebView2Bootstrapper)) { throw "No WebView2 bootstrapper at $WebView2Bootstrapper." }
$signature = Get-AuthenticodeSignature $WebView2Bootstrapper
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft') {
    throw "$WebView2Bootstrapper is not a Microsoft-signed file."
}

# Inno Setup 6: the compiler is ISCC.exe. `winget install JRSoftware.InnoSetup` puts it
# in Program Files (x86).
$iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
if (-not $iscc) {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
    )
    $iscc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $iscc) {
    throw 'Inno Setup 6 is not installed. Run: winget install JRSoftware.InnoSetup'
}

$cargo = Get-Content (Join-Path $desktop 'Cargo.toml') -Raw
$version = if ($cargo -match '(?m)^version\s*=\s*"([^"]+)"') { $Matches[1] } else { '0.0.0' }

New-Item -ItemType Directory -Force -Path $dist | Out-Null
& $iscc "/DStaged=$staged" "/DAppVersion=$version" "/DOutDir=$dist" "/DWebView2Bootstrapper=$((Resolve-Path $WebView2Bootstrapper).Path)" (Join-Path $installer 'PocketMonitor.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup failed.' }

Write-Host "Built $(Join-Path $dist "PocketMonitor-Setup-$version.exe")"
