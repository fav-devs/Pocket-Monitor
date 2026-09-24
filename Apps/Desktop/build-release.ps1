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

$ffmpeg = $null
if ($env:FFMPEG_DIR -and (Test-Path (Join-Path $env:FFMPEG_DIR 'include')) -and (Test-Path (Join-Path $env:FFMPEG_DIR 'lib'))) {
    $ffmpeg = Get-Item $env:FFMPEG_DIR
}
if (-not $ffmpeg) {
    $ffmpegPackage = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Directory -Filter 'Gyan.FFmpeg*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($ffmpegPackage) {
        $ffmpeg = Get-ChildItem $ffmpegPackage.FullName -Directory -Filter 'ffmpeg-*-full_build-shared' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1
    }
}
if (-not $ffmpeg) {
    $ffmpegCommand = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
    if ($ffmpegCommand) {
        $candidate = Split-Path (Split-Path $ffmpegCommand.Source -Parent) -Parent
        if ((Test-Path (Join-Path $candidate 'include')) -and (Test-Path (Join-Path $candidate 'lib'))) {
            $ffmpeg = Get-Item $candidate
        }
    }
}
if (-not $ffmpeg) { throw 'FFmpeg shared development files are not installed or discoverable. Set FFMPEG_DIR to their root.' }
$ffmpegExe = Join-Path $ffmpeg.FullName 'bin\ffmpeg.exe'
if (-not (Test-Path $ffmpegExe)) { throw "FFmpeg executable is missing from $($ffmpeg.FullName)." }
$ffmpegConfiguration = (& $ffmpegExe -buildconf 2>&1 | Out-String)
if ($ffmpegConfiguration -match '(?m)(^|\s)--enable-(gpl|nonfree)(\s|$)') {
    throw 'Release builds must use an LGPL shared FFmpeg build without --enable-gpl or --enable-nonfree.'
}
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
    # Do not leave DLLs from a previously selected FFmpeg major beside the app.
    $ffmpegDlls = 'avcodec-*.dll', 'avdevice-*.dll', 'avfilter-*.dll', 'avformat-*.dll',
        'avutil-*.dll', 'postproc-*.dll', 'swresample-*.dll', 'swscale-*.dll'
    foreach ($pattern in $ffmpegDlls) {
        Get-ChildItem $outputDir -Filter $pattern -ErrorAction SilentlyContinue |
            Remove-Item -Force
    }
    Get-ChildItem (Join-Path $ffmpeg.FullName 'bin\*.dll') | Copy-Item -Destination $outputDir -Force
    Copy-Item (Join-Path $ffmpeg.FullName 'LICENSE.txt') (Join-Path $outputDir 'FFmpeg-LICENSE.txt') -Force
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
