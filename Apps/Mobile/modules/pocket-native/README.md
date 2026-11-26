# pocket-native

Local Expo module (Expo Modules 2.0 macro API, SDK 58) that owns Pocket Monitor's camera I/O:
Bluetooth LE, camera Wi-Fi join, the UDP datalink with its 40 Hz ACK pump, video reassembly,
gamepad input and AirPods head motion. The JS ⇄ native contract is [`src/types.ts`](src/types.ts);
`src/native.ts` resolves each module with `requireOptionalNativeModule` (null on web / Expo Go).

Protocol policy (command building, reply parsing, status decode, watchdog, enable-once) stays in
`src/core`. Native code owns only the hot path: sockets, framing, ACK windows, depacketizing.

| JS name | iOS class | Android class | Files |
| --- | --- | --- | --- |
| `PocketBluetooth` | `PocketBluetoothModule` | `bluetooth.PocketBluetoothModule` | `ios/Bluetooth`, `android/.../bluetooth` |
| `PocketWifi` | `PocketWifiModule` | `wifi.PocketWifiModule` | `ios/Wifi`, `android/.../wifi` |
| `PocketDatalink` | `PocketDatalinkModule` | `datalink.PocketDatalinkModule` | `ios/Datalink`, `android/.../datalink` |
| `PocketVideo` | `PocketVideoModule` | `video.PocketVideoModule` | `ios/Video`, `android/.../video` (video owner) |
| `PocketGamepad` | `PocketGamepadModule` | `gamepad.PocketGamepadModule` | `ios/Gamepad`, `android/.../gamepad` |
| `PocketHeadMotion` | `PocketHeadMotionModule` | `headmotion.PocketHeadMotionModule` | `ios/HeadMotion`, `android/.../headmotion` |

Event names are the full contract names (`onAdvert`, `onDuml`, …), set explicitly with
`@Event("onX")` because the macros would otherwise strip the `on` prefix.

## Connection spine

BLE → SoftAP → UDP datalink → live view (`CONTEXT.md` "Spine").

### PocketBluetooth

- Scan: unfiltered by default (`startScan(null)`), duplicates on — Pocket 3 omits manufacturer
  data and the first advert is often nameless. Adverts are forwarded on change, else ~1 Hz per
  device. `manufacturerData` is raw, company id first (little-endian), for `src/core` BleAdvert
  decode. iOS also surfaces peripherals iOS already holds for the service filter (or `FFF0`),
  with `rssi: 127` ("unknown").
- Connect: GATT (Android: `TRANSPORT_LE`, `requestMtu(512)` then discovery with a 1.5 s fallback),
  find `service`, enable notify (+ CCCD) on each `notifyCharacteristics` entry one at a time, wait
  for every CCCD callback (a missing or failed CCCD does not hang), then, unless
  `armPairing: false`, write the DJI app-pairing arm `[01 00]` with response to
  `notifyCharacteristics[0]` (fff4). The promise resolves after that write; 10 s deadline.
  DJI UUIDs: service `0000FFF0-…`, notify `FFF4`, write `FFF5` (`src/core/status/cameraModel.ts`).
- Write: queued per link. Without-response writes are paced 120 ms apart (back-to-back fff5 writes
  drop); with-response writes resolve on the write callback.
- UUIDs in events are always full 128-bit upper-case. Inputs accept `FFF4`, `0000FFF4` or full.
- Notifications are forwarded raw; DUML reassembly is `src/core/duml/assembler.ts`.
- Ids: iOS peripheral UUID, Android MAC.

### PocketWifi

- iOS: `NEHotspotConfiguration` (`joinOnce` honoured). Skips `apply` when already on the SSID with a
  `192.168.2.x` address (re-applying prompts "Wants to Join" again). `apply` success is *not*
  association, so `joined` waits for a `192.168.2.2…254` address or the target SSID. A wrong
  passphrase also returns `apply` success and then never associates: that surfaces as `timeout`.
  Error mapping: userDenied → `user-denied`, invalidSSID(Prefix) → `not-found`,
  invalidWPA/WEPPassphrase → `wrong-password`, alreadyAssociated → `already-associated`,
  pending / no answer → `timeout`, anything else → `failed`.
- Android (API 29+): `WifiNetworkSpecifier` + `requestNetwork(…, timeout)` on the main looper +
  `bindProcessToNetwork`. The request stays registered while the session lives. A Wi-Fi network
  that already carries a `192.168.2.x` address (and a matching or unreadable SSID) is adopted as
  `already-associated`. `onUnavailable` (user cancel, not found and timeout look the same) is
  mapped by elapsed time and scan results. `onLost` keeps the process binding for an 8 s
  reassociation grace; the datalink is told when the Network object is replaced or lost.
  `joinOnce` has no Android equivalent and is ignored. `leave` unbinds and unregisters.
