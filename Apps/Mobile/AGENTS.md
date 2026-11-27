# Pocket Monitor mobile (Expo / React Native)

React Native rebuild of the OpenPocketCine iOS app for iOS, Android and web.
Expo SDK 58, React Native 0.88, React 19.3, Expo Router, TypeScript strict.

## Reference sources

- Upstream iOS app (behaviour and UI reference): `erik-sutton95/OpenPocketCine` → `ios/OpenPocketCine/`.
- Upstream shared platform code (most UI, protocol and media logic): `erik-sutton95/OpenCine` →
  `Sources/MonitorUI`, `MonitorPresentation`, `OpenCineCameraControls`, `OpenCineAppKit`,
  `OpenCineDJI`, `OpenCineDJIApple`, `OpenCineMedia`, `OpenCineApple`, `OpenCineMotion`, `OpenCineRelay`.
- This repository's synced Swift core: `../../Sources/OpenPocketViewCore` with tests in `../../Tests`.
- Protocol and behaviour docs: `../../docs/` (`protocol-notes.md`, `live-session.md`,
  `feed-watchdog.md`, `PARITY.md`, `UX.md`, `programmed-moves.md`, `head-tracking.md`, `watcher-relay.md`).

## Layout

| Path | What lives there |
| --- | --- |
| `src/app/` | Expo Router routes only. Each file re-exports a screen from `src/features`. |
| `src/constants/` | Theme (`useTheme`, `useThemedStyles`, `fonts`, `spacing`, `radius`) and layout helpers, verbatim from Sondr (`fav-devs/ai-cut`). |
| `src/components/` | Shared components from Sondr (Button, Chip, Sheet, SegmentedControl, settings kit, …) plus app-wide ones (`app-logo`). |
| `src/camera/` | UI-facing camera contract (`types.ts`, `session.ts`), `CameraProvider` hooks, demo session. |
| `src/core/` | Pure TypeScript port of the protocol core (DUML, commands, status decode, depacketizers, policies). No React, no RN imports. Tested with vitest. |
| `src/state/` | Persisted zustand stores (preferences, saved cameras, assists, …). |
| `src/features/<area>/` | Screens and components for one product area. |
| `modules/pocket-native/` | Local Expo module (Expo Modules 2.0 macro API): Swift in `ios/`, Kotlin in `android/`, JS contract in `src/types.ts`, web fallbacks in `*.web.ts(x)`. |

## Architecture rules

- Screens read camera state only through `useCamera(selector)` and act only through
  `useCameraSession().control / .gimbal / .media`. Never import native modules from screens.
- `src/camera/types.ts` and `src/camera/session.ts` are the contract. Additive changes only
  (new optional fields / new members). Never rename or remove.
- Protocol bytes and camera decisions live in `src/core` (TS) and, for the hot path only
  (UDP transport, ACK pump, video depacketizing, decode), in native code.
- `0x09/0xa8` enables live view once at connect; repeats belong only to the watchdog.
- The UDP ACK pump runs natively at 40 Hz, independent of JS and UI work.
- Web always runs `DemoCameraSession`. Every screen must render and be usable on web.
  Exception: inside the Tauri desktop app (`window.__TAURI_INTERNALS__`), `bootstrap.ts` picks
  `DesktopCameraSession` (`src/camera/desktop`), which drives the camera through the Rust backend
  over IPC; its picture is native Vulkan under a transparent web view, so `<LivePicture>` renders a
  transparent hole for `VideoSource { kind: 'desktop' }`. The same web bundle still boots the demo
  in a browser. See `docs/desktop-expo-port.md` §5.
- UI uses the Sondr design system (`src/components`, `src/constants`): SN Pro, Hugeicons, light/dark, labels not explanations.
- Every interactive control has at least a 44pt touch target.
- Do not commit camera Wi-Fi passwords, captures, personal data, signing material or unofficial LUTs.
  DJI LUT `.cube` files are not bundled.
- `ios/` and `android/` at the app root are generated (CNG). Never hand-edit them; configure via
  `app.json` and config plugins. Native code lives in `modules/pocket-native/{ios,android}`.

## Hand gestures on phones

The desktop's gestures (`Apps/Desktop/crates/pm-controller`: `hand.rs`, `gesture.rs`, `vision.rs`,
`clap.rs`, the gesture parts of `input.rs`) run on phones too:

- `src/core/gestures/`: the pure TypeScript port, every number and rule the desktop's, its Rust
  unit tests ported with the same vectors (`*.test.ts`). `drive.ts` carries them out on a
  `CameraSession` (stick heartbeat 100 ms, let go 0.5 s after the last reading, zoom by
  `zoomBy` with the triggers' rest zone, record held 2.5 s, face box → `startTracking`).
- `modules/pocket-native` `PocketHands`: the models. iOS Apple Vision, Android MediaPipe Tasks
  (GPU, CPU fallback); source = the camera's decoded picture (480 across, ≤ 15 Hz, off the render
  path, dropped while busy) or the front camera; the microphone as 10 ms level blocks for the
  double clap. See its README.
- `src/features/gestures/`: `PhoneGesturesHost` (mounted in the root layout) runs it only while
  gestures are on, `/live` is on screen, a camera is live and the app is in front, and draws the
  status pill and the record hold. Settings live in `usePreferences().gestureSettings` (the
  desktop's `AppSettings` names); the shared Gestures page, gimbal-panel rows and `HandViewOverlay`
  read them through `src/camera/desktop/gestures.ts` (a phone `GestureSettingsBackend`).
- Web: `native.web.ts` gives a made-up `PocketHands` (two hands and a face at 15 Hz) so the page,
  the pill and the hand view can be checked in a browser. Not inside the desktop app.

## Commands

```bash
npm run typecheck        # tsc --noEmit
npm test                 # vitest (src/**/*.test.ts)
CI=1 npx expo start --web --port <port>
npx expo export --platform web --output-dir <dir>
```

Add dependencies with `EXPO_OFFLINE=1 npx expo install <pkg>` (the Expo version API is blocked
by the network proxy here). Run typecheck and tests before declaring work done.

## Verification

Operator-visible behaviour is only proven on a physical device with a camera. Web preview,
tests and builds are necessary but not sufficient; say which you ran.
