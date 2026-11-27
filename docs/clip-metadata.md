# Clip metadata: markers, tags, shoots and the sidecar

Pocket Monitor lets the operator mark moments while recording, tag and annotate clips, group them
into shoots, and hand all of it to an editor next to the clip. This document is the spec of the
sidecar file (format v1) and of how the app fills it. AI Cut (Sondr) is the first reader; the
import mapping at the end is a proposal for it.

Code: `Apps/Mobile/src/core/markers/` (pure, tested), `src/state/clipMeta.ts` (storage),
`src/features/markers/` (capture, UI, files). Desktop: `pm_controller::sidecar`,
`pm-desktop/src/media.rs` (`media_sidecar`, `markers_save`). Schema:
[`clip-metadata.schema.json`](clip-metadata.schema.json).

## 1. Making markers while recording

| Where | How |
| --- | --- |
| Live view | The **Marker** button (flag), shown while recording. A movable item of the live layout (`marker`, default under REC / timecode at the picture's leading top corner). Its badge counts this take's markers. |
| Keyboard | **M** (web, and the desktop app through Rust `keys::route` → `UiAction::Marker`). Mirror moved from M to **I**. |
| Gamepad | **Menu** (Start / Options) on phones, web and the desktop (`pad::PadButton::Menu` → `PadAction::Marker`). |
| Hand gestures | The action **Add marker** (`GestureAction::Marker`, key `marker`) in the gesture map. Not mapped to any gesture by default. |

Each marker shows a toast for four seconds: `Marker 3 · 00:41` and chips (Good, Bad, Hook,
B-roll, Retake, then the operator's own tags). A chip tags the marker (again: untags) and sets
its colour. Not recording: the toast says `Not recording` and nothing is stored.

### Timing

A marker's time is the take's position by the **camera's own recording clock**, so it lands on
the right frame of the file:

- The camera reports the take's elapsed seconds (`RecordingState.elapsedSec`, the status push's
  `recordElapsedSec`). When it steps to `E`, the camera's `E`-th second has just begun, so
  `now − E` estimates the first frame plus the report's delay. The earliest estimate wins
  (least delayed), and between reports the phone clock carries the fraction, kept inside
  `[E, E + 1)` of the last report (`core/markers/clock.ts`).
- A camera that reports no elapsed time falls back to the phone's clock from when REC was seen,
  backdated by `PHONE_START_OFFSET_SEC` (0.15 s: REC rides the 5 Hz status push). Such markers
  carry `take.timeSource: "phone"`. This offset is an estimate; check it on hardware.
- `frame = round(time × fps)` at the take's frame rate.

### Takes and matching

REC on opens a **take**: its start, the format (fps, resolution, colour, codec), the camera, the
active shoot, a take number (per shoot, else per day) and the files listed before it. Markers go
on the take. REC off closes it with the camera's elapsed time as its length. Takes are persisted,
so they survive an app restart.

Whenever the camera's library lists, waiting takes are matched with files
(`core/markers/takes.ts`):

- **time**: the file's own time (DJI names files after their start) within 2 min of the take's
  start or stop;
- **duration**: within max(1.5 s, 3 %) of the take's;
- **novelty**: a file not listed when the take began and newer than every file that was — this
  carries the match when the camera's clock is off, as long as the duration agrees;
- best fits first, one take per file, takes from another camera wait for that camera.

A matched take gives its clip the markers, the shoot and the take; it then leaves the waiting list.

## 2. In the library and playback

- Playback: marker pins on the filmstrip (tap seeks, hold edits label / tag / colour / delete); a
  **Markers** tool opens the clip's markers (tap to seek, hold to edit, **Add marker at the
  playhead**), tags, notes and shoot. The desktop's inspector shows the same section. Rating and
  favourite are the existing ones.
- Library: a marker count on each tile, tag chips under the categories (clips carrying every
  chosen tag; clip tags and marker tags both count), a shoot filter, **Group by shoot** in Sort and
  view, and search over tags, notes, marker labels and the shoot's name and folder.
- Selection → **More**: Move to shoot, Tags, Export markers.
- Shoots: from the live view's settings panel (Camera tab, **Shoot**) and the library (folder
  button): start one (name + optional folder path like `Vlog/Tokyo/Day 2`), make one active,
  rename, end. Clips recorded while a shoot is active join it.

## 3. Storage

`src/state/clipMeta.ts`, key `pm.clipMeta.v1` in the app's persisted storage (AsyncStorage: app
storage on iOS / Android, localStorage on web and in the desktop app's web view), versioned and
read defensively (a damaged entry is dropped, never thrown). Entries are keyed by the media item
id, which is the same for a clip on the camera and its copy on the phone, and carry the camera
file's identity (name, size, time, format, camera). A clip listed under another id is found by
its file name and size. Nothing in it is logged; it leaves the device only in a sidecar or an
export the operator makes.

