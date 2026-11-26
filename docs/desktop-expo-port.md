# Desktop → Tauri 2 + Expo web port: parity and performance audit

Audit written 2026-11-26 against `Apps/Desktop` (workspace 0.1.0) and `Apps/Mobile` at
`ca5c926`. Read-only: no code was changed to produce it. Use it in two ways:

- **What to build.** Every operator-visible behaviour of the Rust desktop app, with the place it
  should live in the Tauri port.
- **How the port is judged.** The performance mechanisms the port has to keep, and the gates
  that must pass before `Apps/Desktop` can be deleted.

The owner's requirement is a **full port: no lost features and no lost performance**. Where
this document says "keep", it means the behaviour and the numbers, not necessarily the code.

Sources read: `Apps/Desktop/README.md`, every crate under `Apps/Desktop/crates/*`
(`src`, `Cargo.toml`, `build.rs`, shaders, tests where they pin behaviour), `installer/`,
`macos/`, the four `build-*.ps1` scripts, `docs/DESKTOP.md`, `desktop-parity-audit.md`,
`desktop-port-status.md`, `desktop-viewfinder.md`, `desktop-camera-link.md`,
`desktop-ui-handoff.md`, `PERFORMANCE.md`, `live-session.md`, `feed-watchdog.md`,
`watcher-relay.md`, `README.md`, `CONTEXT.md`, `AGENTS.md`. Mobile side: `Apps/Mobile/AGENTS.md`,
`src/features/*`, `src/camera/{session,types}.ts`, `src/camera/native/*`, `src/state/*`,
`modules/pocket-native/{README.md,src/types.ts}`.

---

## 0. What exists today

### 0.1 The desktop app in one paragraph

`opc-monitor` is one binary with **three UI technologies and one process per screen**.
The home screen (`home.rs`) and the pairing/connection screen (`connect.rs`) are **eframe/egui**
windows. The viewfinder (`view.rs`) is a **winit** window. Its picture is a **Vulkan (ash)**
swapchain (`opc-render`), and its chrome is a **Slint software-rendered** RGBA overlay
(`opc-chrome`, `ui/hud.slint`, 2,370 lines) composited in a final Vulkan pass. winit and eframe
allow one event loop per process. So every screen change re-spawns `opc-monitor.exe` with new
arguments (`main.rs` `relaunch_viewfinder*`, `respawn_home`, `OPC_FROM_HOME`). Protocol bytes
and camera decisions come from the Swift `OpenPocketViewCore` through the C facade
(`Sources/OpenPocketCineDesktopFacade`, `opc-core-sys`). `opc-watcher` is a second, older
binary: a CLI plus a bare winit/Vulkan window on a phone's shared feed.

| Crate | Rust lines (src) | Role | Fate in the port |
| --- | --- | --- | --- |
| `opc-core-sys` | 1,068 | FFI to the Swift facade, `#[repr(C)]` layout guards | **Keep as is** |
| `opc-camera` | ~5,600 | UDP DUML session, 40 Hz ACK pump, mailbox, watchdog, pairing, station, Wi-Fi profile XML, LAN probe | **Keep as is** |
| `opc-relay` | ~1,600 | mDNS `_opc-mon._tcp`, TCP transport, join state machine | **Keep as is** |
| `opc-decode` | ~750 + C shim | libavcodec live decoder and file reader (video and audio) | **Keep**, plus optional hw decode later |
| `opc-media` | ~2,300 | Catalogue paging, `/v2` HTTP, cache, resume policy, worker | **Keep as is** |
| `opc-render` | ~3,000 + 7 shaders | Vulkan feed pipeline, swapchain, LUT/false-colour upload, stills | **Keep**, extend (see §3.7) |
| `opc-vcam`, `opc-vcam-win` | ~2,100 | v4l2loopback, MF virtual camera COM DLL and pipe, MJPEG stream, install/probe | **Keep as is** |
| `opc-watcher` | ~950 | CLI (`list/join/watch/decode`), bare window | **Keep** (no Slint in it) |
| `opc-ui` | ~1,600 | Key map, stick, countdown, format ladder, tracking arithmetic, **bitmap font, CPU canvas, HUD** | Split: keep the maths; **retire** `font.rs`, `canvas.rs`, `hud.rs` |
| `opc-chrome` | 1,228 + `hud.slint` + fonts/icons | Slint Mimo replica | **Retire** |
| `opc-monitor` | ~17,000 | `Shell` (3,686 lines of decisions *and* chrome), sheets, library, scopes, moves, presets, gestures, link, view, home, connect, media, audio, webcam | Split: decisions move into a Rust controller, presentation moves to web (§3.4) |

### 0.2 What has actually met hardware

`desktop-ui-handoff.md` records these working on a physical Pocket 3 under Windows: BLE
pairing, SoftAP join through a manual WLAN profile, the UDP handshake, telemetry, AVC
ingest, FFmpeg decode and Vulkan display. Everything else the docs list is "in tree, not
physically verified". That includes the virtual cameras, station mode, the phone relay,
touch, and the Slint chrome at length. **The port's baseline is the current app as it
behaves on a real Windows machine**, so the first acceptance step (§4) is to measure that
baseline.

### 0.3 Discrepancies found during the audit (fix or carry consciously)

