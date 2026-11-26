# PocketVideo (native video)

JS module `PocketVideo` with views `PocketVideoView` and `PocketScopeView` (contract: `src/types.ts`
→ `PocketVideoNativeModule`, `VideoViewProps`, `ScopeViewProps`, `PictureEffects`). The Android
twin lives in `android/src/main/java/com/favdevs/pocketnative/video/` and follows the same design,
uniform layout and shader semantics.

## Pipeline

```
datalink receive queue ── PocketVideoSink.receive(AU) ──► PocketVideoSession (one per sessionId)
                                                        │ decodeQueue (serial, userInteractive)
                                                        │ Annex-B split → VPS/SPS/PPS → CMVideoFormatDescription
                                                        │ VTDecompressionSession (RealTime, 420v → x420 → BGRA)
                                                        ▼
                                              latest PocketVideoFrame (lock, latest wins)
                                                        │
             ┌──────────────────────────────────────────┴───────────────────────────────┐
 PocketVideoView (MTKView, main-thread display link ≤60 Hz)            PocketScopeView (MTKView, ≤20 Hz)
   ingest (CVMetalTextureCache planes → RGBA signal)                  ingest → measure (≤256 px wide)
   [peaking blur → peaking mask, source res]                          clear bins → accumulate (atomics)
   picture pass → drawable                                            → reduce (peak) → draw
```

- **Decoder** (`PocketVideoSession.swift`): one per `sessionId`, shared and ref-counted by the
  views (`PocketVideoSessionHub`), registered in `PocketVideoSinkRegistry` while any view uses it.
  Parameter sets are taken from the AUs; a changed set rebuilds the format description, and the
  session is recreated when `VTDecompressionSessionCanAcceptFormatDescription` says no. After a
  (re)create, `reset()`, a codec change or a decode error, non-IRAP AUs are dropped until an IRAP
  (HEVC 16–21, AVC IDR). AUD/SEI/DJI marker (63) and Nano's private SEI are never fed to VT.
  `kVTInvalidSessionErr` (background, media-server reset) rebuilds the session.
- **Back-pressure**: `receive` never blocks. More than 4 AUs waiting means decode fell behind:
  AUs are shed until the next keyframe AU (latency stays bounded; shed AUs count as dropped).
- **Present policy**: the display link draws only when the session holds a newer frame than the
  one on screen, or props changed. Intermediate frames are counted as dropped (`droppedFrames`
  = decoder drops + superseded frames). `onFrameStats` fires ~1 Hz.
- **Demo scenes** (`sessionId == null`, `demoScene` set): procedural studio / bars / skin / night
  generated in scene-linear light and encoded with the selected `sourceColor` transfer, so the
  display transform, false colour and scopes behave exactly as with a camera. 1280×720, 30 Hz.

## Per-pixel effects (`PocketVideoShaders.swift`)

Order: signal → display transform (`sourceColor`) → LUT mixed by `lutIntensity` → monochrome →
false colour → peaking → zebra. Measurements (zebra, false colour, peaking) read the camera
signal, never the graded picture. Uniforms: 17 `float4` slots documented in
`PocketVideoFxUniforms` (identical order on Android and the web).

| Field | Semantics |
| --- | --- |
| `sourceColor` | Log/HLG decode (LiveColorScience curves) → source gamut → Rec.709 (D-Gamut, D-Gamut2, BT.2020; D-Log M pass-through) → `MonitorSceneToneMap` (contrast 1.1, scene white = decode(1)). Rec.709 is identity. |
| `lutId`, `lutIntensity` | 3D texture (RGBA16F, red fastest, DOMAIN_MIN/MAX honoured) sampled with the **camera signal** as input; output mixed with the display transform by intensity. |
| `falseColor` | `cinestop`: scene stops (luma linearised) with the clip band from the ceiling shelf (7 codes). `video`, `ire`: published bands on WAVE IRE of luma, gaps greyscale. `limits`: crush/clip bands only, gaps keep the picture. |
| `zebra.upper` | Monitor IRE (0–100, WAVE axis); paints where the max RGB channel reaches it (1 IRE soft edge below). |
| `zebra.lower` | Midtone centre in monitor IRE, ±5 IRE on luma (upstream `LiveZebra`); `null` = off. |
| `zebra.paint`, `stripes` | Paint colour (0–1; 0–255 accepted); 45° stripes, 7.07 pt pitch, or solid. |
| `peaking` | Desktop `peaking_blur/mask/feed` port: Roberts ratio fine/coarse vs `ratioThreshold` (Low 2.30 / Med 2.10 / High 1.90), `noiseGate` (0.00522 / 0.00174 / 0.00058), closed stroke + dark hairline under it. |
| `desqueeze` | Display aspect × factor (horizontal) or ÷ factor (vertical), then fit/fill. |
| `mirror` | Horizontal flip of the displayed picture. |
| `monochrome` | Rec.709 luma of the graded picture (false colour still paints in colour). |

Clip ceilings use the reference-EI bytes (D-Log2 247, D-Log 223, others 255): the contract has no
ISO, so the core's ratcheting ceiling is not modelled.

## Scopes (`PocketScopeView.swift`)

Waveform (`options.mode` luma/rgb), parade, histogram (luma/rgb), vectorscope (`options.zoom`
1/2). Y axis = `ScopeDisplayScale.waveformLevel` on the signal's anchors (0 → 5 %, 100 → 95 %,
18 % grey at paper IRE), or Rec.709 anchors when `measureAfterLut`. Density is logarithmic,
`(0.4 + 0.6·density) × brightness`; vectorscope tint follows `ScopeChroma.traceTint`.

## Module functions (`PocketVideoModule.swift`)

- `loadLut(id, cubeText)` → size; parsed once, one texture shared by all views. `unloadLut(id)`.
- `snapshot(sessionId, withEffects)` → `file://…/Caches/pocket-snapshots/*.jpg`; with effects it
  uses the effects of the last drawn picture of that session at source size (desqueezed).
- `sampleFrame(sessionId, w, h)` → `{ width, height, rgba }` of the raw signal, stretched.

## Threading

- datalink queue: `receive` / `reset` enqueue only.
- `decodeQueue` (per session): all VideoToolbox state. Output handler publishes under a lock.
- main thread: props, MTKView draw (encode + commit; the GPU runs asynchronously). CoreVideo
  textures are retained until their command buffer completes.
- Swift concurrency pool: `snapshot` / `sampleFrame` / `loadLut` (`@JS(.concurrent)`), each with
  its own renderer instance.

## Verify on a device (not compiled here: no Xcode in the authoring environment)

1. It builds: `@ExpoModule` + `@JS` + `@Record` (checked with `ExpoModulesMacros expand
   --diagnostics-only`) together with the `View(…)` DSL in `definition()`.
2. Runtime MSL compile (`makeLibrary(source:)`) succeeds on device and simulator.
3. Pocket 3/4 HEVC and Nano AVC decode; first frame after connect, after background/foreground
   (`kVTInvalidSessionErr` rebuild) and after a resolution change.
4. Colour: Rec.709 matches the camera's own screen; D-Log2/D-Log display transform looks sane.
5. Zebra / false colour thresholds against a known chart; peaking sensitivity vs desktop.
6. Latency (glass-to-glass) and `onFrameStats` numbers under load; shedding behaviour on a bad link.
7. Scope traces vs desktop `opc-monitor` scopes on the same feed.
