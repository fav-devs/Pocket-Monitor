# OpenPocketCine desktop

OpenPocketCine is a Windows-first desktop viewfinder for DJI Osmo cameras.

## Architecture

- `Apps/Desktop/`: Rust desktop application, UI, sockets, decode, and rendering.
- `Sources/OpenPocketViewCore/`: portable Foundation-only protocol and business logic.
- `Sources/OpenPocketCineDesktopFacade/`: Swift C ABI consumed by Rust.
- `Sources/COpcDesktop/`: shared C records.

Keep protocol bytes and camera decisions in the Swift core. Keep Windows APIs, Wi-Fi joining,
Bluetooth, FFmpeg, Vulkan, and UI in the desktop shell.

## Rules

- Do not commit camera Wi-Fi passwords, captures, personal data, signing material, or unofficial LUTs.
- Work on a branch and use Conventional Commits.
- Update desktop documentation when user-visible behavior changes.
- Verify live-path changes on a physical Windows machine and camera; compilation is not enough.
- `0x09/0xa8` enables live view once at launch; repeats belong only to the watchdog.
- Keep the UDP ACK pump at 40 Hz and independent from UI work.

## Verification

- `just desktop-check` for Rust formatting, clippy, and tests.
- `swift test` for core and facade tests.
- `Apps/Desktop/build-debug.ps1` for diagnostic Windows builds.
- `Apps/Desktop/build-release.ps1` for the terminal-free operator build.