- `localAddress` is the camera-AP address (`192.168.2.2…254`).

### PocketDatalink

One session per `sessionId`. `open` resolves when the UDP socket is ready; it does **not** handshake.

1. Path: waits up to 8 s for a `192.168.2.x` address when `host` is on the SoftAP (sockets created
   earlier bind to the old Wi-Fi and RST).
2. Optional `tcpPoke` (SetPairingPIN bytes from `src/core`, port 7001): opened first, drained, kept
   for the session. Best effort.
3. UDP to `host:port` from an **ephemeral** local port (`localPort: 9004` is forced to 0 — binding
   :9004 dropped every pktType `0x02`).
   - iOS: `NWConnection`, `prohibitedInterfaceTypes = [.cellular]`,
     `requiredLocalEndpoint = <camera DHCP IPv4>:0` + `requiredInterface`, falling back to
     interface-only, then `requiredInterfaceType = .wifi`. Local Network denial is reported.
   - Android: `DatagramSocket(null)` → `Network.bindSocket` (camera network from PocketWifi) →
     bind `0.0.0.0:0` → connect.
4. JS sends the handshake with `sendRaw` (`DatalinkSequencer.handshake()`). Native sniffs pktType
   `0x00` for session id / seq / `baseSeq` (state `handshaking`) and admits the session on the
   camera's `0x00` ACK plus the 34-byte `0x01` initial window (`DatalinkHandshakeAdmission`):
   the command seq is reseeded from that window, `0x02` ingest is armed, state → `open`.
   A handshake with a new session id / baseSeq restarts admission on the same socket.
5. `sendDuml(frame)`: JS stamps the DUML seq (it matches replies); native prepends the transport
   header + routing header (`udpSeq += 8`, `cmdCounter += 1`). Frames sent before admission are
   dropped (logged).
6. Inbound: every non-video datagram updates the ACK windows and is scanned for CRC-valid DUML
   frames → one `onDuml` per frame. pktType `0x02` feeds group 0 and, when `attachVideo` was
   called, the depacketizer.
7. **Native never sends `0x09/0xa8` or any command on its own** — only window ACKs. Enable-once and
   every repeat belong to JS / the watchdog.

#### ACK pump and windows

pktType `0x04`, transport seq 0, 26-byte payload of three groups (CONTEXT.md "ACK window"):
group 0 = latest video `0x02` seq (seeded from 34-byte telemetry only before the first `0x02`),
group 1 = ackedData `0x03` seq (command replies incl. Flip GET), merged forward-only with
telemetry, group 2 = telemetry extra. Unseen groups 1/2 fall back to `baseSeq`; seq `0` is valid
once seen. The pump is silent until admission. It runs at `ackHz` (40):

- iOS: `DispatchSourceTimer(.strict)` on the session's private serial queue (`.userInteractive`),
  which also owns receive and every UDP write, so writes serialize like upstream `DjiAppleDatalink.q`.
- Android: a dedicated `pocket.datalink.ack` thread at `THREAD_PRIORITY_URGENT_DISPLAY` with
  absolute deadlines (`LockSupport.parkNanos`), no burst after a stall. Writes serialize on one
  send lock; JS writes go through a single-thread `pocket.datalink.tx` executor.

Neither depends on the JS thread. `onStats` (1 Hz) reports the measured `ackHz`.

#### Video

Port of `HevcDepacketizer` (sized DJI-marker mode with the declared length and seq continuity
+8, plus the legacy frame/position mode) and upstream `SoftAPVideoAssembler`'s random-access gate
(after a lost fragment, drop dependants until an AU with a keyframe NAL). The Nano private SEI
(`06 F0 19`, raw 25 bytes) is removed from each AU so its fake start codes never reach a decoder.
Codec latches from parameter sets (HEVC `0x40/0x42/0x44`, AVC `0x67/0x68`), else the `attachVideo`
hint. Complete Annex-B AUs go to `PocketVideoSinkRegistry` sinks for the session on a separate
video queue/thread (`presentationTimeUs` = monotonic receive time). `reset()` is sent on attach,
detach, a new handshake and close — not on fragment loss (the gate handles that).

#### States

