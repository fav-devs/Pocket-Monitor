# Desktop parity audit against the iOS app

Five read-only sweeps compared the desktop viewfinder (`Apps/Desktop`) with the
upstream iOS app (`ios/OpenPocketCine`, behaviour spec `docs/PARITY.md`) on 2026-09-22,
after the shared Swift core was synced to upstream. This page keeps every finding so
nothing is lost between passes. Fixed items are marked with the pass that fixed them;
everything else is ranked within its area, most consequential first.

The rule for every fix: protocol bytes and camera decisions live in the Swift core and
reach the desktop through the C facade (`Sources/OpenPocketCineDesktopFacade`). Where
the desktop needs a number the phones use, it asks the core rather than copying it.

## Tracking and focus

| # | Finding | State |
|---|---------|-------|
| 1 | `0x02/0xA6` TrackSet sent the top-left corner; the wire is centre and size. | Fixed, pass 1 |
| 2 | No `0x02/0x89` live push: the box only moved on the 0.5 s poll. Now parsed by the core, eased with `TrackingBoxSmoothing`, dropped on `pushSilence`. | Fixed, pass 1 |
| 3 | A box the body reported was drawn without undoing MIRROR. Boxes are now kept on the sensor and mirrored when drawn. | Fixed, pass 1 |
| 4 | Tap-focus burst went out as four writes at once; Mimo waits for the `0x30` ACK before the hint and commit. | Fixed, pass 1 (0.4 s grace when the body never answers) |
| 5 | `X` always sent TrackClear, even with nothing out; a leftover push resurrected the box. `TrackingClearPolicy.leftoverIgnore` now applies. | Fixed, pass 1 |
| 6 | No Frame Too Small gate: boxes under `mimoMinimumSide` (0.09) were sent and never locked. | Fixed, pass 1 |
| 7 | Lock without a subject rectangle drew the whole search box; the phones draw the 45 % stand-in. | Fixed, pass 1 |
| 8 | `ACQUIRING SUBJECT` / `TRACKING SUBJECT` labels do not exist on iOS; the phones draw white search brackets and green lock brackets. | Fixed, pass 1 |
| 9 | Disconnect left a stale box on screen. | Fixed, pass 1 |
| 10 | `FocusTrackGet` was never sent, so the Focus track row started blank. Sent after the subscriptions now. | Fixed, pass 1 |
| 11 | TT180 / selfie-flip: the phones add a second mirror term when the body reports a flipped picture. The desktop has no Selfie Flip GET (`0x8E` pid `0x38`) and no flip term. | Open |
| 12 | The AF box on the phones is a persistent blue square (14 %, `#00A3E0`); the desktop only shows a yellow reticle for 1.5 s after a tap. | Open |
| 13 | Guides and boxes are not mapped onto the recorded picture rect (4:3, 1:1, 9:16 formats in a 16:9 well). | Open |
| 14 | Glamour effects are never switched off on connect the way the phones do. | Open |
| 15 | Starting a track does not cancel a running programmed move. | Open |
| 16 | Focus-track watchdog grace (`secondsSinceFocusTrackSet`) is fed but the AF-C face bracket the phones draw needs an on-device detector the desktop lacks. | Open |

## Video format and shooting modes

