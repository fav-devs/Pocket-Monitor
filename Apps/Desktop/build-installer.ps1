[CmdletBinding()]
param(
    # Skip build-release.ps1 and package whatever target\release holds.
    [switch]$NoBuild,
    [switch]$StopRunning
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

foreach ($name in 'opc-monitor.exe', 'opc_vcam_win.dll', 'OpenPocketCineDesktop.dll') {
    if (-not (Test-Path (Join-Path $staged $name))) {
        throw "$name is not in $staged - run build-release.ps1 first."
    }
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

# The version the workspace builds with.
$cargo = Get-Content (Join-Path $desktop 'Cargo.toml') -Raw
$version = if ($cargo -match '(?m)^version\s*=\s*"([^"]+)"') { $Matches[1] } else { '0.0.0' }

New-Item -ItemType Directory -Force -Path $dist | Out-Null
& $iscc "/DStaged=$staged" "/DAppVersion=$version" "/DOutDir=$dist" (Join-Path $desktop 'installer\OpenPocketCine.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup failed.' }

Write-Host "Built $(Join-Path $dist "OpenPocketCine-Setup-$version.exe")"
