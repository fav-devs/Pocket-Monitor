# OpenPocketCine Camera (macOS)

The camera extension that makes the desktop viewfinder appear as **OpenPocketCine** in
every app that opens a camera on macOS 13 and later, and the small host app that
installs it. The viewfinder (`Apps/Desktop`) writes into the extension's sink stream
through the Swift facade (`Sources/OpenPocketCineDesktopFacade/DesktopVirtualCameraABI.swift`).

```sh
brew install xcodegen
cd Apps/Desktop/macos
xcodegen generate
xcodebuild -project OpenPocketCineCamera.xcodeproj -scheme OpenPocketCineCamera -configuration Release
```

Copy the built `OpenPocketCine Camera.app` to `/Applications`, open it, press
**Install**, approve the extension in System Settings → Privacy & Security. Then in the
viewfinder's Output tab set **Virtual camera** to **Camera device**.

What it needs, and why:

- The extension carries the system-extension entitlement, so the team in `project.yml`
  must be in the Apple Developer Program and the app Developer ID signed. Nothing loads
  otherwise.
- While developing, `systemextensionsctl developer on` lets a build run from anywhere
  instead of `/Applications`.
- The mach service name in `CameraExtension/Info.plist` and the app group in both
  entitlements files share the team prefix; change the bundle id in one place and the
  other two follow.

The host and extension compile on Intel macOS; activation and frame delivery remain unverified.

## Pocket Monitor viewfinder app

From the repository root on macOS with Xcode selected:

```sh
brew install ffmpeg pkg-config xcodegen glslang molten-vk vulkan-loader just
rustup component add rustfmt clippy
Apps/Desktop/build-macos.sh --dmg
```

This builds the debug Swift facade and release `opc-monitor` (as on Windows, Swift
release optimization strips the internal C ABI exports), copies their native dependency
closure into `Apps/Desktop/dist/Pocket Monitor.app/Contents/Frameworks`, rewrites the
library paths and ad-hoc signs the bundle. `--dmg` also creates
`Apps/Desktop/dist/Pocket Monitor.dmg`. The app loads its bundled MoltenVK directly;
the Vulkan instance opts into portability enumeration when the loader advertises it
and enables the portability subset on macOS. Windows keeps its original Vulkan setup and DirectML provider;
macOS hand tracking uses ONNX Runtime's CPU provider. Models are embedded in the binary.
The local bundle needs macOS 14 or later because of its Homebrew dependencies.
The camera extension is a separate installation and is not embedded in this bundle.

Bluetooth pairing requires access in **System Settings → Privacy & Security → Bluetooth**.
Allow **Pocket Monitor**, then reopen the app and scan with the camera awake.
After replacing an ad-hoc signed build, switch its Bluetooth permission off and on
again before reopening: macOS can retain an approval tied to the old executable's
code hash. A checked permission entry alone does not establish access for the new build. macOS's
Bluetooth device list and the app's Bluetooth LE scan are separate; seeing a device in
Settings does not establish that the app can scan. The macOS transport waits for the
Bluetooth manager to become ready and reports a readiness/access error instead of
silently presenting an empty camera list. A USB adapter must support Bluetooth LE.
The macOS shell uses btleplug 0.13.5, which separates connecting from service
discovery and fixes CoreBluetooth discovery operations that could hang after an
error. Windows and other platforms retain btleplug 0.11. macOS connection setup
(including service discovery and notification subscription) times out after 30 seconds,
cancels the pending connection, and requires a fresh scan before retrying. Keep the
camera awake, close DJI Mimo on the phone, and accept any pairing prompt on the camera.
Before reconnecting, the macOS shell retrieves the camera by its CoreBluetooth UUID.
This refreshes the device record removed on disconnect, including the reconnect
between initial pairing and sending home Wi-Fi settings.

On a patched Realtek Bluetooth stack, native CoreBluetooth itself may remain in
`connecting` before service discovery. An independent native probe reproduced this
on the RTL8852C with BlueToolFixup: the host waits for PHY/data-length negotiation.
A machine-specific legacy-LE compatibility workaround allowed native service discovery
and app pairing. This is a system Bluetooth compatibility issue; seeing the camera
in macOS Bluetooth Settings does not verify the application connection. The workaround
limits optional 2M PHY and data-length extension; it is not shipped inside this app.
BLE diagnostics are written to `~/.config/OpenPocketCine/opc-ble.log` (or under
`XDG_CONFIG_HOME` when set), outside the signed app bundle to preserve its resource seal.

For development outside the app bundle:

```sh
export PATH="$(brew --prefix)/bin:$PATH"
export VK_DRIVER_FILES="$(brew --prefix molten-vk)/etc/vulkan/icd.d/MoltenVK_icd.json"
swift build --product OpenPocketCineDesktop -c debug
export OPC_CORE_LIB_DIR="$(swift build -c debug --show-bin-path)"
cd Apps/Desktop
cargo build --release -p opc-monitor
cargo test -p opc-monitor --lib
./target/release/opc-monitor demo
```

Homebrew ended support for Intel macOS in September 2026. This Intel Mac was bootstrapped
with the June 2026 installer, Homebrew 5.1.9, and homebrew-core snapshot
`c935e3a89a8ef09388aa543c6d5f4b2be286aa4a` (FFmpeg 8.1.1, MoltenVK 1.4.1).
Use `HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_FROM_API=1` when maintaining that
installation; current formulae may require source builds. Rust was already installed
through rustup and Xcode supplies Swift. The generated Xcode project is ignored.

Ad-hoc signing is suitable for this local build; it does not provide Gatekeeper
notarization or permission to activate a camera system extension. The extension needs
an Apple Developer Program team, matching identifiers/app groups/mach-service prefix,
the system-extension and camera-extension entitlements, and appropriate signed
provisioning. For distribution use Developer ID signing and notarization, then install
its host in `/Applications` and approve activation in System Settings. To compile the
extension without that signing setup (activation will remain unavailable):

```sh
cd Apps/Desktop/macos
xcodegen generate
xcodebuild -project OpenPocketCineCamera.xcodeproj -scheme OpenPocketCineCamera \
  -configuration Release -derivedDataPath ../../../.build/macos-camera CODE_SIGNING_ALLOWED=NO
```

This packaging script is for local builds. Homebrew's FFmpeg enables GPL components;
do not publish this app as an LGPL-only release. Public release packaging needs the
same FFmpeg licence review as `build-release.ps1`, plus the licences/source obligations
of all bundled dependencies. No unofficial LUTs are bundled.