| # | Finding | Evidence |
| --- | --- | --- |
| D1 | `F11` is documented as fullscreen, but no key binding exists. Only the chrome button toggles fullscreen. | `view.rs` `translate()` maps Space/Esc/Tab/arrows/characters only. `desktop-viewfinder.md` key table lists `F11`. |
| D2 | `keys`, `version` and `--help` print nothing in the release build. It is a `windows_subsystem = "windows"` binary with no console. | `main.rs` line 3 |
| D3 | `opc-monitor.log` is written beside the executable. Under `C:\Program Files\OpenPocketCine` (the installer's target) a normal user cannot write there, so **installed builds lose their log silently**. The file is also truncated on every launch (`File::create`). | `main.rs`, `link.rs` `diagnostic()`, `station.rs` `log()` |
| D4 | With the virtual camera on and a window not exactly 1280×720, `feed_vcam` calls `render_picture(…, (1280,720))`, and `ensure_targets` rebuilds all targets on size mismatch (`device_wait_idle` + destroy + build). The next present rebuilds them again for the window size. That is **two full target rebuilds per vcam frame, at up to 30 Hz**. `render()` also does an unconditional `device_wait_idle`. | `view.rs` `feed_vcam`, `renderer.rs` `ensure_targets`, `render` |
| D5 | Docs say the BLE transport "is not written yet". `ble_impl.rs` (btleplug) and the egui pairing flow exist and are physically used. | `Apps/Desktop/README.md`, `desktop-camera-link.md` vs `ble_impl.rs`, `connect.rs` |
| D6 | The home screen and pairing are egui, not Slint. "Retire Slint" alone would leave eframe/egui/wgpu in the binary. | `opc-monitor/Cargo.toml` (`eframe`, `egui`) |
| D7 | `R` means *stop* recording on desktop (`Space` starts). Mobile web's `R` *toggles*. `+`/`-` step the body's zoom stops on desktop; on mobile web they run a continuous zoom rate. | `opc-ui/controls.rs` vs `Apps/Mobile/src/features/input/useKeyboardShortcuts.ts` |
| D8 | Webcam gestures need `ffmpeg.exe`. The release staging copies only FFmpeg **DLLs**, so gestures work only when `ffmpeg.exe` is on `PATH` or in a winget `Gyan.FFmpeg` package. | `webcam.rs` `ffmpeg()`, `build-release.ps1` `Stage-Runtime` |
| D9 | The installer file name differs: `PocketMonitor-Setup-<v>.exe` (scripts, `DESKTOP.md`) vs `OpenPocketCine-Setup-<v>.exe` (`Apps/Desktop/README.md`). | |
| D10 | The release build ships the Swift facade's **debug** build, because the Windows release Swift linker strips the `@_cdecl` exports. | `build-release.ps1` line ~98 |
| D11 | Stills (`S`) go to `opc-still.png` in the **current working directory**. For a Start-menu launch that is the install folder, which is unwritable. | `main.rs` `view_camera` |

---

## 1. Feature inventory

Legend for **Port home**:

- **R**: Rust backend (a Tauri command or event, reusing the crates)
- **N**: native picture layer (Vulkan surface under the webview, its render thread)
- **W**: web UI (Expo/React Native web build of `Apps/Mobile`)
- **T**: Tauri shell, configuration or bundler

Legend for **Mobile today** (paths relative to `Apps/Mobile/src` unless they start with `modules/`):

- **YES**: an equivalent exists, at the path given.
- **PARTIAL**: something exists but differs or is incomplete. The note says how.
- **MISSING**: no equivalent.
- **N/A**: desktop-only by nature. There is nothing to port from mobile; the desktop
  behaviour must be kept natively.

Mobile's native modules (`modules/pocket-native`) have never been compiled. A YES therefore
means "the UI and contract exist", not "proven".

**Totals.** 165 inventory rows: 62 YES, 46 PARTIAL, 21 MISSING, 36 N/A (desktop-only, kept
natively). There are also 24 keyboard rows (7 missing on mobile web) and 11 game-controller rows.

### 1.A Launch, home screen, process model, windows

| # | Feature | Desktop (crate/file) | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| A1 | **Home screen**: cards for each remembered camera. A LAN camera card shows a live reachability dot (TCP 7001 probe every 3 s, 900 ms timeout). There are station and SoftAP cards, *Forget* buttons, **Pair a camera over Bluetooth**, **Connect by address** (IP or IP:port, default port 9004, copy "That isn't an address…"), *Other ways in* (watch a phone, try the demo), and a version label. | `opc-monitor/src/home.rs` (egui, 680×720, min 520×480), `main.rs` `show_home` | PARTIAL `features/pairing/CamerasScreen.tsx`: no connect-by-address, no reachability probe | W + R (`known_cameras`, `probe_camera` event, `forget_camera`) | The home screen is what Start-menu and desktop shortcuts open (I3). |
| A2 | **Home settings**: "Gesture control with my webcam", "Open my camera straight away when the app starts", "Keyboard shortcuts" (show/hide the key list) | `home.rs`, `appsettings.rs` | MISSING | W + R (`app_settings_get/set`) | Persisted in `desktop-app-v1.txt` (X3) |
| A3 | **Launch routing**. No args gives the home screen, or the remembered camera when *open at launch* is set. The viewfinder path tries the LAN camera (1.5 s TCP 7001), then the saved station (LAN search), then the saved SoftAP profile (12 s fast path), then pairing. `setup` skips all shortcuts. | `main.rs` `view_camera`, `lan_camera`, `station::load`, `load_saved_camera` | PARTIAL `camera/bootstrap.ts`, `NativeCameraSession.connect` (saved camera, no LAN/station-first chain) | R (`launch_plan` → route) + W router | Keep the order exactly. Each rung is logged (`wifi:` / `station:` lines). |
| A4 | **Closing the viewfinder returns to the home screen** | `main.rs` `back_to_home`, `OPC_FROM_HOME` respawn | YES (router back) | W (router) | Retire the respawn mechanism. |
| A5 | **One process per screen** (egui/winit one-event-loop limit). The phone passcode is passed to the child through `OPC_PHONE_PASSCODE`. | `main.rs` `relaunch_*` | N/A | T: single process, single window | Retire. This removes a process start and a Vulkan device creation per transition. |
| A6 | Window geometry and titles: viewfinder 1280×720 logical, resizable, "Pocket Monitor"; pairing 520×480 non-resizable; demo "Pocket Monitor — UI Demo" | `view.rs` `resumed`, `connect.rs` l.1453, `demo.rs` | N/A | T (`tauri.conf.json` window) + W (per-route size hints via `window.setSize`) | One window. Re-size on route change only if the owner wants the old sizes back. |
| A7 | **Fullscreen**: the chrome's fullscreen button toggles borderless fullscreen on the current monitor | `shell.rs` `Intent::ToggleFullscreen`, `view.rs` `carry_out` | MISSING (no fullscreen control) | T (`window.setFullscreen`) + W button + key + N (swapchain resize) | Add the `F11` key the docs promise (D1). |
| A8 | **Hidden chrome**: `H` and DISP `2 · Clean` hide all chrome. A sheet the operator has open stays visible in clean view. | `shell.rs` `ToggleChrome`, `chrome()` | YES `features/live/liveUiStore.ts` (`toggleChrome`), `prefs.hideChromeWhileRecording` | W | Mobile also has "hide while recording". |
| A9 | **Resize**: the picture is letterboxed, never stretched. The swapchain is recreated, the plates park in the gutters when the window is wider than the picture, and a minimised window survives. | `view.rs` `Resized`, `opc-render/present.rs`, `shell.rs` `set_window` | PARTIAL `features/live/layout/fieldMonitorLayout.ts` | N (swapchain) + W (layout) + R (fit rect) | One letterbox formula (`opc_render::letterbox`) must feed both hit-testing and drawing (§3.6). |
| A10 | **Black placeholder before the first picture**: chrome over black instead of an exposed white surface. The idle placeholder is not resubmitted until something changes. | `view.rs` `placeholder`, `placeholder_presented` | N/A | N (clear to black) + W (transparent over it) | The WebView2 default background must be transparent from the first paint, or the white flash returns. |
| A11 | **Renderer failure is named in the title** ("Pocket Monitor — renderer failed") and as a phase "renderer failed — see terminal output". A repeated error is not re-logged. | `view.rs` `draw` | N/A | R event `picture://error` + T title + W banner | Replace "terminal output" with "the log". |
| A12 | **Fatal error dialog** (`MessageBoxW`) when there is no console | `main.rs` `show_error` | N/A | T (`tauri-plugin-dialog`) or keep `MessageBoxW` before the builder runs | |
| A13 | **No console in the release build**; the debug build keeps one | `main.rs` `windows_subsystem` | N/A | T (same attribute) | Attach a parent console for CLI output (D2). |
| A14 | **Timer and power-throttling opt-out** at start: `SetProcessInformation(ProcessPowerThrottling)` and `timeBeginPeriod(1)` | `main.rs` `keep_timers_fast` | N/A | R (first line of the Tauri `main`) | Also a performance mechanism (P9). |
| A15 | **Focus loss and window close rest the gimbal** and cancel pointer/control drags | `view.rs` `Focused(false)`, `CloseRequested` → `pointer_cancel`, `control_cancel` | PARTIAL (`useKeyboardShortcuts` blur releases keys) | R (tao `WindowEvent::Focused/CloseRequested`) **and** W (blur) | Rust must rest the stick even if the webview is hung (§3.6). |
| A16 | **Demo mode** (`demo`): synthetic slate frame, phase walk, no camera or core needed | `demo.rs` | YES `camera/demo/DemoCameraSession.ts` (procedural WebGL2 scenes) | W (demo session) + N (synthetic Rust source, so the Vulkan layer is exercised in demo) | |
| A17 | **Multi-window**: none inside `opc-monitor`. `opc-watcher` runs as a separate process with its own window. | `opc-watcher/src/watch.rs` | N/A | T (single window). A detachable second window is optional, not a parity item. | |
| A18 | **Model labels** ("Osmo Pocket 3", "Osmo Nano", "Osmo Pocket 4", "DJI camera") | `appsettings.rs` `model_label` | YES `camera/native/models.ts` | W | |

### 1.B Command line and environment

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| B1 | `view [--camera HOST:PORT] [--model ID] [--look NAME \| --lut FILE] [--still PATH]`. `--camera` skips the connection screen. A non-loopback address other than `192.168.2.1` is remembered as the LAN camera. | `main.rs` `view_camera`, `load_lut` | N/A | R (parse argv before `tauri::Builder`, hand the initial route to W through `launch_args`) | `--look` builds a built-in look at 33³. `--lut` parses a `.cube` through the core. |
| B2 | `view --phone NAME [--phone-at IP:PORT] [--passcode P]`, plus `OPC_PHONE_PASSCODE` | `main.rs` | N/A | R | |
| B3 | `watch [NAME] […]`; without a name it opens the list of sharing phones | `main.rs` `watch_phone` | N/A | R → W route `/watcher` | |
| B4 | `demo`, `home`, `setup` (= `--setup`) | `main.rs` | N/A | R → W route | |
| B5 | `headless scan \| pair \| station [--seconds N] [--ssid S]` with `OPC_WIFI_PASSWORD`: BLE scan and print, pair, or provision station mode without a window | `connect.rs` `headless` | N/A | R (keep as a no-window path inside the same exe) | Field diagnostic for BLE. Keep. |
| B6 | `keys`, `version` / `--version`, `--help` / `-h`, error on an unknown command | `main.rs` `KEYS`, `USAGE` | N/A | R (+ `AttachConsole(ATTACH_PARENT_PROCESS)`) | Update `KEYS` to the real superset (§1.R). |
| B7 | `--gestures` anywhere in the args | `main.rs` | N/A | R | |
| B8 | Environment: `OPC_GESTURES`, `OPC_WEBCAM` (pick a webcam), `OPC_DUMP_STREAM=<path>` (Annex-B dump of every AU), `OPC_PHONE_PASSCODE`, `OPC_WIFI_PASSWORD` (headless) | `webcam.rs`, `view.rs` `dump_unit`, `connect.rs` | N/A | R | `OPC_FROM_HOME` is internal and retires with A5. |
| B9 | **`opc-watcher`** CLI: `list [--seconds N]`, `join <host> [--passcode] [--as NAME] [--dump PATH] [--seconds N] [--still PATH] [--look\|--lut]`, `watch <host>` (window), `decode <file.h265> [--out DIR] [--frames N] [--display WxH] [--lut\|--look] [--mirror] [--upscale]`, `version` | `opc-watcher/src/main.rs` | N/A | Keep the binary unchanged | It depends on `opc-decode`, `opc-relay`, `opc-render` and winit only. |
| B10 | Developer examples: `opc-chrome --example snapshot <dir>` (PNG of the chrome states), `opc-render --example replay` | `opc-chrome/examples`, `opc-render/examples` | N/A | Retire `snapshot`, replaced by web screenshot tests. Keep `replay`. | |

### 1.C Connection and pairing (camera SoftAP)

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| C1 | **BLE scan**: list cameras, *Scan Again*, *Cancel*, "Scanning for cameras…" | `connect.rs` (egui), `ble_impl.rs` (btleplug on a tokio runtime) | YES `features/pairing/PairScreen.tsx`, `SetupFlow.tsx`, `camera/native/scanList.ts` | R (`ble_scan_start/stop`, event `ble://adverts`) + W | Scan windows are ≥3 s (`ble_impl.rs`). |
| C2 | **Pairing exchange**: wake `0x00/0x2B` (fire and forget), PIN `0x07/0x45`, answer `0x07/0x46`, wake AP `0x53/0x10`, SSID `0x07/0x07`, password `0x07/0x0E`. Deadlines: PIN 90 s, AP 5 s, SSID 10 s, password 10 s. Writes paced 120 ms. Notification reassembly. "Press the pairing button on the camera body." | `connect.rs` `ble_worker`, `opc-camera/pairing.rs`, `ble.rs` | YES `core/ble/pairing.ts`, `NativeCameraSession.pair` | R + W | The password is never logged (rule in `desktop-ui-handoff.md`). |
| C3 | **Pairing complete** screen: **Join & Connect**, **Put the camera on my Wi-Fi instead**. Failure screen "Could not connect" with *Try Again*. **Already on camera Wi-Fi →** skips BLE. | `connect.rs` | PARTIAL `features/pairing/SetupFlow.tsx` (no "already on camera Wi-Fi") | W + R | |
| C4 | **Windows SoftAP join**: write `netsh wlan add profile` from `profile_xml` (manual `connectionMode`, `user=current`) to a temp file that is deleted afterwards, connect, then poll `ipconfig` every 500 ms for `192.168.2.x`. Both tools run with `CREATE_NO_WINDOW`. | `main.rs` `join_camera_wifi`, `join_saved_camera_wifi`, `opc-camera/wifi.rs` | N/A (mobile uses iOS/Android APIs) | R | Keep verbatim. Linux and macOS joiners are not implemented today. |
| C5 | **Saved camera**: `%LOCALAPPDATA%\OpenPocketCine\desktop-camera-v1.txt` (SSID and model). Windows owns the password in the WLAN profile. Reconnect uses a **12 s fast path**; on failure the pair flow opens. **Pair again**, **Cancel**. | `main.rs` `SavedCamera` | PARTIAL `state/savedCameras.ts` (credentials in secure store) | R + W | |
| C6 | **UDP datalink**: ephemeral local port (never 9004). TCP 7001 `SetPairingPIN("osmo")` poke, 2 s timeout, kept across rebuilds. Handshake retry 0.5 s, deadline 10 s. Subscriptions, then a 150 ms settle before the single `0x09/0xA8`. App presence every 1 s. `AppDeviceInfo` registration. | `opc-camera/session.rs`, `sequence.rs` | YES (unproven) `modules/pocket-native` PocketDatalink + `core/transport/datalink.ts` | R (as is) | |
| C7 | **Automatic reconnect**: a socket error or an unanswered handshake shows "… — reconnecting" and reopens every 3 s until the window closes | `link.rs` `reconnect` | PARTIAL `NativeCameraSession.recoverSession` | R | |
| C8 | **Reconnect** button (Link tab): tears the datalink down, opens a fresh session, shows "RECONNECTING" | `view.rs` `reconnect` | YES `features/settings/sections/ConnectionSection.tsx`, `session.retry()` | R `camera_reconnect` + W | |
| C9 | A fresh session id and 8-aligned base sequence per connect | `view.rs` `fresh_session` | YES `core` | R | |
| C10 | **Model id** flows from `--model` or the saved files into the status decoder and the cache folder name (`model-XXXX`) | `link.rs`, `view.rs` `camera_id` | YES | R | |
| C11 | **Pocket 3 first-picture format poke**: after 2 s (8 s if the format is unknown), switch to another listed size, restore after 0.8 s, then enable once | `session.rs` `drive_first_picture_format_poke` | PARTIAL (core policy) | R | |
| C12 | **Feed watchdog ladder**: resend enable (with a registration refresh), rebuild the decoder, reopen the datalink (new UDP socket), full rejoin (UDP reopen). Counts **presented** frames. Repairs are held while the library or player is open. | `session.rs` `recover`, `link.rs`, `view.rs` `sync_repair_blocked`, `rebuild_decoder` | YES `core/connection/feedWatchdog.ts`, `camera/native/feedTracker.ts` | R + N (the render thread reports each present) | |
| C13 | **Phase and notice copy**: WAITING FOR LIVE VIEW, APPROVE ON THE CAMERA, RECOVERING FEED, failure text. Controls are greyed while recovering or failed. | `opc-ui` `Phase`, `shell.rs` `controls_enabled` | YES `features/live/chrome/SessionRecoveryOverlay.tsx`, `ConnectScreen.tsx` | W | |

### 1.D Home network (station mode) and the camera's real address

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| D-1 | **Put the camera on my Wi-Fi**. The SSID is prefilled from `netsh` (the PC's own network); the operator types the password and presses **Join Wi-Fi**. Over BLE: read the identity, query the role, switch to station mode, read the role back (every 2 s × 6), wait 10 s for the radio, then join up to 3 times (core `JoinPolicy`); reply timeout 12 s. Pocket 4 selects video mode first. A Pocket 3 or Nano "no such getter" is tolerated. A lost join reply still triggers the search. | `opc-monitor/src/station.rs`, `homewifi.rs`, `opc-camera/station.rs` | PARTIAL `core/ble/stationJoin.ts`, `NativeCameraSession.runStation`, `SetupFlow.tsx` | R + W | The password goes to the camera only and is never stored. |
| D-2 | **LAN search**: every address on the PC's networks (a subnet larger than /22 is refused). TCP 7001 probe 600 ms, 32 in parallel, at most 8 candidates. Each candidate is verified over the datalink by its Wi-Fi identity (6 s). Notes for client isolation and no-match. | `station.rs`, `opc-camera/lan.rs` | MISSING (no LAN scan in TS) | R | |
| D-3 | **Remembered station** (`desktop-station-v1`): SSID, identity hex, last address, model. The last address is tried first, then the subnet, on every launch, with no Wi-Fi change and no BLE. | `homewifi.rs` `SavedStation` | PARTIAL `state/savedCameras.ts` (`path.kind = 'station'`) | R | |
| D-4 | **Return the camera to its own Wi-Fi** (back to AP mode, forget the network) | `connect.rs` `ResetStation` | PARTIAL | R + W | |
| D-5 | **LAN camera by address** (`desktop-lan-camera-v1.txt`; probed on launch) | `main.rs` `lan_camera` | MISSING | R | |
| D-6 | **Media from the camera's real address**: `opc_media::model::set_host(remote ip)`, so `/v2` HTTP goes to the station address and not `192.168.2.1` | `view.rs` `run`, `opc-media/model.rs` | MISSING (mobile media URLs are not ported) | R | |

### 1.E Watching a phone (relay) and the second screen

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| E1 | **Find sharing phones** (pure-Rust mDNS `_opc-mon._tcp`; the browser polls every 500 ms), list them, passcode field, pick one | `connect.rs` phones screen, `opc-relay/discovery.rs` | MISSING `features/watcher/WatcherScreen.tsx` is a placeholder | R (`relay_browse`, event `relay://hosts`) + W | |
| E2 | **Viewfinder on a phone's feed**. HEVC goes through the same decoder, assists, scopes, LUTs and virtual camera. Readouts come from the phone's state message, the FORMAT chip shows the phone's label, and the audio meters stay dark. | `opc-monitor/src/phone.rs`, `view.rs` `pump_phone` | MISSING | R + N + W | `VideoSource { kind: 'relay' }` already exists in the contract. |
| E3 | **Control lease**: the first proxied control requests it. Link tab **Request** / **Release**. Copy: "CONTROL REQUESTED · GRANT IT ON THE PHONE", "WAITING FOR THE PHONE TO GRANT CONTROL", "<NAME> HOLDS CONTROL", "THE PHONE IS NOT OFFERING CONTROL", "THE PHONE GRANTED CONTROL". Proxied: record, tap-focus, ISO, shutter, WB, colour, zoom. Refused with a top-bar note: gimbal, format, tracking, motion, audio, library. | `phone.rs` `proxy`, `view.rs` `send`, `phone_control` | MISSING | R + W | |
| E4 | **Relay recovery**: the core's 1/2/4 s retry ladder, 15 s join deadline, 5 s telemetry and picture silence, 10 s for the first picture, 750 ms delivery-delay guard. Each reconnect resolves the service again. | `opc-relay/session.rs` (core policy) | MISSING | R | |
| E5 | **`opc-watcher watch`** window: bare picture, keys `L` cube, `Z` zebra, `P` peaking, `M` mirror, `S` still, `Esc` quit | `opc-watcher/src/watch.rs` | N/A | Keep the binary | Superseded inside the app by E2, but cheap to keep. |

### 1.F Live picture (native layer)

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| F1 | **Content-driven codec latch**: AVC/HEVC chosen from the first parameter-set NAL. Units are discarded until parameter sets arrive. AVC configuration-only packets are accepted. Errors before the first picture are flushed and ignored. A later failure sets the Failed phase. | `view.rs` `decode`, `codec_of`, `is_h264_configuration` | YES (unproven) native PocketVideo | R (decode thread) | |
| F2 | **Feed pipeline**: `ycbcr.frag` (BT.709 limited) → peaking blur and mask (optional) → `feed.frag` (cube, zebra, peaking, false colour at the source raster) → `blit.frag` (letterboxed stretch, **Catmull-Rom** when the display raster is larger than the source) → `overlay.frag` | `opc-render/src/renderer.rs`, `shaders/*` | PARTIAL web: `features/picture/web/WebPictureRenderer.ts` (WebGL2, demo scenes only) | N | Pass order is a hard rule (cube before stretch). |
| F3 | **Letterbox, never stretch**, from one public formula, also used to map clicks | `opc_render::letterbox`, `shell.rs` `fit()` | YES `features/picture/LivePicture.shared.ts` `pictureRect` | N + R (send the fitted rect to W) | Keep a single source of truth (§3.6). |
| F4 | **Still (`S`, STILL button)**: the graded frame at source raster, written as a PNG to `--still` (default `opc-still.png` in the CWD), "Wrote …" | `view.rs` `take_still`, `opc-render/still.rs` | PARTIAL `PocketVideo.snapshot` (JPEG) | R + N | Save to a user folder and show a notice (D11). |
| F5 | **Stream dump** (`OPC_DUMP_STREAM`) | `view.rs` `dump_unit` | N/A | R | |
| F6 | **Presented-fps readout** (1 s window) on the status plate | `shell.rs` `presented`, `FPS_WINDOW` | YES `connection.videoFps` | R → W | Counted on the render thread. |
| F7 | **Mirror** (`M`) in the shader. Tracking and focus boxes are kept on the sensor and mirrored only when drawn. | `GradeOptions.mirror`, `shell.rs` | YES `effects.mirror` | N + W | |

### 1.G Viewfinder chrome (Slint today, web in the port)

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| G1 | **Top bar**: menu `⋮`, gimbal follow ON/OFF chip, format chip (`1080p · 60p`, aspect when not 16:9), exposure-mode chip AUTO/M, link state centred, red REC badge with running time, ASSIST, exit | `opc-chrome/ui/hud.slint`, `shell.rs` `chrome()` | YES `features/live/status/LiveStatusChrome.tsx`, `LiveTelemetry.tsx` (different layout) | W | The desktop's landscape-laptop layout is a design choice the web UI must reproduce or replace consciously. |
| G2 | **Zoom ruler**: dotted ruler under a fixed ring, drag to zoom, a label that reports the body's value, the body's stops marked, greyed when only 1×, D-Log2 lock note | `hud.slint`, `zoom.rs` | PARTIAL `features/live/gimbal/MonitorZoomDial.tsx`, `ZoomChip.tsx` | W + R (stops) | |
| G3 | **Exposure plate**: shutter, ISO, EV, WB. A field the camera has not reported is absent. | `hud.slint` | YES `features/live/capture/CaptureControlBar.tsx` | W | |
| G4 | **Status plate**: Wi-Fi, battery (red at ≤20 %), card time left, presented fps | `hud.slint` | YES `LiveStatusChrome.tsx` | W | |
| G5 | **Bottom bar**: gallery, flip, orientation (drawn, inert), joystick, record button (red disc, red square while rolling, white in photo mode), CTR, FOLLOW, STILL, fullscreen. **Every button carries its key hint.** | `hud.slint`, `ChromeIntent` | PARTIAL `CaptureControlBar.tsx`, `features/live/gimbal/LiveGimbalControls.tsx` (no key hints, no fullscreen) | W | Key hints are a desktop requirement. |
| G6 | **Mode strip** TIMELAPSE · SLOWMOTION · LOW-LIGHT · VIDEO · PHOTO · HYPERLAPSE. Refused while rolling. Photo is sent as the body's own byte. Live Photo reads as PHOTO. | `shell.rs` `MODE_CODES`, `mode_index` | PARTIAL `features/live/capture/CaptureSheetHost.tsx` (`setShootingMode`, not a strip) | W + R | |
| G7 | **Centre messages**: the phase, the countdown digits, failures. Notices last 2.5 s; "no answer from the camera". | `shell.rs` `notice`, `NOTICE_SECONDS` | YES `features/live/chrome/MonitorTransientNotice.tsx` | W | |
| G8 | Plates park in the letterbox gutters | `shell.rs` | PARTIAL `fieldMonitorLayout.ts` | W | |
| G9 | Controls ≥44 px, greyed and disabled while recovering or failed | `desktop-viewfinder.md` | YES (Mobile AGENTS rule) | W | |
| G10 | Chrome opacity fades the chrome only, never the picture | `renderer.rs` `overlay_opacity` | YES `prefs.chromeOpacity` | W | The web layer sits above the picture, so this holds by construction. |
| G11 | **Display tab**: DISP 1/2 (live/clean), plus toggles for the exposure plate, status plate, zoom ruler, gimbal pad and mode strip. Screen flip "has no laptop meaning". | `sheets.rs` `display_rows`, `Part` | PARTIAL (`Hide chrome`, `Chrome opacity`, `Picture fit`) | W | |
| G12 | Sheets close on `Esc`, `×` or a tap outside. The wheel scrolls tall sheets and slides chip strips sideways. | `shell.rs` `control_scroll`, `sheets.rs` | YES (bottom sheets) | W | Wheel → horizontal scroll must work in the web chip rows. |
| G13 | **Chip truth**: a chip lights when the camera confirms. Settings the body never reports (audio channel, FOV, gimbal speed) are kept as last commanded. | `shell.rs`, `sheets.rs` | YES | W + R | |

### 1.H Record and capture

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| H1 | Record: `Space` start, `R` stop, record button toggles, gamepad A. In a stills mode the button takes a picture. | `opc-ui/controls.rs`, `shell.rs` `record_command` | YES `features/live/record/useRecordControl.ts` | W + R | Mind the key semantics (D7). |
| H2 | **Countdown `T`**, length **3, 5 or 10 s** (Assist tab), cancellable by pressing `T` again | `shell.rs` `ToggleTimer`, `prefs.countdown_seconds` | PARTIAL `prefs.recordCountdown` (on/off 3-2-1, no key, no length) | W + R | |
| H3 | **Stop confirmation**: absent on desktop (audit item open) | — | YES `features/live/record/StopConfirmSheet.tsx` | W | A mobile gain. Keep it off by default to match desktop. |

### 1.I Gimbal

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| I1 | **Arrow keys**: pan/tilt through the core's `stick_axes`. Two arrows go diagonal; opposite arrows cancel. Fixed throw ±400 around 1024. The stick is re-sent every **200 ms** while held (keepalive) and rests on key-up. | `opc-ui/controls.rs` `Stick`, `shell.rs` `STICK_REPEAT` | PARTIAL `useKeyboardShortcuts.ts` (throw 0.6 through `postDrive`) | W (keys) → R (stream) | Rust owns the cadence (§3.6). |
| I2 | **On-screen joystick** (hold control). Rests on release, cancel, focus loss and close. | `ChromeIntent::GimbalMoved/Released`, `shell.rs` `pad_*` | YES `features/live/gimbal/LiveGimbalStick.tsx` | W → R | |
| I3 | **Gimbal ramp** Off/Soft/Medium: a first-order ease stepping at 25 Hz, on the keys and the pad | `shell.rs` `ramp_step`, `opc_ui::RampFilter` | MISSING (mobile has expo/response curves instead) | R | |
| I4 | **Joystick sensitivity** 1–5 (core stick curve) for the pad and controller | `prefs.stick_sensitivity` | YES `prefs.stickSensitivity` | R + W | |
| I5 | Recentre `C`/CTR, flip `F`, `V` cycles Follow → Tilt locked → FPV, **Direction lock** on the Gimbal mode row, FOLLOW chip/button | `shell.rs` `GimbalMode` | YES `GimbalController.recenter/flip/setMode`, `prefs.directionLock` | W + R | |
| I6 | Gimbal speed and FOV sent **once per link** (the body does not report them) | `shell.rs` `prefs_sent_to_body` | PARTIAL | R | |
| I7 | The gimbal mode chip follows the family the body reports in its heartbeat | `shell.rs` `set_status` | PARTIAL `camera/native/statusReducer.ts` | R → W | |
| I8 | **Manual control cancels a running programmed move** | `shell.rs` `move_stop` | YES `MotionControl.tsx` | R | |

### 1.J Zoom

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| J1 | `+`/`-` step the **body's own stops** (`CameraModel.activeZoomStops` for the model, format and mode); `0` returns to wide. Ruler drag goes through the mailbox, pipelined at 20 Hz. Zoom follows the body. | `zoom.rs`, `shell.rs` `zoom_write` | PARTIAL (web keys run a continuous rate, D7) | R (stops, policy) + W | |
| J2 | **D-Log2 hop**: hop to D-Log, wait for the report (2 s timeout), zoom, restore D-Log2 at 1×. Zoom is locked while rolling in D-Log2. | `zoom.rs` `ZoomHop`, `HOP_TIMEOUT` | PARTIAL `core/commands/camFov.ts` has the policy; not wired in `NativeCameraSession` | R | |
| J3 | Gamepad triggers hold-to-zoom at the phones' rate; shoulders step the stops | `shell.rs` `controller_zoom`, `zoom_trigger_step` | YES `features/input/useGamepad.ts`, `core/gimbal/gamepad.ts` | R | |

### 1.K Tracking and focus

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| K1 | **Drag to track**. Normalised through the letterbox, mirror undone, sent as centre+size `0x02/0xA6`. FRAME TOO SMALL under 9 %. A drag under 2 % is a click. Poll `0x02/0xA5` every 0.5 s (6 idle answers end it). `0x02/0x89` pushes (~15 Hz) are eased with the core constants; 0.35 s of silence means the body let go. `X` clears only when a box is out; a leftover push within 0.28 s is ignored. White search / green lock brackets. The box drops on link loss; a committed box is drawn for 1.5 s. | `shell.rs` (tracking), `opc-camera/tracking.rs`, `opc-ui/tracking.rs` | YES `features/live/feed/FeedGestureWell.tsx`, `MonitorTrackingOverlay.tsx`, `core/status/trackingBox.ts` | R (state machine) + W (draw) | Port `tests/shell.rs` tracking cases into the Rust controller. |
| K2 | **Tap to focus**: the four-write burst `0x22`, `0x30`, then `0x68` and `0x32` after the region ACK (or 0.4 s). Reticle with the AE spot for 1.5 s. Stops tracking first. Nothing on a Nano. | `shell.rs` `pending_tap`, `TAP_ACK_GRACE` | YES `CameraController.focusAt`, `prefs.tapToFocus` (default **off**) | R + W | Desktop default is on (a click focuses). Pick one and record it in `PARITY.md`. |
| K3 | **Touch**: one finger owns the box; a second finger or palm is ignored; a finger on a bar never claims the drag; a cancelled touch abandons the box; a touch that starts in a control never becomes tracking | `shell.rs` `touch` | YES (gesture handler) | W (Pointer Events) | WebView2 delivers touch as pointer events. Verify palm rejection physically. |
| K4 | **Focus mode** and **focus-track mode** (Default / Product Showcase / Subject Lock / Registered Priority); both hidden on a Nano | `sheets.rs` `camera_rows` | PARTIAL (focus mode yes; focus-track only in `core`) | W + R | |

### 1.L Format, exposure, white balance, colour

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| L1 | **Format sheet**: the body's listed sizes × rates only; a new size keeps the rate when offered; Pocket 3 camcap tables (Video / SlowMo / Low-Light); FORMAT pin 2 s; `[`/`]` walk the body's list | `sheets.rs`, `opc-ui/format.rs`, `shell.rs` `format_pin` | YES `CaptureSheetHost.tsx`, `stepResolution/stepFrameRate` | W + R | |
| L2 | **Exposure sheet** `E`: Auto/Manual; ISO with per-colour ladders and Auto in the wheel; 22-stop shutter ladder; ISO max; EV with U+2212; unused rows greyed | `sheets.rs` | YES `features/settings/sections/ExposureSection.tsx`, capture sheets | W + R (ladders from the core) | |
| L3 | **Shutter units** Speed/Angle: 5.6°–360° at the current rate (unknown counts as 24), snapped to the body's list | `prefs.shutter_angle` | YES `prefs.shutterUsesAngle` | W | |
| L4 | **White balance** presets, **Kelvin** 2000–10000 and **Tint** −100…+100, each keeping the other | `sheets.rs` | YES `WhiteBalanceChange` | W + R | |
| L5 | **Colour profile** from the body's wheel; refused while rolling | `sheets.rs` | YES `FormatState.colorModeOptions` | W + R | |
| L6 | **Field of view** Wide/Natural | `prefs.fov` | PARTIAL (`core/commands/camFov.ts`, no settings row found) | W + R | |
| L7 | **Live-control SET mailbox**: latest wins per opcode, 300 ms retransmit, 2 s settle, late ACK accepted, "no answer from the camera" | `opc-camera/mailbox.rs`, `shell.rs` `note_set` | YES `core/commands/setMailbox.ts`, `camera/native/setDriver.ts` | R | |

### 1.M Audio settings

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| M1 | Audio channel (mono/stereo/spatial) and vocal boost, read from the body on connect | `sheets.rs` `audio_rows` | PARTIAL `CameraController.setAudio` (no spatial) | W + R | |
| M2 | **Wind noise reduction** and **directional audio** (All / Front / Front+back) through the `0x02/0xA0` DSP blob (`@2`). Read when the tab opens, greyed until answered, sent back patched with `0x02/0x9F`, then re-read. | `sheets.rs`, `opc-camera/status.rs` `AUDIO_DSP_BLOB` | PARTIAL `setAudio({ windReduction, directional })` | R + W | |
| M3 | **Timecode** in the top bar (toggle) | `prefs.timecode` | YES `features/live/status/LiveStatusChrome.tsx` | W | |

### 1.N Assists

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| N1 | **Assist toolbar** `A`: fifteen tools `LUT PEAK FALSE \| ZEBRA WAVE PARADE \| HISTO VECTOR LIGHTS ND \| GUIDES GRID CROSS \| MIRROR \| AUDIO`. A tap toggles; a long press or right-click opens options. | `assists.rs`, `shell.rs` | YES `features/assists/AssistBar.tsx`, `AssistMenus.tsx` | W | Add right-click as the desktop long-press. |
| N2 | **Zebra** `Z`: highlight and midtone bands; levels in IRE or 0–255 codes; colours white/amber/red/cyan/green; steps 70–100 / 40–70; thresholds on the feed's axis per colour mode (`assist_scalars`) | `assists.rs`, `opc-render` `Zebra`, `lut.rs` `assist_scalars` | YES `PictureEffects.zebra` | W → N | |
| N3 | **Peaking** `P`: Low/Med/High (`PeakingSense`), colours white/blue/red/green, two-pass blur+mask | `opc-render` `Peaking`, shaders | PARTIAL `PictureEffects.peaking` uses `ratioThreshold/noiseGate` | W → N | One mapping table, or the Vulkan shader gains the mobile parameters. |
| N4 | **False colour**: CineStop / EL Zone / IRE / Limits lattices from the core for the colour mode and ISO; reference key; rebuilt when mode or ISO changes | `view.rs` `apply_lut_request(FalseColor)`, `Lut::false_color` | YES `PictureEffects.falseColor`, `features/assists/overlays/Meters.tsx` | W → R (lattices) → N | Mobile names: `cinestop`/`video`/`ire`/`limits`; map `video` ↔ EL Zone if equal. |
| N5 | **Grid**: thirds, phi, diagonals in any mix | `assists.rs` | YES `features/assists/overlays/Framing.tsx` | W | Drawn by React above the picture. |
| N6 | **Guides**: Film / Social frames (several at once), optional mask | `assists.rs` | YES `Framing.tsx` | W | |
| N7 | **Cross** (centre crosshair) | `assists.rs` | YES | W | |
| N8 | **Mirror** | — | YES | N | |
| N9 | **LUT 50/50 split** (`GradeOptions.split/split_vertical` exist, not wired), LUT exposure compensation, LUT intensity | `opc-render/options.rs` | YES on mobile: `lutIntensity`, `lutExposureStops` | N (add to `feed.frag`) | The mobile UI offers these. The Vulkan layer must implement them or the port regresses mobile. |
| N10 | **Mobile-only per-pixel effects**: `desqueeze`, `monochrome`, `mirrorVertical`, `sourceColor` display transform, `signal`/`clipByte` | — (missing on desktop) | YES `modules/pocket-native/src/types.ts` `PictureEffects` | N (new shader work) | Not a desktop regression, but the web UI will expose them on desktop. |

### 1.O Scopes

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| O1 | **WAVE** (luma or RGB overlay; clip / crush / middle-grey guides), **PARADE** (RGB / YRGB), **HISTO** (RGB fills and the luma line), **VECTOR** (75 % graticule, 123° skin line, zoom 1×/2×/4×), brightness. Each is a **movable plate** at the phones' size (250×153, 250×77, 190×190). Axis from the core's `ScopeDisplayScale`. | `opc-monitor/src/scopes.rs`, `shell.rs` `plate_rect` | PARTIAL `features/assists/scopes/*` (vector zoom 1/2 only) | R (sampling) → W (draw) | Data flow in §3.5. |
| O2 | **LIGHTS** (three lamps, clip/crush per channel, compensation steps) and **ND** chip (stops / factor ND32 / density ND 0.3), read by the core from the histograms | `scopes.rs` `LightsReading`, `NdReading` | YES `features/assists/overlays/Meters.tsx` | R → W | |
| O3 | **AUDIO** meters (the body's own, peak hold) | `scopes.rs`, `opc-camera` `AudioMeters` | YES `AudioState` meters | R → W | |
| O4 | **Plate dragging**; positions are not persisted | `shell.rs` `plate_positions` | YES `MovableScopePanel.tsx` | W | |
| O5 | Scopes over playback: **not** on desktop (audit item open) | — | PARTIAL (`context: 'playback'`) | R + W | Optional gain. |

### 1.P Colour cubes and LUTs

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| P1 | `L` toggles the cube. The **LUT row** lists Off, the core's official Rec.709 built-ins (33³), and every `.cube` in the **drop folder** `%LOCALAPPDATA%\OpenPocketCine\luts` (core `CustomLUTIndex` name rules). The folder is created at start and its path is shown. `--look` and `--lut` work too. | `luts.rs`, `view.rs` `apply_lut_request`, `opc-render/lut.rs` | PARTIAL `features/picture/lutLibrary.ts`, `LutPicker.tsx` (document picker, not a folder) | R (list/parse/load) → N (upload) + W | Keep the drop folder, and add the picker as an extra. |
| P2 | **Auto LUT on playback**: read the original's `moov` tail (last 2 MiB) through `ClipColorProfile`, then `OfficialDJILUT.auto` for the file name. Notice "AUTO LUT · OFFICIAL CUBE FOR THE CLIP" or the name to drop in. A proxy with no original falls back to the live colour mode. | `shell.rs` `auto_lut`, `media.rs` | MISSING | R | |
| P3 | Cube at the feed raster, before the stretch | `renderer.rs` pass order | YES (web shader order) | N | |

### 1.Q Programmed moves and gimbal presets

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| Q1 | **Moves sheet `K`**: **Set here** A/B/(C) from the live pose (live pan/tilt shown), leg durations, **Start** with a 3-2-1 countdown, top-bar readout, **Stop**; any arrow or the pad cancels with a native stop. Engine: approach in steps under 120° at 120°/s, 2 s hold, one `0x04/0x14` per leg, split above 180° or 25.5 s, attitude no older than 300 ms, arrival within 0.15°, **abort on a dispatch later than 40 ms**, reach pan −48…225° and tilt −44…70°. | `moves.rs`, `sheets.rs` Moves, `shell.rs` `move_*` | YES `features/live/gimbal/MotionControl.tsx`, `GimbalController.runProgram` (plus smoothness) | R (engine on a timer thread) + W | The 40 ms late rule needs a real scheduler, not the webview. |
| Q2 | **Gimbal presets**: 6 slots; **keys `1`–`6`** recall; Moves sheet rows "Preset N (key N)" with **Save here / Go / Clear**; recall time 0.5/1/2/4/8/15 s (default 2); one timed target, or two steps when the route needs it; persisted | `presets.rs`, `shell.rs` `preset_go`, `preset_followup_tick` | MISSING | R + W | File `desktop-gimbal-presets-v1.txt` (X4) |

### 1.R Keyboard (every key the viewfinder listens for)

| Key | Desktop action (`opc-ui/controls.rs`, `shell.rs` `press`) | Mobile web today (`useKeyboardShortcuts.ts`) | Port |
| --- | --- | --- | --- |
| `Space` | Start recording (player: pause/play) | Toggle record | Desktop semantics on desktop (D7) |
| `R` | Stop recording (library: refresh) | Toggle record | Desktop semantics |
| `T` | Countdown, or cancel it | MISSING | Add |
| `S` | Write a still | Capture **photo** on the camera | Decide one meaning; desktop's is a graded PNG |
| Arrows | Pan/tilt, diagonals, opposite cancels, 200 ms repeat | YES (drive 0.6) | Rust stream (§3.6) |
| `C` | Recentre | YES | — |
| `+` `=` / `-` `_` | Next / previous body stop | Continuous zoom rate | Desktop semantics |
| `0` | Back to wide | YES | — |
| `F` | Flip to selfie and back | YES | — |
| `V` | Cycle Follow → Tilt locked → FPV | YES | — |
| `G` | Library | YES | — |
| `X` | Stop tracking | YES | — |
| `[` / `]` | Step resolution / frame rate on the body's list | YES | — |
| `H` | Hide the chrome (every screen) | YES | — |
| `Tab` | Settings sheet | MISSING | `preventDefault` stops browser focus navigation |
| `E` | Exposure sheet | MISSING | Add |
| `K` | Moves sheet | MISSING | Add |
| `A` | Assist toolbar | MISSING | Add |
| `Z` `P` `L` `M` | Zebra, peaking, cube, mirror (every screen, including the player) | YES (live only) | Also in the player |
| `1`–`6` | Recall gimbal preset | MISSING | Add |
| `Esc` | Close a sheet first, then close the viewfinder (library: back; player: back) | Close the viewfinder | Keep the sheet-first rule |
| `F11` | *Documented, not bound* (D1) | MISSING | Add |
| Drag / click / touch | Track / tap-focus (K1–K3) | YES | — |
| Key repeat | Ignored (the shell handles held directions) | Ignored | — |

### 1.S Game controller (gilrs; the phones' map, discussion #159)

| Input | Desktop (`pad.rs`, `view.rs` `poll_pad`) | Mobile (`useGamepad.ts`, `core/gimbal/gamepad.ts`) | Port |
| --- | --- | --- | --- |
| Left stick | Pan/tilt (deadzone `REST` 0.08, sensitivity curve), polled every frame (~60 Hz) | YES (expo, picture-relative, stick choice left/right) | R (gilrs thread → gimbal directly) |
| A / Cross | Record toggle | YES (skips the stop confirmation) | R |
| B / Circle | Recentre | YES | R |
| X / Square | Flip | YES (rotate 180) | R |
| Y / Triangle | **Clear tracking** | Track a face / cancel | Desktop semantics (no face detector) |
| LB / RB | Zoom stop out / in | YES (out does not wrap) | R |
| LT / RT | Hold to zoom at the phones' rate (dt clamp 0.1 s) | YES | R |
| D-pad up/down | ISO on the body's list | YES | R |
| D-pad left/right | Shutter (left opens) | YES | R |
| Controls tab | **Game controller** switch, connected pad name, map help line `pad::MAP_HELP` | YES `prefs.gamepadEnabled`, "Gamepad" row Connected / Not connected | W + R |
| Connect/disconnect | Name updates | Toasts; unplug rests stick and zoom | R + W (add the toasts, keep the rest) |

### 1.T Webcam gestures

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| T1 | **Capture**: `ffmpeg -f dshow -framerate 15` at 160×120 RGB24 from the first DirectShow video device that is not software. Excluded words: virtual, obs, openpocketcine, pocket monitor, droidcam, ndi, snap camera, manycam. `OPC_WEBCAM` overrides. `ffmpeg.exe` is looked for beside the exe, then on `PATH`, then in winget `Gyan.FFmpeg`. | `opc-monitor/src/webcam.rs` | MISSING | R | Fix D8 by shipping `ffmpeg.exe`, or capture through Media Foundation. |
| T2 | **Swipes**: 64×48 grey frame differencing (pixel delta 28, 1.2–45 % motion, ≥30 % travel, dominance 1.8, 0.7 s window, 1.2 s cooldown, ≥4 samples). The picture is mirrored. | `gesture.rs` | MISSING | R | |
| T3 | **Hand poses**: skin in YCbCr, biggest hand-sized blob (1.5–22 %), finger rays; Fist / Point / Two / Palm held for 1 s, 0.6 s release | `hand.rs` | MISSING | R | |
| T4 | **Mapping**: swipe up or fist recentres; swipe down or "two" flips; palm stops (programmed move, tracking, `GimbalTimedStop`); left/right/point step through saved presets. Notices: "GESTURE: RECENTRE", "HAND: STOP", "NO PRESETS SAVED". Viewfinder only. | `shell.rs` `gesture` | MISSING | R (+ W notices) | |
| T5 | **Enable**: home setting, `--gestures`, or `OPC_GESTURES=1`; read when the viewfinder opens | `main.rs`, `appsettings.rs` | MISSING | R + W | With one process, toggling it should start/stop capture live. |

### 1.U Media library

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| U1 | **Library** (`G` or gallery button) over the picture: **Device** / **Local**; All · Photos · Videos · Favorites; sort Newest · Oldest · Name · Rating; Refresh (`R`); day headers (Today, then the date); download mark until the original is on disk; clip length; favourite star; no file names on the grid | `library.rs`, `opc-media/query.rs`, `hud.slint` | PARTIAL `features/media/MediaLibraryScreen.tsx`, `MediaGallery.tsx` (sorts newest/oldest/largest/longest, no Device/Local split) | W + R | |
| U2 | **Selection bar**: name, duration, size, resolution. **PLAY** fetches the 720p `.LRF` proxy to the cache (original as fallback). **VIEW** for a still. **DOWNLOAD** fetches the original with progress. **STAR** is local, and goes to the camera when the record has a handle. **DELETE** arms on the first tap and sends on the second; only core-vouched handles; otherwise greyed. | `library.rs`, `media.rs`, `opc-media/worker.rs` | PARTIAL: star/delete YES; **download MISSING**, **thumbnails/preview MISSING** (`NativeCameraSession.media.download` throws; `mediaMap.ts` leaves URLs empty) | R + W | |
| U3 | **Select mode**: check circles, footer count, **Delete selected** (arm, then send one delete per vouched handle), **Done** | `library.rs` | YES `MediaGallery.tsx`, `dragSelection.ts` | W + R | |
| U4 | **Bursts** folded under the first frame with a ×N badge; **Expand ×N** / **Fold burst**; in select mode a folded burst checks as its lead | `library.rs` (core `burstRegex`) | YES `MediaCell.tsx`, "Stack bursts" | W | |
| U5 | **Listing sequence**: playback entry `0x02/0x0C` × 3 (0.9 s); Pocket 3 `0x01/0x01` at 20 Hz fallback (3 s); 1.7 s mount settle; internal store, trigger, card; collect until 0.8 s quiet; walk older pages while playback holds; 8 s page cap; single-card rule; the core decodes every page. The **list and stars are cached per camera**, so the library opens instantly next time. | `opc-media/browse.rs`, `chunks.rs`, `cache.rs` | PARTIAL `NativeCameraSession.media.list` (newest page per store only) | R | |
| U6 | **Leaving the library**: exit playback until the bit clears (0.6 s period, ≤8 attempts), then live view | `media.rs` `Resume`, `opc-media/resume.rs` | YES `media.resumeLive` | R | |
| U7 | Watchdog repairs held while the library or player is open | `view.rs` `sync_repair_blocked` | PARTIAL | R | |
| U8 | **Cache**: `<cache>/OpenPocketCine/media/<camera>/{thumbs,files,play,index.json,favorites.json}`. Storage tab shows the size and offers **Clear**, and names the LUT folder. | `opc-media/cache.rs`, `sheets.rs` `storage_rows` | PARTIAL `features/settings/sections/StorageSection.tsx` (Clear Cache) | R + W | Thumbnails served to W by a custom protocol (§3.5). |
| U9 | Thumbnails over `/v2?storage=N&path=…` on port 80, decoded with zune-jpeg on the media worker | `opc-media/http.rs`, `thumbs.rs`, `worker.rs` | MISSING | R | |

### 1.V Player

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| V1 | **Player** plays the proxy **through the feed pipeline**, so LUT, zebra, peaking and mirror work as on live. Page: back, info (name and figures), rendition title "Low-Res", download, time pill, **8-frame filmstrip scrubber** with playhead, Screenshot (`S`, graded), LUT/Zebra/Peaking toggles, conform chip, heart · pause · trash (arm/confirm). `Space` pauses, `Esc` goes back. A still is converted to 4:2:0 and graded. Playback is from disk only (`moov` at the end). | `media.rs`, `library.rs` `Player`, `opc-decode` `FileReader` | PARTIAL `features/media/PlaybackScreen.tsx` uses `expo-video`. An HTML `<video>` cannot pass through the Vulkan grade. | R (FileReader) + N (same pipeline) + W (controls) | Do **not** use a web `<video>` for the desktop player (§2.2). |
| V2 | **Sound**: cpal default output, 48 kHz preferred, interleaved stereo resampled, sent **80 ms ahead** of the picture, frames behind the clock dropped after a scrub, pause holds the device, seek clears it, silent at conform speeds, ≤2 s queued | `audio.rs`, `media.rs` `AUDIO_LEAD_MS` | YES (expo-video audio) | R | |
| V3 | **Conform preview**: the chip cycles the core's targets (`Conform → 120 → 24 → …`) and the clock runs at `opc_conform_speed`; greyed with nothing to conform to; reset when a clip opens | `shell.rs` `PlayerConform`, `library.rs` | YES `PlaybackScreen.tsx` `conformTargets` | R + W | |
| V4 | Look-ahead of 8 decoded frames; frame threading for files | `media.rs` `LOOKAHEAD`, `opc_decode.c` `thread_count = 0` | N/A | R | |

### 1.W Virtual camera (Output tab)

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| W1 | **Virtual camera** Off / **Camera device** / **Stream**. **Camera picture**: Clean (LUT kept; zebra, peaking and false colour off) or As shown. 1280×720, letterboxed, no chrome, ≤30 fps. Fed from the viewfinder and the player, never the library. **Camera output** readout refreshed every 1 s. | `opc-vcam/src/lib.rs`, `view.rs` `reconcile_vcam`, `feed_vcam`, `sheets.rs` `output_rows` | N/A | R + N | Fix D4 (a dedicated vcam target). |
| W2 | **Camera component**: status, **Install** / **Remove**, **Detail**. Windows 11 22H2+ (build ≥22621) registers `opc_vcam_win.dll` with an elevated `regsvr32` and reads it back from HKLM, noting a missing DLL; Windows 10 reports "not available". Linux uses `v4l2loopback` through `pkexec` with persistence, or shows the manual line. macOS opens `/Applications/OpenPocketCine Camera.app`. Probed at start and after each action, off the window thread. A top-bar notice appears when Camera device is picked without the component. The camera restarts after an install. | `opc-vcam/src/install.rs`, `view.rs` `start_component_job` | N/A | R + W | |
| W3 | **Windows source**: NV12 over `\\.\pipe\OpenPocketCineVCam` (wire `OPCV`, 16-byte header). The source paces 30 fps and shows black when idle. | `opc-vcam/src/win.rs`, `wire.rs`, `opc-vcam-win/*` | N/A | Keep | |
| W4 | **Stream**: MJPEG on `127.0.0.1:8890` (`vcam_port`): `/stream` (multipart), `/frame.jpg`, `/` page; JPEG q85; **Open in the browser**; OBS recipe | `opc-vcam/src/stream.rs` | N/A | R + W | |
| W5 | **macOS camera extension** and host app (XcodeGen project) | `Apps/Desktop/macos/*`, `DesktopVirtualCameraABI.swift` | N/A | Keep (move the folder) | |
| W6 | **Latest-wins** frame slot on a worker thread | `opc-vcam/src/lib.rs` | N/A | R | |

### 1.X Persisted state (all must survive the port, with migration)

| # | File / store | Contents | Desktop | Mobile equivalent | Port |
| --- | --- | --- | --- | --- | --- |
| X1 | `%LOCALAPPDATA%\OpenPocketCine\desktop-prefs.txt` | `audio_channel, vocal_boost, fov, gimbal_speed, timecode, ramp, countdown_seconds, stick_sensitivity, gamepad, show_exposure, show_status, show_zoom, show_pad, show_modes, vcam, vcam_clean, vcam_port, shutter_angle` | `prefs.rs`, `sheets::Prefs` | PARTIAL `state/preferences.ts` (`pm.preferences.v1`) | R owns it; W reads and writes through commands |
| X2 | same file, assist lines | `zebra, peaking, mirror, false_color, grid, guides, cross, wave, parade, histo, vector, lights, nd, audio, false_color_scale, false_color_reference, peaking_color, peaking_sense, zebra_ire_units, zebra_highlight_{on,ire,color}, zebra_midtone_{on,ire,color}, grid_{thirds,phi,diagonal}, guide_family, guide_bits, guide_mask, wave_mode, wave_guide_{clip,crush,middle}, parade_mode, vector_gain, brightness, lights_compensation, nd_notation, lut` | `prefs.rs` `Saved` | PARTIAL `state/assists.ts` | R |
| X3 | `desktop-app-v1.txt` | `gestures, open_camera_at_launch` | `appsettings.rs` | MISSING | R |
| X4 | `desktop-gimbal-presets-v1.txt` | `seconds`, `slot1..6=yaw,pitch,native_pitch` (unreachable poses dropped; seconds clamped 0.5–25) | `presets.rs` | MISSING | R |
| X5 | `desktop-camera-v1.txt` | SoftAP SSID and model | `main.rs` | PARTIAL `state/savedCameras.ts` | R |
| X6 | `desktop-station-v1` | SSID, identity, last address, model | `homewifi.rs` | PARTIAL | R |
| X7 | `desktop-lan-camera-v1.txt` | IP and model | `main.rs` `lan_camera` | MISSING | R |
| X8 | Media cache `index.json`, `favorites.json` per camera | Last list, local stars | `opc-media/cache.rs` | PARTIAL `state/media.ts` | R |
| X9 | Windows WLAN profiles | Camera SSID and password, owned by the OS | `netsh` | N/A | R |
| X10 | LUT drop folder `…\OpenPocketCine\luts` | Operator cubes | `luts.rs` | PARTIAL (document picker) | R |

### 1.Y Diagnostics and logs

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| Y1 | **`opc-monitor.log`** beside the exe. Lines: `opc-monitor starting`, `args:`, `PANIC:` (panic hook), `wifi: …`, `station: …`, `link: starting UDP session…`, `link: UDP socket bound local_port= remote= phase= TCP-7001=`, `link: camera accepted session`, `link: received first raw video datagram`, `link: received first picture (N bytes)`, `link: access unit #n bytes= head=` (first 3), **`link: transport: ack=X/s max_gap=Yms video= au= status= cursors=a/b/c last_video=`** (1 Hz), **`link: video rate: X access-units/s, Y KiB/s`** (1 Hz), `link: feed watchdog: <rung> …`, `link: Pocket 3 first-picture format poke`, `link: reconnect attempt n`, `view: created <codec> decoder`, `view: decoded first picture WxH keyframe=`, **`view: pace: decoded N shown N skipped N queued N`** (1 Hz), **`view: slow: draw took X ms, Y ms since the last draw`** (draw >40 ms or gap >100 ms), `view: decoder failed: …`. No credentials or payloads are ever logged. | `main.rs`, `link.rs`, `view.rs`, `station.rs` | PARTIAL `features/settings/diagnostics.ts` (different content) | R | Move to `%LOCALAPPDATA%\OpenPocketCine\logs\` and keep beside-exe for portable (D3). Keep every line format, because the benchmark parses them (§4). |
| Y2 | **Diagnostics report** (System → Write a report): `diagnostics-<unix>.txt` beside the LUT folder with `Shell::diagnostics_text` and the decoder codec; "DIAGNOSTICS WRITTEN TO THE CACHE FOLDER" | `view.rs` `write_diagnostics` | YES `features/settings/ProblemReportSheet.tsx`, `useShareDiagnostics.ts` | R + W | |
| Y3 | **Link tab**: transport and address, link phase, body and firmware, last recovery, Reconnect, phone lease | `sheets.rs` `link_rows` | YES `ConnectionSection.tsx`, `LinkHealthScale.tsx` | W + R | |
| Y4 | **System tab**: app version, "OpenPocketViewCore through the desktop facade", renderer (Vulkan device name), licences (Apache 2.0 · THIRD-PARTY-NOTICES.md), source URL | `sheets.rs` `system_rows` | PARTIAL `AboutSection.tsx`, `legal.ts` | W + R (`renderer_info`) | |
| Y5 | stdout lines: "drawing on <device>", "Wrote <path>", errors | `view.rs` | N/A | R (to the log) | |

### 1.Z Build, installer, release

| # | Feature | Desktop | Mobile today | Port home | Notes |
| --- | --- | --- | --- | --- | --- |
| Z1 | **`build-debug.ps1`** (`--profile debug-camera`, opt-level 2, `-StopRunning`) and **`build-release.ps1`** (`--release`, `-StopRunning`). The release build ships the Swift facade's debug ABI (D10). Staging copies `OpenPocketCineDesktop.dll`, the Swift runtime DLLs, `mimalloc.dll` + `mimalloc-redirect.dll`, the FFmpeg `bin\*.dll` (stale majors removed) and `FFmpeg-LICENSE.txt`. The Vulkan SDK is required. | `Apps/Desktop/build-*.ps1` | N/A | T (`beforeBuildCommand` / a wrapper script) | Every DLL must sit beside the exe. |
| Z2 | **LGPL FFmpeg gate**: `ffmpeg -buildconf` must not contain `--enable-gpl` or `--enable-nonfree` | `build-release.ps1` l.61–63 | N/A | T (keep in the wrapper) | |
| Z3 | **Installer** (Inno Setup 6). AppId `{6F0B4C1E-8D7A-4F3B-9C2E-5A1D7E9B3C41}`, `{autopf}\OpenPocketCine`, admin, x64, `MinVersion=10.0.19041`. `opc_vcam_win.dll` uses `regserver noregerror` (registered on install, unregistered on uninstall). Start-menu entry, optional desktop shortcut (both launch `opc-monitor.exe`, which opens the **home screen**), post-install launch, `CloseApplications=yes`. Settings and cache survive an uninstall. | `installer/OpenPocketCine.iss`, `build-installer.ps1` | N/A | T | **Keep Inno and the same AppId** so existing installs upgrade in place (§3.8 R12). Add the WebView2 bootstrapper. |
| Z4 | **Portable ZIP** `PocketMonitor-<v>-windows-x64.zip` (exe, DLLs, ico, LICENSE, NOTICE, THIRD-PARTY-NOTICES, FFmpeg licence), **`SHA256SUMS.txt`**, FFmpeg source zip and provenance when present; `-PortableOnly`, `-NoBuild` | `build-release-assets.ps1` | N/A | T | The portable build now needs the WebView2 runtime present (§3.8 R8). |
| Z5 | Unsigned (SmartScreen page expected) | `DESKTOP.md` | N/A | T | |
| Z6 | `just desktop-core/desktop-build/desktop-test/desktop-check`, `desktop-check-gated`, CI `desktop` job, `build-swift-core.bat` | `justfile` | N/A | T | Add a Tauri build plus the web export to `desktop-check`. |

---

## 2. Performance inventory

### 2.1 Mechanisms, the metric each protects, and how the port keeps it

| # | Mechanism (number) | Where | Metric protected | Port preservation |
| --- | --- | --- | --- | --- |
| P1 | **Camera datalink on its own OS thread** `opc-camera`. Non-blocking UDP; the loop `yield_now()`s when idle. A blocking receive timeout was rejected because Windows rounds it to the scheduler quantum: *"a nominal 40 Hz ACK pump reach[ed] the Pocket at only 31 Hz"*. | `link.rs`, `session.rs` `open_socket` | ACK cadence, and therefore the picture | Unchanged `Link`/`CameraSession`, owned by the Tauri backend. **Never** on the Tauri main thread, an async runtime worker, or JS. |
| P2 | **40 Hz window ACK** (`ACK_INTERVAL = 1/40`), three cursor groups, never bursts a backlog after a stall | `opc-camera/sequence.rs`, `transport.rs` `AckPump` | Video keeps flowing (group 0), command replies keep flowing (group 1) | Unchanged |
| P3 | **Bounded drain**: ≤8 datagrams per poll, 4 KiB reads, so inbound bursts cannot starve the ACK | `session.rs` `MAX_DATAGRAMS_PER_POLL`, `READ_BUFFER` | ACK `max_gap` | Unchanged |
| P4 | **All UDP writes serialised on the camera thread** (commands go through an mpsc channel) | `link.rs` `ToCamera` | ACK not starved (the iOS lesson) | IPC commands enqueue onto the same channel; nothing writes the socket from a Tauri handler |
| P5 | App presence every 1 s; TCP 7001 poke kept for the session | `session.rs` | The encoder lease | Unchanged |
| P6 | **SET mailbox**: latest wins per opcode; 300 ms retransmit; 2 s settle; zoom slider pipelined at 20 Hz | `mailbox.rs` | Control latency without wire floods | Unchanged. The web side may send at any rate; Rust coalesces. |
| P7 | **Gimbal stick**: keys send on change plus a 200 ms keepalive; the ramp steps at 25 Hz; the controller is polled per frame (~60 Hz) and sends on change | `shell.rs` `STICK_REPEAT`, `ramp_step`, `view.rs` `poll_pad` | Input-to-motion latency; immediate rest | Moves into the Rust controller on a **dedicated 100 Hz input tick thread** (not the render loop). JS posts targets; Rust streams and rests. See §3.6 for the heartbeat-loss rest. |
| P8 | **Watchdog timings**: 2 s stall; 8 s GOP grace after enable; 4 s after AF-C, zoom or a tracked SET; 5 s between enables; 60 s UDP rebuild backoff; repairs blocked off the viewfinder | Core `FeedWatchdog` via `opc-camera/watchdog.rs`, `health.rs` | No false repairs; bounded recovery | Unchanged. The **presented** signal must come from the render thread's real `vkQueuePresentKHR` success, not from the webview. |
| P9 | **Power throttling off** plus `timeBeginPeriod(1)` | `main.rs` `keep_timers_fast` | An unfocused window is not throttled (Windows 11 otherwise froze the picture for most of a second) | Call first thing in the Tauri `main`. **Also** disable WebView2 background throttling (§3.8 R5). |
| P10 | **Decoder settings**: libavcodec software decode, `AV_CODEC_FLAG_LOW_DELAY`, `FF_THREAD_SLICE` (no frame-thread delay), `has_b_frames = 0`; files use frame threading (`thread_count = 0`) | `opc-decode/csrc/opc_decode.c` | Decode latency ≤ one frame | Unchanged. Optional later: D3D11VA hwaccel, gated by the benchmark. |
| P11 | **Decode runs on the window thread** inside `draw()` (pump, then decode, then present) | `view.rs` `draw` | — (today's cost) | **Improve**: a dedicated decode thread hands pictures to the render thread through a latest-wins queue. This removes the coupling between UI events and decode. |
| P12 | **Frame policy**: a backlog over **30 AUs** skips to the newest keyframe and flushes (never thins predicted frames). Over **3 decoded** pictures waiting, drop the oldest. One picture per redraw. 1 Hz `pace:` log. | `view.rs` `BACKLOG_LIMIT`, `READY_LIMIT` | Latency bound with no corruption | Same numbers in the decode→render handoff |
| P13 | **Keyframe check reads only the first coded slice NAL** | `view.rs` `is_keyframe` | CPU per AU | Unchanged |
| P14 | **Zero-copy live present**: borrow `latest`, clone only when the vcam runs. But `OwnedPicture::copy_from` packs every decoded frame, and `stage_planes` repacks again: **two CPU copies per frame** (≈2.8 MB per 720p frame) | `view.rs` `draw`, `opc-decode` `copy_from`, `renderer.rs` `stage_planes` | Memory bandwidth on iGPUs | Keep the borrow. **Improve**: write planes directly into a persistently mapped staging ring (`live-session.md` names a per-frame ring as the future optimisation). |
| P15 | **Redraw cadence**: `ControlFlow::WaitUntil(now + 16 ms)` while a picture exists; `Wait` with none; the idle placeholder is not resubmitted | `view.rs` `about_to_wait` | ~60 Hz present loop, idle CPU near zero | The render thread waits on "new picture or 16 ms", independent of the webview's `requestAnimationFrame`. |
| P16 | **Vulkan present**: **MAILBOX → IMMEDIATE → FIFO**; **`FRAMES_IN_FLIGHT = 1`** with a fence instead of a device-wide idle (costly on integrated AMD GPUs); one render-finished semaphore per swapchain image; descriptors rewritten only when a binding changes | `opc-render/src/present.rs`, `renderer.rs` | Freshest-frame latency; no stalls | Unchanged on the child surface. Measure whether DWM composition with WebView2 adds a frame (§3.8 R2). |
| P17 | **Shared staging buffers are overwritten only after the fence** (the bottom-edge corruption rule) | `renderer.rs` `present` → `begin` → `stage` | Picture integrity | Unchanged |
| P18 | **Pass order and filtering**: convert → peaking → cube at source raster → **Catmull-Rom** stretch when upscaling (`blit` constant 10) → overlay with a nearest sampler; RGBA32F 3D cube; built-ins at 33³; disabled assists bound to 1×1 textures with zeroed flags | `renderer.rs`, `shaders/*.frag` | Image correctness (D-Log2 blotching) and sharpness | Unchanged. The overlay pass can stay for native-only overlays or be skipped. |
| P19 | **Software chrome rate limits**: Slint renders full-window RGBA **only when stale**; status-driven redraws are capped at **4 Hz** (0.25 s; the Pocket 3 pushes status at about the video rate); the countdown redraws once per second; the ramp at 25 Hz. The overlay is uploaded only on change, but `set_overlay` does a **whole-buffer compare every frame** (3.7 MB at 720p) and clones on change. | `shell.rs` `next_status_chrome_at`, `chrome()`, `renderer.rs` `set_overlay`, `stage_overlay` | CPU/GPU headroom on iGPUs | **Retired** with Slint. The replacement budget: Rust emits status to the web at **≤5 Hz** (`LiveChromeThrottle`, `PERFORMANCE.md`), with immediate fields (REC, format, colour, zoom) bypassing the throttle. The web must not re-render per video frame. |
| P20 | **Scopes sampled on the CPU at 15 Hz** from the latest decoded picture, on the window thread, only while a scope is on | `view.rs` `sample_scopes`, `scopes.rs` | Live fps with scopes on | Move to a **scope thread** fed with the latest picture by reference count (no copy); emit compact binary at ≤15 Hz (§3.5). Mobile budget for comparison: 25 Hz with 1–2 scopes, 10 Hz with 3+. |
| P21 | **Virtual camera ≤30 fps**, latest-wins slot, worker thread; GPU readback via `render()` (with `device_wait_idle` and the D4 target thrash) | `view.rs` `feed_vcam`, `opc-vcam` | Live fps while the vcam runs | Separate 1280×720 vcam targets and a fence-based async readback (no device idle). This is the one place the port must **beat** the baseline. |
| P22 | **Slow-frame detector**: log when a draw takes >40 ms or the gap exceeds 100 ms | `view.rs` `RedrawRequested` | Detecting regressions in the field | Keep on the render thread; add a web-side long-task logger (§4.1). |
| P23 | **`debug-camera` profile** at opt-level 2 (an unoptimised 720p path falls to single-digit fps) | `Cargo.toml` | A meaningful debug build | Keep for the Tauri Rust crate |
| P24 | **Media worker thread** (HTTP via ureq, zune-jpeg thumbnails) | `opc-media/worker.rs` | UI never blocks on HTTP | Unchanged; results become events or custom-protocol responses |
| P25 | **Audio** on the cpal callback thread, 80 ms lead, ≤2 s queue | `audio.rs` | A/V sync in the player | Unchanged |
| P26 | **Webcam gestures** in an `ffmpeg` child process plus a thread, 15 fps at tiny sizes | `webcam.rs` | No cost to the live path | Unchanged |
| P27 | **Component probe/install** on its own thread | `view.rs` `start_component_job` | No window stall during UAC | Unchanged |
| P28 | **No explicit OS thread priorities anywhere** (only P9) | grep of `crates/` | — | Same by default. Optional, measured: `THREAD_PRIORITY_ABOVE_NORMAL` for the camera and render threads (mobile Android runs its ACK thread at `URGENT_DISPLAY`). |
| P29 | **Measured numbers on record**: blocking-timeout ACK reached 31 Hz (now fixed); Pocket/Nano SoftAP live is ~25 fps 720p; Pocket 3 status arrives at about the video rate; Mimo echoes `0x03` into group 1 at ~21 Hz; Pocket 3 physical: handshake, telemetry, AVC decode and Vulkan display work | `session.rs`, `PERFORMANCE.md`, `live-session.md`, `desktop-ui-handoff.md` | — | Baseline to be re-measured (§4.2) |

### 2.2 Routing video through the web view: what regresses

Some alternatives would put the live picture inside WebView2. Examples: sending decoded frames
over IPC, sending encoded AUs to WebCodecs, or a `<video>` element for playback. **Each
regresses a protected metric. None is acceptable for the live picture or the player.**

| Path | What breaks | Numbers |
| --- | --- | --- |
| Decoded frames over IPC to a WebGL canvas | Memory bandwidth and CPU: serialise, copy into the webview process, copy into a GL texture. Tauri IPC is cross-process (WebView2 renderer process). | 720p I420 = 1,382,400 B per frame: **34.6 MB/s at 25 fps, 69 MB/s at 50 fps**. RGBA is 92 MB/s at 25 fps. Base64 or JSON adds another 33 % plus encode time. Today the same frame costs one staging write. |
| Encoded AUs to WebCodecs `VideoDecoder` + WebGL2 | **HEVC support in WebView2 depends on hardware and the HEVC Video Extensions**; Pocket 4/4 Pro send HEVC (`live-session.md`), so the picture would be missing on many PCs. The decoder lives in another process, which the watchdog's "presented frames" rule cannot see directly. Two decoders run when the vcam is on, because the vcam needs frames in Rust. | +1 IPC hop and +1 process boundary per AU; GPU→JS readback for scopes |
| Presenting from `requestAnimationFrame` | **No MAILBOX**: rAF is tied to the compositor (FIFO-like); presents queue behind DOM work; garbage-collection pauses stall the picture. **Background throttling** of an unfocused or occluded webview drops rAF to 1 Hz or 0. That is exactly the P9 failure the desktop fixed. | P16 and P9 regress |
| `<video>` for the player (`expo-video` on web) | The proxy cannot pass through the Vulkan grade, so LUT, zebra, peaking, false colour, mirror, Auto LUT and the graded screenshot (V1) are lost or need a second WebGL implementation. The filmstrip and conform speed would need re-implementation. HEVC originals hit the same codec problem. | V1–V3 regress |
| Chrome or scopes rasterised in Rust and shipped as bitmaps | Keeps today's software-chrome cost **and** adds IPC. | Full-window RGBA 3.7 MB per update |

**Conclusion.** The picture, the playback picture, stills and the vcam feed stay native (N).
The webview carries chrome and controls only, at chrome rates.

---

## 3. Recommended Tauri architecture

### 3.1 Topology

```
┌──────────────────────── Tauri main window (tao HWND / NSWindow) ────────────────────────┐
│  WebView2 / WKWebView  (transparent background, top of z-order)                           │
│    Expo web export of Apps/Mobile  →  DesktopCameraSession (Tauri IPC)                    │
│    React draws: chrome, sheets, grids/guides/tracking box/reticle, scopes, library UI     │
│    <LivePicture> on desktop = a transparent "hole" that reports its rect                  │
│ ─────────────────────────────────────────────────────────────────────────────────────────│
│  Native picture surface (child HWND / NSView+CAMetalLayer), BELOW the webview             │
│    Vulkan swapchain (MAILBOX), opc-render feed pipeline, letterbox                        │
└───────────────────────────────────────────────────────────────────────────────────────────┘
Rust backend threads (one process):
  main/tao ── IPC dispatch, window events (focus/close/resize/DPI) ── never blocks
  opc-camera ── UDP + 40 Hz ACK + mailbox + watchdog      (existing Link, unchanged)
  opc-decode ── AU → OwnedPicture (latest-wins → render)   (moved out of the window loop)
  opc-render ── owns VkDevice/swapchain; present on new picture or 16 ms; notes "presented"
  opc-input  ── 100 Hz: stick stream/rest, ramp, gilrs pad, move engine, presets follow-up
  opc-scopes ── 15 Hz sample of the latest picture → binary channel
  opc-vcam / opc-media / opc-component / phone relay / BLE tokio / webcam ffmpeg / cpal
```

### 3.2 The native picture layer, per platform

**Windows (primary). Prototype both A and B in week 1.**

- **A. Swapchain on a dedicated child HWND below the WebView2 controller.** Create it with
  `CreateWindowExW(WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS)` under `WebviewWindow::hwnd()`,
  sized to the client area in physical pixels. Place it at `HWND_BOTTOM` and make it
  transparent to hit-testing (`WM_NCHITTEST → HTTRANSPARENT`), so all input reaches
  WebView2. Create the WebView2 with `transparent: true` (wry sets `DefaultBackgroundColor`
  alpha 0). `FeedRenderer::for_window(display, raw_window, w, h)` already takes raw handles,
  so no renderer change is needed.
- **B. Swapchain on the top-level HWND itself**, with the transparent WebView2 child on top.
  This is the pattern people use for wgpu under Tauri. It is fewer windows, but resize
  ordering is tied to tao.
- **C. Fallback if A and B show tearing, flicker or a white flash.** Use DirectComposition.
  Render into an exportable Vulkan image shared to D3D11
  (`VK_KHR_external_memory_win32` + keyed mutex), present through
  `IDXGISwapChain1::CreateSwapChainForComposition` in a DComp visual beneath a WebView2
  **CompositionController** visual. This is the most robust option, but wry uses windowed
  hosting, so it needs a custom WebView2 host or a wry patch.
- **D. Last resort.** A borderless native window kept glued under a layered transparent
  webview window. Rejected unless A–C fail: there are focus, Alt-Tab and fullscreen problems.

**macOS.** An `NSView` with a `CAMetalLayer` (MoltenVK, `VK_EXT_metal_surface`) inserted
below the `WKWebView` in the window's content view. The `WKWebView` gets
`drawsBackground = false`; Tauri needs `macOSPrivateApi: true` and `transparent: true`. The
camera extension (W5) is unchanged.

**Linux.** WebKitGTK transparency over a native child is unreliable. Treat it as best effort
(the Wayland subsurface or X11 child approach), and keep the v4l2loopback and MJPEG paths.
Windows is the product.

**DPI.** All native sizes are physical pixels. The web reports CSS pixels × `devicePixelRatio`.
Rust computes the letterbox (`opc_render::letterbox`) once and returns it to the web in CSS
pixels, so React overlays (tracking box, guides, reticle, grids) and Rust hit-mapping share
one rectangle (F3).

### 3.3 Threads and ownership rules

1. The tao main thread does IPC dispatch and window events only. A Tauri command handler
   never touches the socket, the decoder or Vulkan. It enqueues onto that thread's channel and
   returns. Rule for every handler: **no blocking**, so use `async` commands for HTTP, BLE,
   Wi-Fi and installs.
2. The `opc-render` thread owns the `FeedRenderer`. It receives: pictures from decode (latest
   wins), `RenderState` (effects, LUT handles, false-colour cubes, mirror, fit mode) through an
   `ArcSwap`, and resize/DPI/visibility from the main thread. It sends `note_presented` to
   `Link` and `media.note_presented` for playback, as today.
3. `opc-input` at 100 Hz owns everything time-critical that today hangs off `Shell::tick` and
   `poll_pad`: the stick keepalive (200 ms), the ramp (25 Hz), the controller axes, the
   tracking poll (0.5 s) and push silence (0.35 s), the tap-focus ACK wait (0.4 s), format
   pin expiry (2 s), countdown firing, the programmed-move engine (the **40 ms late abort**
   needs this thread, not the webview), and the preset two-step follow-up.

### 3.4 Crates: reuse, refactor, retire

| Crate / module | Action |
| --- | --- |
| `opc-core-sys`, `opc-camera`, `opc-relay`, `opc-decode`, `opc-media`, `opc-vcam`, `opc-vcam-win`, `opc-watcher`, `macos/` | **Reuse as is.** |
| `opc-render` | Reuse. Add: separate vcam targets and async readback (D4/P21); `feed.frag` support for `lutIntensity`, `lutExposureStops`, `split`/`split_vertical`, `desqueeze`, `monochrome`, `mirrorVertical`, `sourceColor` display transform (N9, N10); an option to skip the overlay pass. |
| `opc-monitor` **logic** (`zoom.rs`, `moves.rs`, `presets.rs`, `pad.rs`, `gesture.rs`, `hand.rs`, `homewifi.rs`, `prefs.rs`, `appsettings.rs`, `luts.rs`, `assists.rs` options, `scopes.rs` sampling, `phone.rs`, `library.rs` state, and the **decisions** in `shell.rs`) | Move to a new library crate, **`opc-controller`**. `Shell` minus `chrome()`, `chrome_renderer`, the `ChromeIntent` plumbing and the sheet-row builders becomes `Controller`: inputs (keys, pointer in picture-normalised coordinates, pad, gestures, ticks, camera events) in, `Intent`s and a **state snapshot** out. Port `tests/shell.rs` (2,082 lines) and `tests/viewfinder.rs` to it. Those tests are the behaviour spec. |
| `opc-monitor` **binary modules** (`link.rs`, `media.rs`, `audio.rs`, `station.rs`, `ble_impl.rs`, `webcam.rs`, the BLE worker in `connect.rs`, the Wi-Fi join and launch chain in `main.rs`) | Move into the Tauri app crate (`Apps/Desktop/src-tauri` or a new `Apps/DesktopTauri`) as backend services. |
| `view.rs` | Becomes `render_host.rs` (render thread) plus `decode_host.rs`. `winit` goes. |
| `sheets.rs` | **Split.** Row *content* moves to the web settings sections. Row *logic* (Kelvin keeps tint, format pick keeps the rate, gimbal-mode commands, the DSP blob patch, preset picks) becomes controller commands. |
| `opc-chrome` (Slint, `hud.slint`, Outfit fonts, Tabler icons), `opc-ui` `font.rs`/`canvas.rs`/`hud.rs`, `home.rs`/`connect.rs` egui UI, `demo.rs` window, deps `winit`, `eframe`, `egui`, `slint` | **Retire.** Keep `opc-ui` `controls.rs` (Key/Stick/Countdown/RampFilter), `format.rs` and `tracking.rs`, or fold them into `opc-controller`. |

**Protocol authority.** On desktop, wire bytes and camera decisions stay in the Swift core via
`opc-core-sys`. That is the path physically proven on the Pocket 3. The mobile TS core
(`src/core`) is not used for the live session on desktop. The web reuses `src/core` only for
**UI vocabulary mapping** (wire codes → `ColorMode`, labels, ladders display) so labels match
mobile. This is a conscious two-core situation (Swift for desktop/iOS, TS for mobile RN). Cover
the drift risk with the cross-checks in §4.3.

### 3.5 IPC surface

Transport choices:

- JSON commands for control.
- `tauri::ipc::Channel` with raw `Vec<u8>` for binary streams.
- `emit` events for state.
- A custom async URI scheme `pm://` for files: thumbnails, filmstrip frames, local stills.
  Use `register_asynchronous_uri_scheme_protocol` so `<img src="pm://thumb/<camera>/<path>">`
  never crosses JSON.

**Commands (web → Rust)**

| Command | Args | Expected rate | Backed by |
| --- | --- | --- | --- |
| `launch_args` | — | once | argv parse (B1–B8) |
| `known_cameras`, `forget_camera`, `probe_camera` | id / ip | on demand | `main.rs` files, `home.rs` probe |
| `ble_scan_start` / `ble_scan_stop` / `ble_pair` / `ble_cancel` | id | on demand | `connect.rs` worker, `ble_impl.rs` |
| `wifi_join_camera` / `wifi_join_saved` | ssid, password (never logged) | on demand | `join_camera_wifi` |
| `station_join` / `station_reset` / `station_find` | ssid, password, model | on demand | `station.rs` |
| `camera_connect` / `camera_disconnect` / `camera_reconnect` | target | on demand | `Link::open`, `reconnect` |
| `camera_command` | typed `Command` enum (serde) | ≤ input rate; the mailbox coalesces | `Link::send` |
| `control_key` | key, down/up, repeat flag | per key event | `Controller::press/release` |
| `gimbal_drive` | x, y in −1…1, source (`keys`/`pad`/`touch`), seq | ≤ 60 Hz while held, **plus a 100 ms heartbeat** | `opc-input` |
| `gimbal_release` | source | on release | immediate rest |
| `zoom_write` | jump / slider value | slider ≤ 60 Hz (Rust pipelines at 20 Hz) | `zoom.rs` |
| `picture_pointer` | phase, id, pointerType, x/y in CSS px of the picture hole | per pointer event | `Controller::touch/pointer_*` (K1–K3) |
| `picture_layout` | rect (CSS px), dpr, fit/fill | on layout change | render thread resize + letterbox |
| `picture_set_effects` | `PictureEffects` (mobile contract) + desktop extras | on change only | `RenderState` swap (§3.7) |
| `lut_list` / `lut_load` / `lut_select` | id / file / built-in | on demand | `luts.rs`, `Lut::parse/built_in` |
| `scopes_configure` | which plates, options | on change | scope thread |
| `still_capture` | — | on demand | render thread `render` + `write_png` |
| `moves_*`, `preset_save/go/clear/seconds` | slot, seconds | on demand | `moves.rs`, `presets.rs` |
| `media_*` (`list`, `refresh`, `select`, `play`, `view`, `download`, `favorite`, `delete`, `delete_checked`, `close`, `resume_live`) | file ids | on demand | `media.rs`, `opc-media` |
| `player_*` (`toggle`, `seek`, `speed`, `conform_next`, `screenshot`, `close`) | position | seek ≤ 30 Hz while scrubbing | `media.rs` `FileReader` |
| `vcam_set` / `vcam_component_probe/install/remove` / `open_url` | backend, clean, port | on demand | `opc-vcam` |
| `relay_browse` / `relay_join` / `relay_control` | name, passcode, want | on demand | `opc-relay`, `phone.rs` |
| `prefs_get` / `prefs_set`, `app_settings_get/set` | key, value | on change | `prefs.rs`, `appsettings.rs` (X1–X4) |
| `diagnostics_write`, `log_tail` | — | on demand | Y1, Y2 |
| `window_fullscreen` | bool | on demand | Tauri window API |

**Events and channels (Rust → web)**

| Name | Payload | Rate cap | Note |
| --- | --- | --- | --- |
| `camera://state` | `CameraState` patch (mobile `types.ts` shape, built in Rust from `Status`) | **5 Hz** coalesced; immediate for REC, phase, format, colour, zoom, mode, battery-critical | Mirrors `LiveChromeThrottle`. Replaces the 4 Hz Slint cap. |
| `camera://event` | notices, set outcomes ("no answer from the camera"), photo captured, recording started/stopped | on occurrence | |
| `tracking://box` | sensor-space box, lock state, mirror flag, committed-until | ≤ 15 Hz (push rate) | The web eases for display with the core constants (`core/status/trackingBox.ts`) |
| `picture://fit` | fitted rect in CSS px, source WxH | on change | The single letterbox (F3) |
| `picture://stats` | presented fps, decoded, skipped, last frame age | 1 Hz | Feeds `connection.videoFps` |
| `scope://samples` (Channel, raw bytes) | WAVE/PARADE ~256 columns × 128 levels (u8), HISTO 3×256 (u16), VECTOR 128×128 (u8), lights/ND readings | ≤ 15 Hz, only while a plate is on | ≈16–50 KB per frame, ≤0.75 MB/s worst case |
| `gamepad://state` | `GamepadState` (mobile shape) | ≤ 60 Hz on change | UI only. Rust already applied it to the gimbal. |
| `ble://adverts`, `pair://step`, `station://step`, `relay://hosts`, `relay://info` | lists and steps | ~1 Hz | |
| `media://list`, `media://progress`, `media://ready`, `media://failed`, `player://position`, `player://strip` | files, bytes, ms | position ≤ 10 Hz; progress ≤ 4 Hz | Thumbnails and strip frames go through `pm://` URLs |
| `vcam://status`, `component://report` | readout | 1 Hz / on change | |
| `picture://error` | renderer error text | on change | A11 |

**IPC budgets**: steady-state live traffic should stay **below 100 messages/s and 1 MB/s**.
Any single message's dispatch must be **< 2 ms p99** on the main thread.

### 3.6 How the JS side gets a `CameraSession`

- **Implementation.** Add `src/camera/desktop/DesktopCameraSession.ts`, which implements
  `CameraSession`. The contract allows additive changes, so add `kind: 'desktop'` to the
  `kind` union and `{ kind: 'desktop' }` to `VideoSource`. `getState`/`subscribe` hold the
  last `camera://state` merge. `control.*`, `gimbal.*` and `media.*` map one-to-one onto the
  commands in §3.5. `notePictureStats` is a no-op, because Rust measures the present itself.
- **Selection.** In `camera/bootstrap.ts`, `isTauri()` (`'__TAURI_INTERNALS__' in window`)
  picks `DesktopCameraSession`. A build-time `EXPO_PUBLIC_DESKTOP=1` keeps the demo for the
  plain web preview. This changes the `Apps/Mobile/AGENTS.md` rule "Web always runs
  `DemoCameraSession`"; record the exception there.
- **Picture.** Add a `LivePicture.desktop` branch: a transparent `View` measured with
  `ResizeObserver` and `getBoundingClientRect` that calls `picture_layout`, plus the pointer
  handlers that send `picture_pointer`. It paints nothing, so the Vulkan surface shows through.
  Every overlay that mobile already draws in React (grids, guides, tracking brackets, the
  reticle, meters, the false-colour legend, scopes) stays in React, positioned on
  `picture://fit`.
- **Keys and gamepad.** Extend `useKeyboardShortcuts` to the desktop superset (§1.R) behind a
  desktop flag, with `preventDefault` for `Tab`, `Space`, `F11` and arrows. Keys go to
  `control_key`, so the Rust `Controller` keeps the exact desktop semantics and its tests.
  The gamepad is read in Rust with gilrs, **not** `navigator.getGamepads()`: the webview stops
  polling when unfocused or throttled. The state is echoed to the UI over `gamepad://state`.
- **Gimbal safety.**
  - Rust rests the stick on release (`gimbal_release`).
  - Rust also rests it when the drive heartbeat stops for **250 ms** (a webview hang or reload).
  - Rust also rests it on tao `Focused(false)` and `CloseRequested`.
  - JS also releases on `blur` and `pointercancel`.
  This keeps the handoff rule "Gimbal must send a rest command on mouse/touch cancel, focus
  loss, and window close" even if the web layer misbehaves.

### 3.7 How picture effects and assists reach the Vulkan shaders

1. The web computes `PictureEffects` exactly as mobile does (`usePictureEffects`) and calls
   `picture_set_effects` **only when it changes**, never per frame.
2. Rust maps it to `GradeOptions` plus resource requests, using the **core** for every number
   (zebra thresholds through `assist_scalars`, false-colour lattices through
   `Lut::false_color`, LUTs through `Lut::parse`/`built_in`):

| `PictureEffects` field | Vulkan today | Port work |
| --- | --- | --- |
| `mirror` | `GradeOptions.mirror` | none |
| `zebra {upper, lower, paint, midtone}` | `Zebra {highlight, midtone, colours}` via `assist_scalars` | map; keep the desktop IRE/code option |
| `peaking {color, ratioThreshold, noiseGate}` | `Peaking {sense Low/Med/High, color}` | add a parameter mapping or extend the shader |
| `falseColor` | `GradeOptions.false_color` + paint/weight cubes | map `cinestop/video/ire/limits` ↔ `Stops/ElZone/Ire/Limits` |
| `lutId` | `set_lut` | `lut_load` registers the cube by id once |
| `lutIntensity`, `lutExposureStops` | — | add to `feed.frag` |
| `split` (desktop audit) | fields exist, unused | wire it |
| `desqueeze`, `monochrome`, `mirrorVertical`, `sourceColor`, `signal`, `clipByte` | — | add (N10) |

3. The render thread reads `RenderState` from an `ArcSwap` once per frame. Descriptor sets
   are rewritten only when a bound resource changes (an existing rule). Cube and lattice
   uploads happen on the render thread between frames, never mid-pass.
4. Assists that are **not** per-pixel (grid, guides, cross, tracking box, reticle, legend,
   scopes, meters) are drawn by React above the picture. They never pass through the cube,
   which keeps the "HUD through the cube lies about exposure" rule by construction.
5. The vcam's Clean/As shown choice uses a second `GradeOptions` (`vcam_grade_options`), as
   today.

### 3.8 Risks, and what to prototype first on Windows

| # | Risk | Why it matters | Prototype / mitigation |
| --- | --- | --- | --- |
| R1 | Transparent WebView2 over a Vulkan child or top-level surface does not composite cleanly: white flash, black holes, flicker on resize | It is the whole architecture | **Spike 1 (first):** Tauri window, a Vulkan clear-colour animation at 60 Hz on the child HWND (option A) and on the top-level (option B), a transparent WebView2 with a button and a moving div. Test resize, maximise, fullscreen, minimise, 100/150/200 % DPI and a second monitor. |
| R2 | DWM composition of the webview with the swapchain adds a frame or disables MAILBOX/independent flip | P16 latency | In Spike 1, measure present-to-photon with a 1 kHz LED or photodiode, or PresentMon `MsBetweenDisplayChange`, against the current winit app. |
| R3 | Resize ordering: the swapchain recreate races webview layout, giving torn or black frames | A9 | Drive the resize from tao `Resized` on the render thread; hide the picture for less than one frame, never show black over 100 ms |
| R4 | WebView2 swallows keys (`Tab` focus, `Space` scroll, `F11`, `Alt`) or IME interferes | §1.R | `preventDefault` in the desktop key hook; test every key in Spike 3 |
| R5 | WebView2 background throttling when unfocused or occluded (timers, rAF) | Chrome freshness, and any JS-driven cadence | Nothing time-critical in JS (§3.3). Set Tauri `additionalBrowserArgs: "--disable-background-timer-throttling --disable-renderer-backgrounding"` and verify the window `backgroundThrottling` option on the Tauri version in use. Gate G-UNFOCUSED. |
| R6 | Main-thread IPC latency under load (state, tracking, scopes, gamepad together) | Input-to-wire latency | Spike 2 load test; enforce the budgets in §3.5 |
| R7 | Memory and CPU of the WebView2 processes (`msedgewebview2.exe`) | "No lost performance" | Measure every process in the gates; react-native-web plus reanimated must not render per frame |
| R8 | WebView2 runtime missing (Windows 10 without Edge updates; the portable ZIP) | Launch fails | Installer: Evergreen bootstrapper. Portable: detect it and show an error, or ship a Fixed Version runtime (+~150 MB). |
| R9 | `mimalloc-redirect.dll` (Swift toolchain) patches the CRT allocator process-wide, and WebView2 loads in-process DLLs | Crashes at start | Spike 2: load the Swift facade and WebView2 in one process; if it conflicts, drop the redirect or isolate it |
| R10 | Swift release linker strips C exports (D10) | Release build size and perf | Unchanged risk; carry the debug facade as today |
| R11 | `0x09/0xA8` enable-once or the 40 Hz ACK accidentally tied to webview lifecycle (a reload or route change re-opening the link) | Black picture with a live HUD | `Link` is owned by Rust app state; a web reload must re-attach, not reconnect. Test: reload the webview mid-session → zero extra enables. |
| R12 | Installer technology change loses upgrade-in-place, HKLM COM registration or "settings survive uninstall" | Z3 | Keep Inno Setup with the same AppId, wrapping the Tauri exe and its DLLs; keep `regserver`. If moving to the Tauri NSIS bundler, use `installMode: perMachine` plus hooks for `regsvr32` and uninstall. |
| R13 | Two protocol cores drift (Swift desktop vs TS mobile) | Divergent operator behaviour | §4.3 cross-checks; UI vocabulary only from `src/core` |
| R14 | Touch on WebView2: palm rejection and pointer capture differ from winit's explicit touch path | K3 | Physical touchscreen test |
| R15 | Expo web routing in a `tauri://` / `https://tauri.localhost` origin (static export, deep links, `expo-router` base URL) | App boots | Spike 3: `npx expo export --platform web` as `frontendDist` |
| R16 | Capabilities: Tauri v2 denies commands not listed | Silent failures | One capability file listing every command in §3.5 |

**Prototype order (Windows, before any UI port):**

1. **Spike 1**: compositing (R1, R2, R3) with a synthetic Vulkan clear. Exit when the gates
   G-LAT and G-RESIZE hold against a bare winit window on the same machine.
2. **Spike 2**: the existing `Link` + decoder + `FeedRenderer` (overlay pass off) inside the
   Tauri app, with a placeholder HTML page. Run the §4 baseline comparison on a physical
   Pocket 3 for 30 minutes, then check R6, R7, R9 and R11.
3. **Spike 3**: a minimal `DesktopCameraSession` (state, record, drive, keys, tracking,
   effects) on the real Expo web build. Covers R4, R5, R15.

Then the inventory, area by area, with the gates re-run after each area.

---

## 4. Acceptance gates

### 4.1 Instrumentation to add (to the shared crates, so the baseline and the port log the same lines)

| Line (new) | Where | Purpose |
| --- | --- | --- |
| `render: present t=<mono_us> seq=<n> au_rx=<mono_us> decode_done=<mono_us>` (sampled 1 Hz summary: p50/p95/p99 of `present − au_rx`, frame-time p99) | `opc-render` present, `opc-decode` handoff | Arrival → present latency |
| `link: enable reason=<connect\|watchdog\|first-picture\|media-resume>` | `opc-camera/session.rs` | Counts every `0x09/0xA8` |
| `link: stick tx t=<mono_us> axes=… rest=<bool>` (1 Hz summary + every rest) | `opc-camera` | Input → wire and rest latency |
| `input: <source> rx t=<mono_us>` | controller | IPC or key → controller latency |
| `ipc: <cmd> dispatch_us=<n>` (p99 at 1 Hz) | Tauri handlers | R6 |
| `web: longtask ms=<n>` / `web: fps raf=<n>` (1 Hz) via `PerformanceObserver` | `DesktopCameraSession` → `log_web` | Web-side jank |
| `proc: cpu=<% per process> ws=<MB per process> gpu=<% engine 3D>` (10 s) | Rust sampler (Toolhelp/PDH) incl. `msedgewebview2.exe` children | R7 |
| `vcam: delivered fps=<n> readback_ms=<p95>` | `opc-vcam` | P21 |

Both builds write the log to the same folder for the benchmark (`--log <path>`, or the new
LOCALAPPDATA location from D3).

### 4.2 Benchmark protocol

**Rigs (at least three).** Integrated AMD (named in the code as the costly case), Intel
integrated, and a discrete NVIDIA. Windows 11 23H2+ on all three, plus one Windows 10 22H2.
Displays at 1080p 100 % and at 4K 150 %. **Cameras:** Pocket 3 (AVC), Pocket 4 or 4 Pro
(HEVC), Nano (AVC) where available. Same camera firmware and same position for both builds;
the laptop on mains power with the same power plan.

**Method.** For each scenario, run the **baseline** (current `opc-monitor` release) three
times, then the **port** three times. Alternate the order (B, P, B, P, B, P) to cancel drift.
The tolerance for "match" is **2σ of the baseline's three runs** (minimum 1 % or 1 ms).
"Beat" is better than the baseline mean.

| ID | Scenario |
| --- | --- |
| S1 | Cold launch with the saved SoftAP profile → first decoded picture, × 5 |
| S2 | 30-minute live soak, assists off, window focused |
| S3 | 30-minute live soak with LUT + zebra + peaking + false colour + WAVE + VECTOR + HISTO + LIGHTS |
| S4 | Gimbal stress: 2 minutes of arrow-key pulses (100 ms on, 100 ms off), then 2 minutes of the gamepad stick, then 50 touch-pad drags |
| S5 | 5 minutes with the window unfocused behind another app, then 5 minutes minimised then restored |
| S6 | 100 window resizes and 20 fullscreen toggles at 1 s intervals |
| S7 | Library open → play a proxy 60 s with LUT and audio → back → live, × 10 |
| S8 | 30 minutes with the virtual camera (Camera device) read by the Windows Camera app, at a window size ≠ 1280×720 |
| S9 | Induced stall: move the camera out of Wi-Fi range for 10 s, three times; the camera-side encoder pause recipe from `feed-watchdog.md` |
| S10 | Phone relay watch (where an iPhone host exists), 10 minutes |
| S11 | Webview reload (`Ctrl+R` in a dev build) mid-session, × 3 (R11) |

**Metrics and thresholds.** Source: `opc-monitor.log` existing lines (§1 Y1), plus §4.1.

| Gate | Metric (source) | Threshold |
| --- | --- | --- |
| G-ACK | `link: transport: ack=X/s max_gap=Y` per second | Port p1 of ack ≥ baseline p1 − tolerance, and **≥ 39.0/s absolute**. `max_gap` p99 ≤ baseline. No second above 100 ms outside a logged recovery. All scenarios. |
| G-FPS | `view: pace: … shown …` vs `link: video rate: … access-units/s` | shown/s within 0.5 of the AU rate in ≥ 99 % of seconds (S2, S3, S5, S8). `skipped` total ≤ baseline. `queued` ≤ 3. |
| G-LAT | `render: present` p50/p95 of present − AU receive; plus a glass-to-glass spot check (a camera filming a 1 kHz LED clock, both screens filmed at 240 fps) | p50 and p95 ≤ baseline + tolerance; glass-to-glass p50 ≤ baseline + 1 display refresh |
| G-SLOW | Count of `view: slow:` lines (and the port's render-thread equivalent) | ≤ baseline per scenario; 0 in S2 |
| G-ENABLE | `link: enable reason=` counts | connect = 1 per session. watchdog ≤ baseline. **Zero** extra enables from UI actions (assist toggles, route changes, reload S11). |
| G-WD | `link: feed watchdog:` rungs per scenario | ≤ baseline in S2, S3, S5, S6; S9 recovers to picture in ≤ baseline time |
| G-FIRST | S1 time from process start to `decoded first picture` | ≤ baseline + tolerance (the single-process port should beat it) |
| G-INPUT | `input rx` → `stick tx` p95; `ipc dispatch_us` p99 | p95 ≤ 15 ms total from key event to wire; IPC dispatch p99 < 2 ms |
| G-REST | `stick tx rest=true` after key-up, pointer-up, blur, close and heartbeat loss | ≤ 50 ms after the event; ≤ 300 ms on heartbeat loss; 100 % of S4 releases |
| G-UNFOCUSED | S5 ack, shown/s and present latency | Same thresholds as focused (G-ACK, G-FPS, G-LAT); chrome state still updates |
| G-RESIZE | S6 | No crash, no device loss, no black picture longer than 100 ms, no watchdog action, no swapchain leak (memory flat ±20 MB) |
| G-SCOPE | `scope://samples` rate and G-FPS during S3 | 15 ± 1 Hz while plates are on, and S3 passes G-FPS |
| G-VCAM | S8 `vcam: delivered fps` and live G-FPS | **30 ± 0.5 fps delivered and live G-FPS unaffected** (port must beat the D4 baseline) |
| G-PLAYER | S7 | Proxy plays at its own rate with LUT; audio lead 80 ms ±20 ms; back to live picture ≤ baseline |
| G-UI | `web: longtask` and status-to-pixel | 0 long tasks > 50 ms during S2; status chip update ≤ 250 ms after `camera://state`; REC tally ≤ 1 display frame after the event |
| G-CPU | `proc:` totals, all processes | Total CPU ≤ baseline + tolerance (Slint software raster retires, WebView2 arrives: they must net out) |
| G-MEM | `proc:` working sets | Reported. Proposed ceiling: total ≤ baseline + 300 MB and flat over 30 min (±50 MB); the owner confirms the ceiling |
| G-THERMAL | Laptop on battery, 30 min S3 | Shown/s within G-FPS for the whole run |

The port passes only if **every gate passes on every rig and camera** in the matrix. A gate
failure blocks the area that caused it, not just the release.

### 4.3 Sign-off checklist before `Apps/Desktop` can be deleted

**Features**

- [ ] Every row in §1.A–§1.Z is ticked as **physically verified** on Windows with a real
      camera (per `AGENTS.md`), with the build hash and the camera recorded. The 67 rows
      marked PARTIAL or MISSING, and the 7 missing keys, need explicit evidence.
- [ ] The keyboard table (§1.R) and gamepad table (§1.S) are verified key by key and button by
      button. The D7 semantics are decided and written into `docs/PARITY.md`.
- [ ] The `tests/shell.rs` and `tests/viewfinder.rs` behaviours are ported to `opc-controller`
      and green. The `opc-camera` fake-camera tests and the gated core tests (`just
      desktop-check-gated`) are green.
- [ ] Every persisted file in §1.X is migrated on first run of the port (an old
      `desktop-prefs.txt` produces identical settings), with a test per file.
- [ ] CLI (§1.B) and environment variables work, including `headless` and the attached-console
      output (D2). `opc-watcher` still builds and runs.
- [ ] Virtual camera: Camera device (Win 11), Stream (OBS), install/remove under UAC, and the
      installer registration. W1–W4 verified; macOS W5 at least builds.
- [ ] Station mode, LAN search, relay watch and webcam gestures verified (they were never
      verified on the old app either; record that the first proof is on the port).
- [ ] Discrepancies D1–D11 are each fixed or consciously carried, with a note.

**Performance**

- [ ] All §4.2 gates pass on the full rig × camera matrix, with logs archived under
      `docs/releases/<version>/bench/` (no credentials or captures, per hygiene rules).
- [ ] Enable-once and the 40 Hz ACK are verified independent of the UI (S11 reload, S5
      unfocused).

**Release**

- [ ] Installer upgrades an existing 0.1.x install in place (same AppId), registers and
      unregisters the vcam DLL, keeps settings and cache on uninstall, and installs the
      WebView2 runtime when it is missing. The Start-menu and desktop shortcuts open the home
      screen (or the remembered camera with *open at launch*).
- [ ] Portable ZIP runs from a USB stick on a clean Windows 11 and on Windows 10 22H2 (with
      WebView2 present), and logs to the documented location.
- [ ] The LGPL FFmpeg gate is still enforced; `SHA256SUMS.txt` is produced; the FFmpeg source
      and provenance are attached.

**Docs and repository**

- [ ] `docs/DESKTOP.md`, `desktop-viewfinder.md`, `desktop-port-status.md`,
      `desktop-ui-handoff.md`, `README.md` (the keyboard table, the build instructions) and
      `docs/PARITY.md` are rewritten for the Tauri app.
- [ ] `AGENTS.md` (desktop) and `Apps/Mobile/AGENTS.md` record the desktop session exception and
      the ownership rules (§3.3).
- [ ] CI builds the web export plus the Tauri app, and runs the Rust suite.
- [ ] A rollback plan exists: the last Rust-shell release stays downloadable, and the Inno AppId
      allows reinstalling it over the port.

Only when every box is ticked is `Apps/Desktop` (the winit/Slint/egui shell) deleted. The
crates kept in §3.4 move under the new desktop app rather than being deleted with it.
