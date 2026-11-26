//! The camera library's decisions for the Tauri app, without a window (§1.U).
//!
//! `opc-monitor`'s `library.rs` mixed these with the Slint grid (tile metrics, cell
//! state, the selection bar). The web build already draws the grid, the day headers,
//! the bursts and select mode (`features/media`), so what moves here is only what the
//! Rust side must decide: which records the camera listed (merged page by page, cached
//! per camera), the local star overlay, which handles may ever go on the wire for a
//! delete (only ones the core's fit vouched for, one record per handle), the media
//! command counter, and the conform preview's targets and speed from the core. The
//! mobile `CameraMediaItem` shape is built here so the web reads one vocabulary.

use std::collections::HashSet;

use opc_camera::Command;
use opc_media::{query, LibrarySort, LibraryTab, MediaFile};
use serde::Serialize;

/// One record as the web's `CameraMediaItem` (plus the desktop's own flags).
///
/// The `id` is the camera path: stable across listings, and what every `media_*`
/// command and `pm://` URL takes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub kind: &'static str,
    pub file_name: String,
    /// Milliseconds since 1970 from the name's stamp, read as UTC (the stamp the body
    /// bakes into `DJI_20260814125250_…`); 0 when the name carries none.
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<i64>,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<i64>,
    pub favorite: bool,
    /// The burst a member belongs to (`burstRegex`), so the web folds it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// The fit vouched for its handle: DELETE can go out.
    pub deletable: bool,
    /// The original is in the cache (`files/`).
    pub cached: bool,
    /// A proxy is in the cache (`play/`).
    pub proxy_cached: bool,
}

/// What a delete did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Deleted {
    /// One `MediaDelete` per vouched handle, each with its own counter.
    pub commands: Vec<Command>,
    /// The paths that went.
    pub deleted: Vec<String>,
    /// Paths that stayed: unknown, or a handle the fit did not vouch for.
    pub refused: Vec<String>,
}

/// The card as listed, the local stars, and what is on this machine.
#[derive(Debug, Clone, Default)]
pub struct Library {
    pub files: Vec<MediaFile>,
    /// Local stars, overlaid on the camera's own (`favorites.json`).
    pub favorites: HashSet<String>,
    /// Originals on disk.
    pub cached: HashSet<String>,
    /// Proxies on disk.
    pub proxies: HashSet<String>,
    /// A listing is running.
    pub listing: bool,
    /// The last word about the listing ("The list did not read: …").
    pub status: String,
    counter: u32,
}

impl Library {
    pub fn file(&self, path: &str) -> Option<&MediaFile> {
        self.files.iter().find(|file| file.path == path)
    }

    pub fn is_starred(&self, file: &MediaFile) -> bool {
        file.is_starred || self.favorites.contains(&file.path)
    }

    /// A decoded page. A record already known is replaced (the fit hands out fresh
    /// handles per listing, and a delete must use the fresh one); a new one is added.
    /// Nothing is dropped: a Pocket 3 lists only its newest page outside playback, so a
    /// short listing is not proof a file has gone.
    pub fn listed(&mut self, files: Vec<MediaFile>) {
        for file in files {
            match self.files.iter_mut().find(|known| known.path == file.path) {
                Some(known) => *known = file,
                None => self.files.push(file),
            }
        }
    }

    /// The grid in a tab and an order; `local` keeps only what is on this machine, the
    /// way Mimo's Local album works. The web filters on its own; this is the old
    /// desktop's rule, kept for the tests and for a Local view.
    pub fn visible_files(
        &self,
        tab: LibraryTab,
        local: bool,
        sort: LibrarySort,
    ) -> Vec<&MediaFile> {
        let mut filtered = query::filtered(&self.files, tab, &self.favorites);
        if local {
            filtered.retain(|file| {
                self.cached.contains(&file.path) || self.proxies.contains(&file.path)
            });
        }
        query::sorted(filtered, sort)
    }

    /// Every record as the web reads it, newest first.
    pub fn items(&self) -> Vec<MediaItem> {
        self.visible_files(LibraryTab::All, false, LibrarySort::Newest)
            .into_iter()
            .map(|file| self.item(file))
            .collect()
    }