`opening` → `handshaking` (handshake sent) → `open` (admitted) ⇄ `stalled` (no datagram for 2 s, or
Android camera Network replaced) → `closed`. `failed` on socket failure, path not ready, Local
Network denial or Android camera network lost.

### PocketGamepad

- iOS: `GameController`, first controller with an extended profile, main queue (as upstream),
  `valueChangedHandler` with no actor isolation, coalesced to ≤ ~60 Hz, only on change.
  `shouldMonitorBackgroundEvents = true`.
- Android (view-less): wraps the resumed Activity's `Window.Callback` and reads gamepad/joystick
  `KeyEvent`s and `MotionEvent`s; re-wraps across Activity recreation; `InputManager` device
  listener for connect/disconnect. Limitations: gamepad input is consumed while started (BUTTON_B
  must not become Back), only arrives while our Activity is focused, and stacking with another
  library that swaps `Window.Callback` must unwind in order. Y axes are negated to the iOS
  convention (stick up = positive); hat axes feed the D-pad.

### PocketHeadMotion

iOS `CMHeadphoneMotionManager` quaternion `(x, y, z, w)` + `CMDeviceMotion.timestamp`, and
connect/disconnect events. Android reports `isAvailable() == false` and `start()` rejects.

## Threading summary

| Work | iOS | Android |
| --- | --- | --- |
| BLE | private serial queue `pocket.ble` (manager delegate queue) | HandlerThread `pocket.ble` |
| UDP rx / tx / ACK | per-session serial queue `pocket.datalink.<id>` | `rx`, `ack` threads + `tx` executor |
| Video sinks | per-session `pocket.datalink.video.<id>` | `pocket.datalink.video` executor |
| Gamepad | main | main |
| Head motion | `OperationQueue` `pocket.headmotion` | — |

JS calls only enqueue onto those; events are emitted from them (Expo schedules them onto JS).

## App configuration this module needs (set in app.json / config plugins, not here)

- iOS Info.plist: `NSBluetoothAlwaysUsageDescription`, `NSLocalNetworkUsageDescription`,
  `NSMotionUsageDescription`; location usage only if reading SSIDs of networks the app did not
  configure.
- iOS entitlements: `com.apple.developer.networking.HotspotConfiguration`,
  `com.apple.developer.networking.wifi-info`.
- Android manifest: the library declares BLUETOOTH_SCAN/CONNECT, Wi-Fi/network state, NEARBY_WIFI_DEVICES
  and INTERNET. **Not declared:** `ACCESS_FINE_LOCATION` (BLE scan on Android ≤ 11, SSID reads) and
  legacy `BLUETOOTH` / `BLUETOOTH_ADMIN` with `maxSdkVersion="30"` — the app must add them.

## Must be verified on a physical device

Nothing here has been compiled (no Xcode / Android SDK in the authoring environment). Swift macro
usage was checked with `expo-modules-macros expand --diagnostics-only`; Kotlin by review only.

- Every module loads (`requireOptionalNativeModule` finds v2 modules) and event names fire as
  `onX` on both platforms.
- **Android byte payloads**: Kotlin `ByteArray` crosses to JS as an `ArrayBuffer`, iOS `Data` as a
  `Uint8Array`. Until verified, JS consumers (`onAdvert.manufacturerData`, `onNotify.bytes`,
  `onDuml.bytes`) should normalize with `new Uint8Array(x)`. `Uint8Array` arguments (`write`,
  `sendDuml`, `sendRaw`) are accepted on both. A `Uint8Array` nested in an options object
  (`tcpPoke.bytes`) arrives on Android as an index-keyed map and is decoded natively.
- Pairing on Pocket 3 / Pocket 4 / Nano: scan finds the camera, connect resolves after the arm
  write, fff4/fff5 notifications arrive, 120 ms paced fff5 writes are not dropped.
- Wi-Fi: first join (prompt + DHCP), second join (`already-associated`, no prompt), user deny,
  wrong password (expected `timeout` on iOS), Android SoftAP `onLost` → reassociation.
- Datalink: handshake admitted from the 34-byte window, ACK at 40 Hz measured on the camera side
  (`onStats.ackHz` is local submission only), Flip GET / SET replies keep flowing for minutes
  (group 1 echo), HEVC and AVC (Nano) pictures decode from the sinks, Local Network denial is
  reported on iOS, TCP 7001 poke stays open, no `0x09/0xa8` is ever sent natively.
- Gamepad: DualSense / Xbox pads on both platforms; Android Activity recreation keeps input.
- Head motion: AirPods Pro / Max connect, samples and authorization denial.
