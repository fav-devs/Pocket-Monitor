#!/bin/bash
# Local macOS build with bundled native dependencies and ad-hoc signing.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
command -v brew >/dev/null
# Match the Windows build: release Swift optimization strips internal C ABI exports.
swift build --product OpenPocketCineDesktop --configuration debug
export OPC_CORE_LIB_DIR="$(swift build --configuration debug --show-bin-path)"
export PKG_CONFIG_PATH="$(brew --prefix ffmpeg)/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
cd Apps/Desktop
cargo build --release -p opc-monitor
python3 macos/package-app.py --core "$OPC_CORE_LIB_DIR/libOpenPocketCineDesktop.dylib" "$@"
