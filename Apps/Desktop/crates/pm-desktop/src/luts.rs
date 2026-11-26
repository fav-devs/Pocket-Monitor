//! Colour cubes on the desktop (§1.P): the core's built-in looks, every `.cube` in the
//! LUT drop folder, and cubes the web registers, parsed off the render thread.
//!
//! - `lut_list`: the built-ins, the drop folder's files (core `CustomLUTIndex` name
//!   rules), the folder's path, and the remembered pick.
//! - `lut_load {name, text, id?}`: with `id: "custom:<key>"`, registers a cube the web
//!   keeps in its own storage (the phones' document picker), the twin of
//!   `PocketVideo.loadLut`. Without an id it is an import: the core validates the text and
//!   the file is written into the drop folder, so it persists natively and shows in
//!   Explorer like a dropped one.
//! - `lut_select {id}`: remembers the pick in `desktop-lut-v1.txt` beside the folder.
//! - `lut_unload {id}`: forgets a registered cube.
//!
//! The render thread never parses: it asks [`LutStore::lattice`] for the cube its
//! `lutId` names, and a miss starts a loader thread that posts the lattice back when it is
//! ready (one frame of the old cube or none, never a stall). The upload is the only GPU
//! work, between frames, as before.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use opc_render::Lut;
use pm_controller::effects::LutSource;
use pm_controller::link::diagnostic;
use pm_controller::luts;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::picture::PictureHub;

/// Built-in looks are built at the lattice the shells use.
const BUILT_IN_SIZE: i32 = 33;
/// Refuse a "cube" bigger than this before handing it to the core (a 65³ cube is ~9 MB).
const MAX_CUBE_BYTES: usize = 16 * 1024 * 1024;

/// A parsed cube, read out of the core: `size³ × 4` floats, red fastest.
#[derive(Debug)]
pub struct Lattice {
    pub size: u32,
    pub rgba: Vec<f32>,
}

/// What [`LutStore::lattice`] has for a source.
#[derive(Debug, Clone)]
pub enum Lookup {
    Ready(Arc<Lattice>),
    /// A loader is on it; the render thread is told when it lands.
    Loading,
    Failed(String),
}

#[derive(Default)]
struct Inner {
    ready: HashMap<LutSource, Arc<Lattice>>,
    failed: HashMap<LutSource, String>,
    loading: HashSet<LutSource>,
}

/// Parsed cubes, shared by the render thread and the commands.
#[derive(Default)]
pub struct LutStore {
    inner: Mutex<Inner>,
}

impl std::fmt::Debug for LutStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LutStore").finish_non_exhaustive()
    }
}

fn lattice_of(lut: &Lut) -> Result<Lattice, String> {
    let size = lut.size();
    let rgba = lut.rgba();
    if size < 2 || rgba.len() != (size * size * size * 4) as usize {
        return Err("That cube has no usable lattice.".to_string());
    }
    Ok(Lattice { size, rgba })
}

/// Parses `.cube` text through the core.
pub fn parse(text: &str) -> Result<Lattice, String> {
    if text.len() > MAX_CUBE_BYTES {
        return Err("That .cube file is larger than 16 MB.".to_string());
    }
    let lut = Lut::parse(text).map_err(|error| error.to_string())?;
    lattice_of(&lut)
}

fn load(source: &LutSource) -> Result<Lattice, String> {
    match source {
        LutSource::Off => Err("No cube.".to_string()),
        LutSource::BuiltIn(name) => Lut::built_in(name, BUILT_IN_SIZE)
            .map_err(|error| error.to_string())
            .and_then(|lut| lattice_of(&lut)),
        LutSource::File(name) => {
            if !luts::is_safe_file_name(name) {
                return Err("That is not a file in the LUT folder.".to_string());
            }
            let path = luts::custom_folder().join(name);
            let text = std::fs::read_to_string(&path)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            parse(&text)
        }
        LutSource::Custom(_) => {
            Err("That imported cube has not been handed to the desktop yet (lut_load).".to_string())
        }
    }
}

impl LutStore {
    /// The lattice for `source`, starting a loader on a miss. `ready` runs on the
    /// loader's thread once the lattice (or its failure) is in the store.
    pub fn lattice(
        self: &Arc<Self>,
        source: &LutSource,
        ready: impl FnOnce() + Send + 'static,
    ) -> Lookup {
        let Ok(mut inner) = self.inner.lock() else {
            return Lookup::Failed("The LUT store is unavailable.".to_string());
        };
        if let Some(lattice) = inner.ready.get(source) {
            return Lookup::Ready(lattice.clone());
        }
        if let Some(error) = inner.failed.get(source) {
            return Lookup::Failed(error.clone());
        }
        if matches!(source, LutSource::Custom(_)) {
            // Registered by the web, never loaded from here: wait for `lut_load`.
            return Lookup::Loading;
        }
        if inner.loading.insert(source.clone()) {
            drop(inner);
            let source = source.clone();
            let store = Arc::clone(self);
            let spawned = std::thread::Builder::new()
                .name("pm-lut".to_string())
                .spawn(move || {
                    let loaded = load(&source);
                    if let Ok(mut inner) = store.inner.lock() {
                        inner.loading.remove(&source);
                        match loaded {
                            Ok(lattice) => {
                                inner.ready.insert(source, Arc::new(lattice));
                            }
                            Err(error) => {
                                inner.failed.insert(source, error);
                            }
                        }
                    }
                    ready();
                });
            if let Err(error) = spawned {
                return Lookup::Failed(error.to_string());
            }
        }
        Lookup::Loading
    }