## 4. The sidecar, format v1

One JSON file per clip, UTF-8, named **`<clip basename>.pocketmeta.json`**
(`DJI_20261127100000_0001_D.MP4` → `DJI_20261127100000_0001_D.pocketmeta.json`), beside the clip.

```json
{
  "format": "pocket-monitor.clip-metadata",
  "version": 1,
  "app": { "name": "Pocket Monitor", "version": "0.1.0", "platform": "ios" },
  "writtenAt": "2026-11-27T10:02:11.000Z",
  "clip": {
    "fileName": "DJI_20261127100000_0001_D.MP4",
    "createdAt": "2026-11-27T10:00:00.000Z",
    "durationSec": 41.2,
    "fps": 30,
    "width": 3840,
    "height": 2160,
    "colorMode": "dlog-m",
    "codec": "h265",
    "sizeBytes": 51500000,
    "camera": { "model": "osmo-pocket-3", "name": "Pocket 3", "serial": "SN…" }
  },
  "markers": [
    { "id": "m…", "time": 3, "frame": 90, "label": "", "tag": "Good", "color": "green", "createdAt": "2026-11-27T10:00:03.010Z", "source": "key" },
    { "id": "m…", "time": 12.4, "frame": 372, "label": "Laugh", "tag": "Hook", "color": "yellow", "createdAt": "2026-11-27T10:00:12.400Z", "source": "button" }
  ],
  "tags": ["B-roll"],
  "rating": 4,
  "favorite": true,
  "notes": "Wide of the market",
  "shoot": { "id": "s…", "name": "Tokyo", "folderPath": "Vlog/Tokyo/Day 2" },
  "take": { "id": "t…", "number": 3, "startedAt": "2026-11-27T10:00:00.020Z", "timeSource": "camera" }
}
```

| Field | Meaning |
| --- | --- |
| `format`, `version` | Always `pocket-monitor.clip-metadata`; `1`. A reader reads a newer version as far as it understands it. |
| `app` | Writer, its version, `ios` / `android` / `web` / `desktop`. |
| `clip` | The clip's identity as the camera wrote it. Unknown values are `null`. `camera.model` uses the app's ids (`osmo-pocket-3`, `osmo-pocket-4`, `osmo-pocket-4-pro`, `osmo-nano`, `osmo-action-6`). `derivedFrom` (only on a clip exported from the editor): the source file and the kept range in its seconds. |
| `markers[]` | Sorted by time. `time`: seconds from the clip's first frame (ms precision). `frame`: nearest frame at `clip.fps`. `tag`: one tag or `null`. `color`: `blue cyan green yellow red pink purple cream` (DaVinci Resolve's names). `source`: `button key gamepad gesture playback import`. |
| `tags` | Clip tags (≤ 32 characters each). Marker tags are on the markers. |
| `rating`, `favorite` | 0 unrated, 1–5; the star. |
| `notes` | Free text. |
| `shoot` | `folderPath` is `/`-separated folders; empty means use `name`. `null` outside a shoot. |
| `take` | Take number in its shoot (or day), the first frame by the recording phone's clock, and whether marker times follow the camera's clock (`camera`) or the phone's (`phone`). `null` for clips this app did not see recorded. |

Rules:

- **Forward compatible.** Readers keep every field they do not know — at the top level and inside
  `app`, `clip`, `shoot`, `take` and each marker — and writers put them back unchanged
  (`parseSidecar` → `buildSidecar` round-trips them; tested).
- Times are ISO 8601 UTC; durations and positions are seconds.
- Writers replace the whole file (the desktop writes a `.part` file, then renames).
- Built-in tag colours: Good green, Bad red, Hook yellow, B-roll cyan, Retake purple, the
  operator's own pink, none blue.

### Where sidecars are written

