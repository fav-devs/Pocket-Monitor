#!/bin/bash
# Local macOS build of the Tauri app (crates/pm-desktop): the Expo web export as its
# interface, the debug Swift facade (release optimisation strips its C ABI exports, as on
# Windows), a release pm-desktop, and the same bundling and ad-hoc signing as
# build-macos.sh (macos/package-app.py: every non-system dylib copied into Frameworks with
# its paths rewritten, then `codesign --sign -` on each binary and the bundle). The bundle
# carries crates/pm-desktop/Info.plist (Bluetooth, Location, local network, Bonjour).
#
#   Apps/Desktop/build-tauri-macos.sh            web export + build + bundle
#   Apps/Desktop/build-tauri-macos.sh --no-web   reuse crates/pm-desktop/ui
#   Apps/Desktop/build-tauri-macos.sh --dmg      also write the .dmg
#
# Then: open "Apps/Desktop/dist/tauri/Pocket Monitor.app"
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
command -v brew >/dev/null
web=1
pass=()
for arg in "$@"; do
  case "$arg" in
    --no-web) web=0 ;;
    *) pass+=("$arg") ;;
  esac
done
if [ "$web" = 1 ]; then
  node Apps/Desktop/crates/pm-desktop/scripts/prepare-ui.mjs
fi
swift build --product OpenPocketCineDesktop --configuration debug
export OPC_CORE_LIB_DIR="$(swift build --configuration debug --show-bin-path)"
export PKG_CONFIG_PATH="$(brew --prefix ffmpeg)/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
cd Apps/Desktop
cargo build --release -p pm-desktop
python3 macos/package-app.py \
  --core "$OPC_CORE_LIB_DIR/libOpenPocketCineDesktop.dylib" \
  --binary target/release/pm-desktop \
  --executable pocket-monitor \
  --bundle-id com.favdevs.pocketmonitor.desktop \
  --info-plist crates/pm-desktop/Info.plist \
  --out "dist/tauri/Pocket Monitor.app" \
  ${pass[@]+"${pass[@]}"}
