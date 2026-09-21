[CmdletBinding()]
param(
    [switch]$StopRunning
)

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$desktop = Join-Path $repo 'Apps\Desktop'
$swiftBuild = Join-Path $repo '.build\desktop-release'

if ($StopRunning) {
    $running = @(Get-Process opc-monitor -ErrorAction SilentlyContinue)
    $running | Stop-Process -Force
    foreach ($process in $running) {
        $process.WaitForExit()
    }
}
if (Get-Process opc-monitor -ErrorAction SilentlyContinue) {
    throw 'Close opc-monitor first, or rerun with -StopRunning.'
}

$toolchainRoot = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs\Swift\Toolchains') -Directory |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $toolchainRoot) { throw 'Swift for Windows is not installed.' }
$swiftBin = Join-Path $toolchainRoot.FullName 'usr\bin'
$runtimeBin = Join-Path (Join-Path $env:LOCALAPPDATA 'Programs\Swift\Runtimes') ($toolchainRoot.Name.Split('+')[0] + '\usr\bin')
$sdkRoot = Join-Path (Join-Path $env:LOCALAPPDATA 'Programs\Swift\Platforms') ($toolchainRoot.Name.Split('+')[0] + '\Windows.platform\Developer\SDKs\Windows.sdk')

$msvcRoot = Get-ChildItem 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC' -Directory |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $msvcRoot) { throw 'Visual Studio Build Tools C++ workload is not installed.' }
$kitVersion = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\Lib' -Directory |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $kitVersion) { throw 'Windows SDK libraries are not installed.' }

$ffmpegPackage = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Directory -Filter 'Gyan.FFmpeg.Shared*' |
    Sort-Object Name -Descending | Select-Object -First 1
if ($ffmpegPackage) {
    $ffmpeg = Get-ChildItem $ffmpegPackage.FullName -Directory -Filter 'ffmpeg-*-full_build-shared' |
        Sort-Object Name -Descending | Select-Object -First 1
}
if (-not $ffmpeg) { throw 'FFmpeg shared build is not installed.' }
$vulkan = Get-ChildItem 'C:\VulkanSDK' -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $vulkan) { throw 'Vulkan SDK is not installed.' }

$env:PATH = "$swiftBin;$runtimeBin;$($msvcRoot.FullName)\bin\Hostx64\x64;$($vulkan.FullName)\Bin;$($ffmpeg.FullName)\bin;$env:PATH"
$env:LIB = "$($msvcRoot.FullName)\lib\x64;$($kitVersion.FullName)\ucrt\x64;$($kitVersion.FullName)\um\x64"
$env:SDKROOT = $sdkRoot
$env:FFMPEG_DIR = $ffmpeg.FullName


# Everything the executable loads at start has to sit beside it: the Swift facade and
# runtime, the allocator the Swift toolchain links, FFmpeg, and the virtual camera
# source the Output tab registers. The script's PATH does not follow the exe out of
# this window.
function Stage-Runtime([string]$outputDir) {
    Copy-Item (Join-Path $env:OPC_CORE_LIB_DIR 'OpenPocketCineDesktop.dll') (Join-Path $outputDir 'OpenPocketCineDesktop.dll') -Force
    Get-ChildItem (Join-Path $runtimeBin '*.dll') | Copy-Item -Destination $outputDir -Force
    foreach ($name in 'mimalloc.dll', 'mimalloc-redirect.dll') {
        $candidate = Join-Path $swiftBin $name
        if (Test-Path $candidate) { Copy-Item $candidate $outputDir -Force }
    }
    Get-ChildItem (Join-Path $ffmpeg.FullName 'bin\*.dll') | Copy-Item -Destination $outputDir -Force
}

Push-Location $repo
try {
    # The Windows release Swift linker currently strips the C ABI exports. Keep the
    # facade on the proven debug ABI while the operator executable itself is release
    # optimized and runs without a terminal window.
    swift build --product OpenPocketCineDesktop --configuration debug --scratch-path $swiftBuild
    if ($LASTEXITCODE -ne 0) { throw 'Swift desktop core release build failed.' }
    $env:OPC_CORE_LIB_DIR = Join-Path $swiftBuild 'x86_64-unknown-windows-msvc\debug'
    Push-Location $desktop
    try {
        cargo build --release -p opc-monitor -p opc-vcam-win
        if ($LASTEXITCODE -ne 0) { throw 'Rust desktop release build failed.' }
        Stage-Runtime (Join-Path $desktop 'target\release')
    } finally { Pop-Location }
} finally { Pop-Location }

Write-Host "Built $(Join-Path $desktop 'target\release\opc-monitor.exe')"