    pub fn item(&self, file: &MediaFile) -> MediaItem {
        let video = file.is_video();
        let (width, height) = file
            .resolution
            .as_deref()
            .and_then(dimensions)
            .map_or((None, None), |(w, h)| (Some(w), Some(h)));
        MediaItem {
            id: file.path.clone(),
            kind: if video { "video" } else { "photo" },
            file_name: file.filename().to_string(),
            created_at: file
                .filename_timestamp()
                .and_then(created_at_ms)
                .unwrap_or(0),
            duration_sec: video.then_some(file.duration_seconds),
            size_bytes: file.size_bytes,
            width,
            height,
            fps: file.fps,
            favorite: self.is_starred(file),
            group_id: file.burst_group_key().map(str::to_string),
            deletable: file.is_deletable(),
            cached: self.cached.contains(&file.path),
            proxy_cached: self.proxies.contains(&file.path),
        }
    }

    /// The media command counter: wraps, never zero.
    pub fn next_counter(&mut self) -> u32 {
        self.counter = self.counter.wrapping_add(1).max(1);
        self.counter
    }

    /// A star set or cleared: the local overlay follows, and the camera is told when the
    /// record carries a handle to tell it with.
    pub fn set_favorite(&mut self, path: &str, on: bool) -> Option<Command> {
        if on {
            self.favorites.insert(path.to_string());
        } else {
            self.favorites.remove(path);
        }
        let counter = self.next_counter();
        let file = self.files.iter_mut().find(|file| file.path == path)?;
        file.is_starred = on;
        let handle = file.favorite_handle();
        (handle != 0).then_some(Command::MediaFavorite {
            handle,
            counter,
            on,
        })
    }

    /// One delete per path the fit vouched for, each with its own counter. The web asks
    /// for confirmation first (the old DELETE's arm-then-send); only a vouched handle
    /// ever goes on the wire, so a shared or unknown handle stays, and says so.
    pub fn delete(&mut self, paths: &[String]) -> Deleted {
        let mut out = Deleted::default();
        for path in paths {
            let Some(file) = self.file(path).cloned() else {
                out.refused.push(path.clone());
                continue;
            };
            if !file.is_deletable() {
                out.refused.push(path.clone());
                continue;
            }
            self.files.retain(|f| f.path != *path);
            self.favorites.remove(path);
            let counter = self.next_counter();
            out.commands.push(Command::MediaDelete {
                handle: file.handle,
                counter,
            });
            out.deleted.push(path.clone());
        }
        out
    }
}

/// `3840x2160` (or `3840×2160`) to its numbers.
pub fn dimensions(resolution: &str) -> Option<(u32, u32)> {
    let (w, h) = resolution
        .split_once(['x', 'X', '×'])
        .map(|(w, h)| (w.trim(), h.trim()))?;
    Some((w.parse().ok()?, h.parse().ok()?))
}