    /// Puts a parsed lattice in the store (an import or a web registration).
    pub fn insert(&self, source: LutSource, lattice: Lattice) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.failed.remove(&source);
            inner.ready.insert(source, Arc::new(lattice));
        }
    }

    /// Drops a source, so the next use reads it again (a file replaced in the folder, a
    /// registration withdrawn).
    pub fn forget(&self, source: &LutSource) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.ready.remove(source);
            inner.failed.remove(source);
        }
    }

    /// Keeps only the cubes still in use, so a session of imports does not pile up
    /// lattices (a 65³ is 4.4 MB of floats).
    pub fn retain(&self, keep: &[LutSource]) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.ready.retain(|source, _| {
                keep.contains(source) || matches!(source, LutSource::Custom(_))
            });
        }
    }
}

/// One row of the LUT list.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LutEntry {
    /// The `lutId` the web sends in `PictureEffects`.
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LutList {
    pub built_in: Vec<LutEntry>,
    pub files: Vec<LutEntry>,
    /// Where to drop `.cube` files.
    pub folder: String,
    /// The last `lut_select`, if any.
    pub selected: Option<String>,
}

/// The remembered pick.
pub fn read_selected() -> Option<String> {
    std::fs::read_to_string(luts::selection_file())
        .ok()
        .and_then(|text| luts::parse_selection(&text))
}

fn write_selected(id: Option<&str>) -> Result<(), String> {
    let path = luts::selection_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(&path, luts::format_selection(id))
        .map_err(|error| format!("{}: {error}", path.display()))
}

fn ensure_folder() -> PathBuf {
    let folder = luts::custom_folder();
    if let Err(error) = std::fs::create_dir_all(&folder) {
        diagnostic(format_args!(
            "lut: could not create {}: {error}",
            folder.display()
        ));
    }
    folder
}

/// The list the picker shows.
pub fn list() -> LutList {
    let folder = ensure_folder();
    let built_in = opc_render::built_in_names()
        .into_iter()
        .map(|name| LutEntry {
            id: format!("look:{name}"),
            name,
        })
        .collect();
    let files = luts::list_custom(&folder)
        .into_iter()
        .map(|file| LutEntry {
            id: format!("file:{file}"),
            name: luts::display_name(&file).to_string(),
        })
        .collect();
    LutList {
        built_in,
        files,
        folder: folder.display().to_string(),
        selected: read_selected(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub id: String,
    pub name: String,
    pub size: u32,
}

fn load_text(hub: &PictureHub, name: &str, text: &str, id: Option<&str>) -> Result<Loaded, String> {
    let lattice = parse(text)?;
    let size = lattice.size;
    if let Some(key) = id.and_then(|id| id.strip_prefix("custom:")) {
        if key.is_empty() || key.starts_with("file:") {
            return Err("That is not a registrable LUT id.".to_string());
        }
        let source = LutSource::Custom(key.to_string());
        hub.luts.insert(source, lattice);
        hub.lut_ready();
        return Ok(Loaded {
            id: format!("custom:{key}"),
            name: luts::display_name(name).to_string(),
            size,
        });
    }
    let folder = ensure_folder();
    let file = luts::import_name(name, |candidate| folder.join(candidate).exists());
    let path = folder.join(&file);
    std::fs::write(&path, text).map_err(|error| format!("{}: {error}", path.display()))?;
    diagnostic(format_args!("lut: imported {}", path.display()));
    let source = LutSource::File(file.clone());
    hub.luts.insert(source, lattice);
    hub.lut_ready();
    Ok(Loaded {
        id: format!("file:{file}"),
        name: luts::display_name(&file).to_string(),
        size,
    })
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn lut_list() -> Result<LutList, String> {
    blocking(list).await
}

/// Registers (`id: "custom:<key>"`) or imports (no id) a cube. Returns its `lutId`.
#[tauri::command]
pub async fn lut_load(
    app: AppHandle,
    name: String,
    text: String,
    id: Option<String>,
) -> Result<Loaded, String> {
    blocking(move || {
        let hub = app.state::<Arc<PictureHub>>();
        load_text(&hub, &name, &text, id.as_deref())
    })
    .await?
}

/// Remembers the pick (`null` for none). The picture itself follows `PictureEffects`.
#[tauri::command]
pub async fn lut_select(id: Option<String>) -> Result<(), String> {
    blocking(move || {
        if let Some(id) = id.as_deref() {
            let (_, known) = pm_controller::effects::lut_source(Some(id));
            let ours = id == "auto" || id.starts_with("transform:");
            if !known && !ours {
                return Err(format!("{id} is not a LUT id."));
            }
        }
        write_selected(id.as_deref())
    })
    .await?
}

/// Forgets a registered cube, or rereads a folder file next time it is used.
#[tauri::command]
pub fn lut_unload(hub: tauri::State<'_, Arc<PictureHub>>, id: String) {
    let (source, _) = pm_controller::effects::lut_source(Some(&id));
    if source != LutSource::Off {
        hub.luts.forget(&source);
        hub.lut_ready();
    }
}