| When | Where |
| --- | --- |
| A clip is downloaded to the phone | Beside the downloaded original, and a copy in `Documents/Sidecars/`. Rewritten whenever its metadata changes. |
| Downloaded in the desktop app | Beside the cached original (`media_sidecar`: now if the original is cached, else when its download lands). |
| Saved to Photos | Photos takes no sidecar: the copy in `Documents/Sidecars/` (and the app's storage) keeps it. |
| Exported from the clip editor | `<export name>.pocketmeta.json` in `Documents/Sidecars/`, markers moved back by the trim start and those outside the trim dropped, `clip.derivedFrom` set. |
| Shared | The share sheet gets the clip, then its sidecar (Settings → Media → **Send markers file**, on by default). On web both download. |
| Web (browser) | No file system: sidecars travel through share / download only. |

A clip copied in with a sidecar beside it takes that sidecar's metadata (markers merged by id).

## 5. Export markers

Library → select clips → More → **Export markers**. Phones open the share sheet, the browser
downloads, the desktop saves to `Videos/Pocket Monitor/Markers/` (never over an earlier file).

| Format | Contents |
| --- | --- |
| Final Cut Pro (FCPXML 1.10) | One event (the shoot, else "Pocket Monitor"); each clip an `asset-clip` referencing `./<file name>` (relink on import), with `marker`s (value = label / tag / "Marker N", note = tag · label), clip tags as a `keyword`, favourite (or 4–5 stars) as a `rating`, notes as `note`. NTSC rates are 1001-based. |
| DaVinci Resolve (EDL) | A marker EDL for *Timeline → Import → Timeline Markers from EDL*: the clips end to end from 01:00:00:00 at the first clip's rate, one event per marker, `|C:ResolveColor… |M:name |D:1`. For one clip, put it at 01:00:00:00 on a timeline and import. |
| DaVinci Resolve (CSV) | `File Name, Marker Name, Notes, Color, Source In, Duration, Frame, Seconds, Keywords, Clip Tags, Rating`, clip time. |
| Premiere Pro (CSV) | Premiere's marker export columns `Marker Name, Description, In, Out, Duration, Marker Type`, then `File Name`. |

Timecodes are non-drop at the clip's rate rounded to a whole number.

## 6. AI Cut import (proposal)

Nothing here is implemented in AI Cut yet; it is how the sidecar maps onto its model
(`packages/editor-core/src/model/{media,timeline}.ts`).

| Sidecar | AI Cut |
| --- | --- |
| `markers[]` | **Clip markers** on the media asset, in source time: a new optional `MediaAssetData.markers?: { id; time: MediaTime; label?; tag?; color? }[]` (`MediaTime` = `round(time × 120 000)` ticks). Like `beatMarkers` on audio elements they stay in source time, so trims, splits and speed changes keep them on the picture; the timeline draws those inside a `VideoElement`'s `trimStart … sourceDuration − trimEnd` on the clip. "Add to scene" could also turn them into scene `Bookmark`s (`note` = label, `color`). |
| `tags`, marker tags | Library filters (a new `MediaAssetData.tags?: string[]`), searchable. |
| `shoot.folderPath` (else `shoot.name`) | Media folders: `folderName`, nested by `/`. |
| `rating`, `favorite` | Library rating / favourite filters. |
| `notes` | The asset's description. |
| `take.number`, `clip.camera` | Shown in the asset's info; `"Take 3"` as a default name suffix. |
| `clip.fileName`, `clip.sizeBytes` | Dedupe: the same camera file imported twice is one asset. |

Routes from Pocket Monitor to AI Cut:

- **iOS: App Group shared container.** Both apps under one team share an App Group
  (`group.<team id>.video.shared`). Pocket Monitor writes `Inbox/<shoot folder>/<clip>` and its
  `.pocketmeta.json` there and opens `sondr://import?source=pocketmonitor`; AI Cut imports what is
  in the inbox. Needs the entitlement on both apps (Pocket Monitor's `ios.appleTeamId` is not set
  yet).
- **Android: share intent.** `ACTION_SEND_MULTIPLE` with the clip (`video/*`) and the sidecar
  (`application/json`) and read grants; AI Cut's share target reads both. Or
  `sondr://import?clip=<content uri>&meta=<content uri>` with `FLAG_GRANT_READ_URI_PERMISSION`.
- **Desktop.** A drop folder `Videos\Sondr\Inbox\<shoot folder>\` that AI Cut's local server
  watches (it already keeps projects under `Videos\Sondr`), or the **companion**: a file offer
  with `purpose: "pocket.clip"`, the clip as the file and the sidecar JSON in `FileMeta.info`
  (the same transport `originals.ts` and `deliveries.ts` use).

## 7. Verify on hardware

Web preview and tests prove the logic, not the camera. On a phone with a Pocket 3 / 4:

1. Record ~20 s, add markers by button, M (hardware keyboard) and the pad's Menu; clap on camera
   at a marker. Stop.
2. Open Media (Camera): the new clip has the marker badge; in playback each pin lands on the clap
   frame (±1 frame with `timeSource: camera`).
3. Kill the app mid-take and after stop, relaunch, list: markers still land on the clip.
4. Download the clip: `DJI_….pocketmeta.json` beside it (Files app / adb), valid against the schema.
5. Trim in the editor and export: the library sidecar's markers are shifted.
6. Share: the share sheet offers the clip then the sidecar.
7. Desktop: download a clip; the sidecar is beside it in the media cache; Export markers writes to
   `Videos/Pocket Monitor/Markers`; import the FCPXML / EDL into Final Cut / Resolve.
