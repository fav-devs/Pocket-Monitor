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
| `src/theme/` | Tokens (`colors`, `radius`, `spacing`, `fonts`, `motion`) and `MText`. |
| `src/ui/` | Shared primitives (`PressableScale`, `IconButton`, `SectionHeader`, `GlassSurface`, …). |
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
- Use `MText` for text, tokens for colours, `lucide-react-native` for icons, Sora fonts.
- Every interactive control has at least a 44pt touch target.
- Do not commit camera Wi-Fi passwords, captures, personal data, signing material or unofficial LUTs.
  DJI LUT `.cube` files are not bundled.
- `ios/` and `android/` at the app root are generated (CNG). Never hand-edit them; configure via
  `app.json` and config plugins. Native code lives in `modules/pocket-native/{ios,android}`.

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