/// `YYYYMMDDHHmmss` as milliseconds since 1970, read as UTC.
pub fn created_at_ms(stamp: &str) -> Option<i64> {
    if stamp.len() != 14 || !stamp.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let field = |from: usize, to: usize| stamp[from..to].parse::<i64>().ok();
    let (y, m, d) = (field(0, 4)?, field(4, 6)?, field(6, 8)?);
    let (hh, mm, ss) = (field(8, 10)?, field(10, 12)?, field(12, 14)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let days = days_from_civil(y, m as u32, d as u32);
    Some(((days * 24 + hh) * 60 + mm) * 60_000 + ss * 1000)
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (i64::from(m) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The conform preview of the open clip (V3): the core's targets below its capture
/// rate, the one the chip is on, and the speed the clock runs at.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Conform {
    pub capture_rate: f64,
    pub targets: Vec<f64>,
    pub current: Option<f64>,
}

impl Conform {
    /// A clip opened: the targets from the core, the chip off.
    pub fn for_clip(capture_rate: f64, listed_fps: f64) -> Self {
        Self {
            capture_rate,
            targets: conform_targets(capture_rate, listed_fps),
            current: None,
        }
    }

    /// Cycles off → first target → … → off.
    pub fn next(&mut self) {
        self.current = match self.current {
            None => self.targets.first().copied(),
            Some(current) => self
                .targets
                .iter()
                .position(|t| (t - current).abs() < 1e-9)
                .and_then(|at| self.targets.get(at + 1))
                .copied(),
        };
    }

    /// Picks a target directly (the web's chip row); `None` or an unlisted rate is off.
    pub fn set(&mut self, target: Option<f64>) {
        self.current =
            target.filter(|wanted| self.targets.iter().any(|t| (t - wanted).abs() < 1e-9));
    }

    /// The clock's rate: 1 without a conform.
    pub fn speed(&self) -> f64 {
        self.current
            .map_or(1.0, |target| conform_speed(self.capture_rate, target))
    }

    /// "120 → 24 fps · 20%", or "Conform" when off.
    pub fn label(&self) -> String {
        match self.current {
            Some(target) => conform_label(self.capture_rate, target),
            None => "Conform".to_string(),
        }
    }
}

/// The conform targets for a clip, from the core. None without the core linked.
#[cfg(opc_core_linked)]
pub fn conform_targets(capture_rate: f64, listed_fps: f64) -> Vec<f64> {
    let mut out = [0.0_f64; 8];
    // Safety: `out` has the capacity handed over.
    let count = unsafe {
        opc_core_sys::opc_conform_targets(capture_rate, listed_fps, out.as_mut_ptr(), out.len())
    };
    let count = usize::try_from(count).unwrap_or(0).min(out.len());
    out[..count].to_vec()
}

#[cfg(not(opc_core_linked))]
pub fn conform_targets(_capture_rate: f64, _listed_fps: f64) -> Vec<f64> {
    Vec::new()
}

#[cfg(opc_core_linked)]
pub fn conform_speed(capture_rate: f64, target: f64) -> f64 {
    // Safety: plain values in.
    unsafe { opc_core_sys::opc_conform_speed(capture_rate, target) }
}

#[cfg(not(opc_core_linked))]
pub fn conform_speed(capture_rate: f64, target: f64) -> f64 {
    if capture_rate > 0.0 && target > 0.0 {
        target / capture_rate
    } else {
        1.0
    }
}

#[cfg(opc_core_linked)]
pub fn conform_label(capture_rate: f64, target: f64) -> String {
    // Safety: probing with a null destination only reports the size needed.
    let needed =
        unsafe { opc_core_sys::opc_conform_label(capture_rate, target, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return String::new();
    }
    let mut bytes = vec![0u8; needed as usize];
    // Safety: `bytes` has exactly the capacity the core asked for.
    let written = unsafe {
        opc_core_sys::opc_conform_label(capture_rate, target, bytes.as_mut_ptr(), bytes.len())
    };
    if written != needed {
        return String::new();
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

#[cfg(not(opc_core_linked))]
pub fn conform_label(capture_rate: f64, target: f64) -> String {
    let percent = if capture_rate > 0.0 {
        (target / capture_rate * 100.0).round()
    } else {
        100.0
    };
    format!("{capture_rate:.0} → {target:.0} fps · {percent:.0}%")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(n: u32, video: bool) -> MediaFile {
        MediaFile {
            path: format!(
                "DCIM/DJI_001/DJI_202608141252{n:02}_00{n:02}_D.{}",
                if video { "MP4" } else { "JPG" }
            ),
            handle: 0x4010_4400 + n,
            duration_seconds: if video { 10 + i64::from(n) } else { 0 },
            resolution: Some("3840x2160".to_string()),
            fps: Some(30),
            ..MediaFile::default()
        }
    }

    #[test]
    fn a_record_reads_as_the_phones_media_item() {
        let library = Library {
            files: vec![clip(1, true), clip(2, false)],
            ..Library::default()
        };
        let items = library.items();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].kind, "photo", "newest first");
        let video = &items[1];
        assert_eq!(video.id, "DCIM/DJI_001/DJI_20260814125201_0001_D.MP4");
        assert_eq!(video.file_name, "DJI_20260814125201_0001_D.MP4");
        assert_eq!(video.duration_sec, Some(11));
        assert_eq!((video.width, video.height), (Some(3840), Some(2160)));
        // 2026-08-14 12:52:01 UTC.
        assert_eq!(video.created_at, 1_786_711_921_000);
        assert!(video.deletable);
        assert_eq!(items[0].duration_sec, None, "a still has no length");
        let json = serde_json::to_value(video).unwrap();
        assert_eq!(json["fileName"], "DJI_20260814125201_0001_D.MP4");
        assert_eq!(json["sizeBytes"], 0);
        assert!(json.get("groupId").is_none());
    }

    #[test]
    fn a_page_replaces_known_records_and_adds_new_ones() {
        let mut library = Library {
            files: vec![clip(1, true)],
            ..Library::default()
        };
        library.listed(vec![
            MediaFile {
                handle: 0x4010_9999,
                ..clip(1, true)
            },
            clip(2, true),
        ]);
        assert_eq!(library.files.len(), 2);
        assert_eq!(
            library.files[0].handle, 0x4010_9999,
            "the fresh handle wins"
        );
        library.listed(Vec::new());
        assert_eq!(library.files.len(), 2, "a short listing drops nothing");
    }

    #[test]
    fn only_a_vouched_handle_is_ever_deleted() {
        let mut library = Library {
            files: vec![
                clip(1, true),
                clip(2, false),
                MediaFile {
                    handle_shared: true,
                    ..clip(3, true)
                },
                MediaFile {
                    handle: 0,
                    ..clip(4, true)
                },
            ],
            ..Library::default()
        };
        let paths: Vec<String> = library.files.iter().map(|f| f.path.clone()).collect();
        let mut asked = paths.clone();
        asked.push("DCIM/nowhere.MP4".to_string());
        let deleted = library.delete(&asked);
        let handles: Vec<u32> = deleted
            .commands
            .iter()
            .map(|command| match command {
                Command::MediaDelete { handle, .. } => *handle,
                _ => 0,
            })
            .collect();
        assert_eq!(handles, [0x4010_4401, 0x4010_4402]);
        let counters: HashSet<u32> = deleted
            .commands
            .iter()
            .map(|command| match command {
                Command::MediaDelete { counter, .. } => *counter,
                _ => 0,
            })
            .collect();
        assert_eq!(counters.len(), 2, "each delete has its own counter");
        assert_eq!(deleted.deleted, paths[..2]);
        assert_eq!(
            deleted.refused.len(),
            3,
            "shared, unvouched and unknown stay"
        );
        assert_eq!(library.files.len(), 2);
    }

    #[test]
    fn a_star_flips_locally_and_tells_the_camera() {
        let mut library = Library {
            files: vec![clip(1, true)],
            ..Library::default()
        };
        let path = clip(1, true).path;
        assert!(matches!(
            library.set_favorite(&path, true),
            Some(Command::MediaFavorite {
                handle: 0x4010_4401,
                on: true,
                ..
            })
        ));
        assert!(library.items()[0].favorite);
        assert!(matches!(
            library.set_favorite(&path, false),
            Some(Command::MediaFavorite { on: false, .. })
        ));
        assert!(!library.items()[0].favorite);

        // No handle: the star stays local.
        let mut bare = Library {
            files: vec![MediaFile {
                handle: 0,
                cmd_handle: 0,
                ..clip(2, true)
            }],
            ..Library::default()
        };
        let bare_path = bare.files[0].path.clone();
        assert_eq!(bare.set_favorite(&bare_path, true), None);
        assert!(bare.favorites.contains(&bare_path));
    }

    #[test]
    fn local_shows_only_what_is_on_this_machine() {
        let mut library = Library {
            files: vec![clip(1, true), clip(2, true)],
            ..Library::default()
        };
        assert!(library
            .visible_files(LibraryTab::All, true, LibrarySort::Newest)
            .is_empty());
        library.proxies.insert(clip(2, true).path);
        assert_eq!(
            library
                .visible_files(LibraryTab::All, true, LibrarySort::Newest)
                .len(),
            1
        );
        assert!(library.items()[0].proxy_cached);
    }

    #[test]
    fn a_burst_member_carries_its_group() {
        let library = Library {
            files: vec![MediaFile {
                path: "DCIM/DJI_001/DJI_20260814125205_0005_D_003.JPG".to_string(),
                ..MediaFile::default()
            }],
            ..Library::default()
        };
        assert_eq!(
            library.items()[0].group_id.as_deref(),
            Some("DJI_20260814125205_0005_D")
        );
    }

    #[test]
    fn the_counter_wraps_past_zero() {
        let mut library = Library {
            counter: u32::MAX,
            ..Library::default()
        };
        assert_eq!(library.next_counter(), 1);
    }

    #[test]
    fn stamps_and_sizes_parse() {
        assert_eq!(created_at_ms("19700101000000"), Some(0));
        assert_eq!(created_at_ms("2026081412"), None);
        assert_eq!(created_at_ms("20261399000000"), None);
        assert_eq!(dimensions("1920×1080"), Some((1920, 1080)));
        assert_eq!(dimensions("4K"), None);
    }

    #[test]
    fn the_conform_chip_cycles_the_targets_and_sets_the_speed() {
        let mut conform = Conform {
            capture_rate: 120.0,
            targets: vec![24.0, 60.0],
            current: None,
        };
        assert_eq!(conform.label(), "Conform");
        assert_eq!(conform.speed(), 1.0);
        conform.next();
        assert_eq!(conform.current, Some(24.0));
        assert!((conform.speed() - 0.2).abs() < 1e-9);
        conform.next();
        assert_eq!(conform.current, Some(60.0));
        assert!((conform.speed() - 0.5).abs() < 1e-9);
        conform.next();
        assert_eq!(
            conform.current, None,
            "past the last target it is off again"
        );
        conform.set(Some(60.0));
        assert_eq!(conform.current, Some(60.0));
        conform.set(Some(25.0));
        assert_eq!(conform.current, None, "an unlisted rate is off");

        let mut bare = Conform::default();
        bare.next();
        assert_eq!(bare.current, None);
    }
}
