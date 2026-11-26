# src/core — protocol core (pure TypeScript)

Pure TS port of the portable Swift camera core. No React / React Native imports; bytes are
`Uint8Array` (inputs accept any `ArrayLike<number>`). Tests are vitest (`npm test`), vectors ported
verbatim from the Swift suites. Where this fork (`Sources/OpenPocketViewCore`) and upstream OpenCine
(`OpenCineDJI`, `OpenCineCameraVocabulary`, `OpenCineMotion`, `OpenCineMedia`) differ, **upstream wins**
and the module header says so. `src/core/media/**` (assists) is owned separately.

## Hot path: what native must implement

JS never sits on the per-packet path. `modules/opc-native` (Swift/Kotlin) must implement, using the TS
files as the tested reference: UDP socket + handshake (`transport/datalink.ts`,
`transport/handshakeAdmission.ts`), the **40 Hz pktType-0x04 ACK pump** with `AckWindows`
(forward-only cursors), one serialized UDP queue with `DatalinkSequencer` semantics (commands,
ACKs, gimbal stick 25 Hz, `GimbalNativeTargetStream`), video depacketizing (`video/depacketizer.ts`)
and decoder latch on observed parameter sets (`video/nal.ts`). `0x09/0xa8` is sent once at connect;
repeats belong only to `connection/feedWatchdog.ts`.

## Modules

| Module | Swift source of truth | Status |
| --- | --- | --- |
| `bytes.ts`, `math.ts` | — (helpers: LE ints, f32, UTF-8, Swift rounding) | done |
| `duml/frame.ts` | OpenCineDJI `DumlFrame.swift` (+ fork `Duml.decode`) | done, tested |
| `duml/assembler.ts` | OpenCineDJI `DumlNotificationAssembler.swift` | done, tested |
| `transport/datalink.ts` | OpenCineDJI `DumlTransport.swift`; sequencing from `OpenCineDJIApple/DjiAppleDatalink.swift` | done, tested (upstream forward-only telemetry cursor) |
| `transport/handshakeAdmission.ts` | OpenCineDJI `DatalinkHandshakeAdmission.swift`, `MulticamCommands.controlSequence` | done, tested |
| `commands/vocabulary.ts` | OpenCineCameraVocabulary `CameraControl.swift` + `CameraControl+DJIWire.swift` | done (wire subset; UI ladders not ported) |
| `commands/commands.ts` | OpenCineDJI `Commands.swift`, `CaptureCommand`, `GimbalControl` | done, tested |
| `commands/control.ts` | `CameraControl+DJIWire.swift` (CameraReply, CameraParam, Glamour, AudioDsp, ExpoParam, WB, lens, gimbal params, `GimbalPrepRestore`) | done, tested |
| `commands/camFov.ts` | `CameraControl.swift` `CamFov` | done, tested + shared golden vectors (`Tests/Fixtures/camfov-vectors.tsv`) |
| `commands/livestream.ts` | OpenCineDJI `LivestreamCommands.swift`, `MulticamCommands.swift` | done, tested (TSV goldens not in checkout; re-derived) |
| `commands/setMailbox.ts` | OpenCineDJI `CameraSetMailbox.swift` | done, tested |
| `status/cameraModel.ts` | `CameraModel.swift`, `CameraModel+DJIWire/DJIProfile.swift`, `DJICaptureCapabilityProfile.swift` | done (LUT looks / ControlFamily table not ported) |
| `status/cameraStatus.ts` | `CameraStatus.swift`, `CameraStatus+DJIWire.swift` | done, tested |
| `status/camCap.ts` | `CamCap.swift`, `CamCap+DJIWire.swift` | done, tested |
| `status/audio.ts` | OpenCineDJI `CamAudioStatus.swift` | done, tested |
| `status/trackingBox.ts` | `TrackingBox.swift` (geometry), `TrackingBox+DJIWire.swift` | done; face/AF policies not ported |
| `status/mediaManifest.ts` | `MediaManifest+DJIWire.swift` (chunk assembler + CompositePack decode) | done, tested on `nano-manifest.bin`; pagination + HTTP paths not ported |
| `ble/advert.ts` | OpenCineDJI `BleAdvert.swift` | done, tested |
| `ble/pairing.ts` | `DjiAppleConnectionRun.swift` (pairing / Wi-Fi handoff decisions) | done, tested |
| `ble/stationJoin.ts` | OpenCineDJI `StationJoin.swift` | done, tested (I/O injected) |
| `ble/wifiQr.ts` | `CameraWiFiQRCode.swift` (+ new `parse`) | done, tested |
| `ble/savedCamera.ts` | fork `SavedCamera.swift` | done, tested |
| `connection/phase.ts` | fork `ConnectionPhase.swift`, OpenCineDJI `ConnectTimeline.swift` | done, maps to UI `ConnectionPhase` |
| `connection/feedWatchdog.ts` | OpenCineCameraVocabulary `FeedWatchdog.swift` | done, tested |
| `connection/cameraSoftAP.ts` | OpenCineCameraVocabulary `CameraSoftAP.swift` | done, tested |
| `connection/pathRecovery.ts` | OpenCineDJI `CameraPathRecovery.swift` | done, tested |
| `connection/linkDiagnosis.ts` | OpenCineDJI `LinkDiagnosis.swift` | done, tested |
| `connection/linkHealth.ts` | fork `CameraLinkHealth.swift`, `LinkSignalBars.swift`, `FrameRateSampler.swift` | done, tested |
| `video/nal.ts` | OpenCineMedia `Hevc.swift`/`Avc.swift`, `Hevc+DJI.swift` | done, tested |
| `video/depacketizer.ts` | OpenCineDJI `HevcDepacketizer.swift` | done, tested (reference for native) |
| `gimbal/reach.ts` | OpenCineDJI `GimbalReach.swift`, `GimbalNativePitchWire` | done |
| `gimbal/stick.ts` | `GimbalStick`, `GimbalStickMapping` | done, tested (touch/tap mapping not ported) |
| `gimbal/program.ts` | OpenCineMotion `GimbalProgram.swift`, `GimbalProgramCurve.swift` | done, tested; `GimbalMoveEngine` playback not ported |
| `gimbal/nativeTargetStream.ts` | OpenCineDJI `GimbalNativeTargetStream.swift`, `GimbalParamPoll` | done, tested |
| `gimbal/headTrack.ts` | OpenCineMotion `HeadTrack.swift`, `HeadTrackNative.swift` | done, tested |
| `gimbal/gamepad.ts` | `GamepadOperator.swift` (mapping only) | done, tested |
| `mapping.ts` | — (status/capabilities → UI `CameraState`, UI → wire values) | done, tested |
| `index.ts` | barrel | done |

Not ported: `GimbalCluster` (UI layout; lives with the RN live screen), `GimbalMoveEngine`,
`DJICameraSessionAdapter` / `DJIIntegration` (session orchestration belongs to `src/camera/native`),
multiview / watcher relay, LUT/look profiles.
