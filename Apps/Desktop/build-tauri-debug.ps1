# Builds the Tauri desktop app (crates/pm-desktop) for diagnostics: the Expo web export of
# Apps/Mobile as its interface, the debug-camera profile (opt-level 2), and every DLL the
# executable loads staged beside it. Toolchain discovery is the same as build-debug.ps1.
#
#   .\build-tauri-debug.ps1                 web export + build + stage
#   .\build-tauri-debug.ps1 -NoWeb          reuse crates\pm-desktop\ui from the last export
#   .\build-tauri-debug.ps1 -StopRunning    close a running pm-desktop first
#
# Then: .\target\debug-camera\pm-desktop.exe [--camera 192.168.2.1:9004] [--model 0x20]
# PM_PICTURE_HOST=toplevel switches the picture from the child HWND (option A) to the
# window itself (option B) for the compositing prototype.
[CmdletBinding()]
param(
    [switch]$StopRunning,
    [switch]$NoWeb
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$desktop = Join-Path $repo 'Apps\Desktop'
if ($StopRunning) {
    $running = @(Get-Process pm-desktop -ErrorAction SilentlyContinue)
    $running | Stop-Process -Force
    foreach ($process in $running) {
        $process.WaitForExit()
    }
}
if (Get-Process pm-desktop -ErrorAction SilentlyContinue) {
    throw 'Close pm-desktop first, or rerun with -StopRunning.'
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

if (-not $NoWeb) {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22 is needed for the web export.' }
    node (Join-Path $desktop 'crates\pm-desktop\scripts\prepare-ui.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'The Expo web export failed (run npm ci in Apps\Mobile first).' }
}
Push-Location $repo
try {
    swift build --product OpenPocketCineDesktop --configuration debug
    if ($LASTEXITCODE -ne 0) { throw 'Swift desktop core build failed.' }
    $env:OPC_CORE_LIB_DIR = Join-Path $repo '.build\x86_64-unknown-windows-msvc\debug'
    Push-Location $desktop
    try {
        cargo build --profile debug-camera -p pm-desktop -p opc-vcam-win
        if ($LASTEXITCODE -ne 0) { throw 'Rust desktop build failed.' }
        Stage-Runtime (Join-Path $desktop 'target\debug-camera')
    } finally { Pop-Location }
} finally { Pop-Location }
Write-Host "Built $desktop\target\debug-camera\pm-desktop.exe"