| # | Finding | State |
|---|---------|-------|
| 1 | Frame-rate index `0x13` (200 fps) missing from the table. | Fixed, pass 1 (table now lives in the core) |
| 2 | Chip read `4K·30`; the phones read `4K · 30p` with the aspect when not 16:9. | Fixed, pass 1 |
| 3 | The FORMAT sheet was dead on a Pocket 3 (no camcap). `CamCapVideoFormat.pickerFormats` fills the documented Video / SlowMo / Low-Light tables; other bodies invent nothing. | Fixed, pass 1 |
| 4 | SlowMo format SET lacked the captured trailer (`00 04 00` / `00 08 00`) on a Pocket 3 / 4 Pro. The session now encodes with model and mode context. | Fixed, pass 1 |
| 5 | Photo went out as `0x17` on every body; Pocket 3 and Nano take `0x05`. | Fixed, pass 1 |
| 6 | Mode strip showed dead PANO / LIVESTREAM and lacked HyperLapse; Live Photo (`0x4D`) was not read as a stills mode. | Fixed, pass 1 |
| 7 | Record button in a stills mode started a video; it now takes the picture. Mode changes are refused while rolling. | Fixed, pass 1 |
| 8 | Mode change should clear mode-dependent capability lists. Automatic in the synced core (`CameraStatus.applyShootingMode`). | Fixed by the core sync |
| 9 | The FORMAT sheet has no aspect tabs (16:9 / 4:3 / 1:1 / 9:16) the phones show. Every legal pair is listed in one row instead. | Open |
| 10 | Pocket 3 TimeLapse start/stop is the `0x02/0x01` shutter trigger, not record. The desktop has no such command kind yet. | Open |
| 11 | The FORMAT pin only holds the chip; the phones pin the whole picker while a SET is in flight. | Open |
| 12 | Format-ceiling note when the zoom stops change with the format. | Open |

## Exposure, white balance and colour

| # | Finding | State |
|---|---------|-------|
| 1 | Auto/Manual (`0x1E`) was conflated with Auto ISO: index `0x00` was unreachable. The ISO wheel now carries Auto and the ceiling row follows it. | Fixed, pass 1 |
| 2 | One ISO ladder for every colour; Mimo offers per-colour ladders (D-Log starts at 400, D-Log2 has no Auto). | Fixed, pass 1 |
| 3 | Auto ISO labels always started at 100; Pocket 3 and Pocket 4 start at 50, D-Log at 400. | Fixed, pass 1 |
| 4 | Shutter fallback was a 13-stop guess; the core's 22-stop video ladder with the live value merged in is used. | Fixed, pass 1 |
| 5 | EV read `+0.0` / `-1.3`; the phones read `0.0` and use U+2212. | Fixed, pass 1 |
| 6 | White-balance presets zeroed the tint the operator had set. | Fixed, pass 1 |
| 7 | Colour row was a hard-coded three-mode list; the wheel is now the body's own via `CamCapColorMode.wheel`, and refused while rolling. | Fixed, pass 1 |
| 8 | Unknown readouts showed `0%`, `0 GB`, `AUTO`; the phones show `—`. | Fixed, pass 1 |
| 9 | No shutter angle mode. | Open |
| 10 | ISO / shutter stepping (`[` `]` and the wheel keys) should follow `IsoIndex.stepped` / `CamCapShutter.steppedDenom` rules exactly; they use the same ladders now but their own index walk. | Open |
| 11 | Kelvin drum and tint slider for white balance; the desktop offers presets only. | Open |
| 12 | Exposure SETs should coalesce (100 ms) instead of retransmitting each tick. | Open |
| 13 | D-Log ISO hop on a zoom, value pins after a SET, "—" expo chip: partially covered; the pin logic is only on FORMAT. | Open |

## Chrome and gimbal

| # | Finding | State |
|---|---------|-------|
| 1 | Arrow keys bypassed `stick_axes` when the ramp was off (axes swapped, fixed ±400 throw). They go through the core mapping now. | Fixed, pass 1 |
| 2 | FOLLOW chip only shows ON/OFF and disagrees with the `V` cycle (Follow / Tilt locked / FPV); Direction Lock is missing. The chip now at least follows the body's reported family (FPV / follow). | Partly fixed, settings pass |
| 3 | Picture-relative pan and the extra-mirror term while mirrored. | Open |
| 4 | Recenter and flip should rest the stick and cancel a programmed move first. | Open |
| 5 | Record confirmation (Mimo's stop confirmation) is absent. | Open |
| 6 | Battery amber band, charging glyph, STBY tally, timecode default, link-health bars. | Open |
| 7 | Notices are swallowed while a move is running. | Open |
| 8 | Zoom pin after a SET, double-tap 1× ↔ 3× on the zoom ruler. | Open |

## Assists and scopes

| # | Finding | State |
|---|---------|-------|
| 1 | Nothing about assists, scopes or the LUT choice persists between runs (`prefs.rs` holds only link and control prefs). | Open |
| 2 | The vectorscope reads the ungraded log picture; the phones read the graded one. | Open |
| 3 | Guides and overlays are not mapped to the recorded picture rect. | Open |
| 4 | Zebra slider (the phones let the operator set the threshold). | Open |
| 5 | The desktop's WAVE/PARADE and HISTO plots sit on two different axes: waveform rows plot the core level (IRE 0 at 5 % up the plot), the histogram undoes it and spans edge to edge, so a HISTO column and a WAVE row do not line up. Not a wrong core call: the desktop consumes the shared `ScopeDisplayScale` faithfully, and it is the iOS app that layers a single `WaveformAxis` over all three plates. Fix: put the three plates on one axis. | Open (corrected during the audit) |
| 6 | Crush / Clip toggles move the lines at IRE 0 / 100, which the phones draw permanently; the dotted IRE 5 / 95 safe borders those toggles are meant to control are permanently on. | Open |
| 7 | FALSE reference should arm FALSE; guides should switch off when none is selected. | Open |
| 8 | LUT Auto row, 50/50 split and exposure offset; AUDIO plate options. | Open |

## Settings sheet (found on the settings pass)

| # | Finding | State |
|---|---------|-------|
| 1 | No wheel reached the chrome: a sheet taller than the window (Output, Camera on a small window) had rows nobody could reach, and rows with more chips than fit (ISO, shutter, EV, Pocket 3 formats) hid their far chips. | Fixed, settings pass |
| 2 | Audio channel and vocal boost rows showed the last pick, not the camera: the body was never asked and the status record did not carry them. | Fixed, settings pass |
| 3 | The gimbal mode chip never learned a mode set on the body. | Fixed, settings pass (family only) |
| 4 | DISP `2 · Clean` hid the sheet the operator was using to set it. | Fixed, settings pass |
| 5 | Field of view, gimbal speed and audio picks are not re-applied on connect, so a body power-cycled to its defaults disagrees with the FOV chip until it is set again. | Open |
| 6 | The Nano has no focus mode or tap focus; the Camera tab still offers the Focus rows on one. | Open |

## Media and connection

| # | Finding | State |
|---|---------|-------|
| 1 | The watchdog ran while the library or a playback was open and could rebuild the feed under the operator. `repairReady` is now driven from the shell (`repair_blocked`). | Fixed, pass 1 |
| 2 | `tcp_poke_ready` and `path_ready` were hard-coded; the snapshot now reports what the session has set (poke readiness stays off, which is the honest default until the session learns the body's poke support). | Fixed, pass 1 (path readiness still has no caller) |
| 3 | Resume policy lacks `waitForPicture` / `exhausted`; `last_presented` is never fed from the live branch; `stray_playback_action` is never called. | Open |
| 4 | Auto LUT is inert on a proxy (no `color.json` read; `get_range` unused). | Open |
| 5 | Catalogue page order is reversed and the SD cursor walks. | Open |
| 6 | Pocket 3 `0x01/0x01` playback-entry burst is not in upstream; keep it desktop-only and documented. | Noted |
| 7 | Delete and favourite are fire-and-forget; no Selfie Flip GET; no live-view prepare `0x02/0x68`; no first-picture ladder beyond the Pocket 3 format poke. | Open |
| 8 | The pairing state machine in `pairing.rs` is unused; no automatic reconnect; Xtra (port 10004) unsupported; setup tab gaps. | Open |

## How pass 1 was verified

Unit tests on the Rust workspace with the core unlinked mirror the core's numbers
(`opc-camera/src/capture.rs`, `opc-camera/src/tracking.rs`) and are the only proof a
Linux container can give. The linked wire tests (`opc-camera/tests/wire.rs`) check the
Pocket 3 photo byte and the SlowMo trailer against the core once the Swift library is
built. The tracking brackets, the live push and the format sheet on a Pocket 3 still
need a physical Windows machine and a camera, per `AGENTS.md`.
