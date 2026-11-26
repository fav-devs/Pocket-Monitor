//! The LUT menu: the built-in looks the core ships, and the operator's own `.cube`
//! files in a folder. The rules are `CustomLUTIndex` from the core: `.cube` only,
//! case-insensitive order, and no name that could leave the folder.

use std::path::{Path, PathBuf};

/// What the operator picked.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum LutChoice {
    #[default]
    Off,
    /// One of the core's official Rec.709 cubes, by name.
    BuiltIn(String),
    /// A `.cube` in the custom folder, by file name.
    File(String),
}

/// The names the LUT row offers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LutMenu {
    pub builtin: Vec<String>,
    pub custom: Vec<String>,
    /// Where the custom cubes are read from, for the operator to drop files into.
    pub folder: String,
}

/// `<cache>/OpenPocketCine/luts`, beside the media cache.
pub fn custom_folder() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("XDG_CACHE_HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf))
        })
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("OpenPocketCine").join("luts")
}

/// Keeps only `.cube` entries with safe names, sorted case-insensitively.
pub fn stored(names: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut cubes: Vec<String> = names
        .into_iter()
        .filter(|name| name.to_lowercase().ends_with(".cube") && is_safe_file_name(name))
        .collect();
    cubes.sort_by_key(|name| name.to_lowercase());
    cubes
}

/// The file names in the custom folder, by the rules above. A missing folder is empty.
pub fn list_custom(folder: &Path) -> Vec<String> {
    let names = std::fs::read_dir(folder)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_file())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    stored(names)
}

/// The name without a trailing `.cube`, any case.
pub fn display_name(file_name: &str) -> &str {
    if file_name.to_lowercase().ends_with(".cube") {
        &file_name[..file_name.len() - 5]
    } else {
        file_name
    }
}

/// Rejects path components so a hostile name cannot escape the folder.
pub fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
        && name != "."
        && name != ".."
}

/// A file name for an imported cube: the operator's name made safe, `.cube` kept, and a
/// ` (2)`, ` (3)` … suffix rather than overwriting a cube already in the folder.
pub fn import_name(name: &str, taken: impl Fn(&str) -> bool) -> String {
    let base = display_name(name.rsplit(['/', '\\']).next().unwrap_or(name));
    let cleaned: String = base
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .filter(|c| !c.is_control())
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    let stem = if cleaned.is_empty() {
        "Imported"
    } else {
        cleaned
    };
    let stem: String = stem.chars().take(80).collect();
    let mut candidate = format!("{stem}.cube");
    let mut n = 2;
    while taken(&candidate) {
        candidate = format!("{stem} ({n}).cube");
        n += 1;
    }
    candidate
}

/// `desktop-lut-v1.txt` beside the LUT folder: the desktop's remembered LUT pick.
pub fn selection_file() -> PathBuf {
    let folder = custom_folder();
    folder
        .parent()
        .map_or_else(|| folder.clone(), Path::to_path_buf)
        .join("desktop-lut-v1.txt")
}

/// `selected=<id>`; an empty or missing line is no pick.
pub fn parse_selection(text: &str) -> Option<String> {
    text.lines()
        .find_map(|line| line.strip_prefix("selected="))
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

pub fn format_selection(id: Option<&str>) -> String {
    format!("selected={}\n", id.unwrap_or("").replace(['\r', '\n'], ""))
}

/// The shot colour an original take carries in its `moov` tail, read by the core.
/// `None` for a proxy, a take without the Keys atom, or without the core linked.
#[cfg(opc_core_linked)]
pub fn clip_color_mode(tail: &[u8]) -> Option<u8> {
    // Safety: the slice outlives the call.
    let mode = unsafe { opc_core_sys::opc_clip_color_mode(tail.as_ptr(), tail.len()) };
    u8::try_from(mode).ok()
}

#[cfg(not(opc_core_linked))]
pub fn clip_color_mode(_tail: &[u8]) -> Option<u8> {
    None
}

/// The official DJI cube's file name for a colour and body, from the core. The desktop
/// does not ship the cubes; the operator drops them in the LUT folder.
#[cfg(opc_core_linked)]
pub fn auto_lut_file(color_mode: u8, model_id: i32) -> Option<String> {
    // Safety: probing with a null destination only reports the size needed.
    let needed = unsafe {
        opc_core_sys::opc_lut_auto_file(i32::from(color_mode), model_id, std::ptr::null_mut(), 0)
    };
    if needed <= 0 {
        return None;
    }
    let mut bytes = vec![0u8; needed as usize];
    // Safety: `bytes` has exactly the capacity the core asked for.
    let written = unsafe {
        opc_core_sys::opc_lut_auto_file(
            i32::from(color_mode),
            model_id,
            bytes.as_mut_ptr(),
            bytes.len(),
        )
    };
    (written == needed).then(|| String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(not(opc_core_linked))]
pub fn auto_lut_file(_color_mode: u8, _model_id: i32) -> Option<String> {
    None
}

/// The last 2 MiB of a file, where a Pocket take keeps its `moov`.
pub fn read_tail(path: &Path) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL: u64 = 2 * 1024 * 1024;
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let start = size.saturating_sub(TAIL);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity((size - start) as usize);
    file.read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_safe_cubes_are_listed_in_case_insensitive_order() {
        let names = [
            "Zebra.CUBE",
            "alpha.cube",
            "notes.txt",
            "../escape.cube",
            "sub/dir.cube",
            "Beta.cube",
        ]
        .map(String::from);
        assert_eq!(stored(names), ["alpha.cube", "Beta.cube", "Zebra.CUBE"]);
        assert_eq!(display_name("Beta.cube"), "Beta");
        assert_eq!(display_name("Zebra.CUBE"), "Zebra");
        assert_eq!(display_name("plain"), "plain");
        assert!(!is_safe_file_name("C:evil.cube"));
    }

    #[test]
    fn imports_get_a_safe_unique_name() {
        let taken = |name: &str| name == "Kodak.cube" || name == "Kodak (2).cube";
        assert_eq!(import_name("Kodak.cube", taken), "Kodak (3).cube");
        assert_eq!(import_name("C:\\luts\\Fuji.CUBE", |_| false), "Fuji.cube");
        assert_eq!(import_name("../../evil.cube", |_| false), "evil.cube");
        assert_eq!(import_name("a:b*c?.cube", |_| false), "abc.cube");
        assert_eq!(import_name("...", |_| false), "Imported.cube");
        assert!(is_safe_file_name(&import_name("x/y\\z:.cube", |_| false)));
    }

    #[test]
    fn the_selection_round_trips() {
        assert_eq!(
            parse_selection(&format_selection(Some("look:Warm"))).as_deref(),
            Some("look:Warm")
        );
        assert_eq!(parse_selection(&format_selection(None)), None);
        assert_eq!(parse_selection("selected=a\nb\n").as_deref(), Some("a"));
        assert_eq!(format_selection(Some("x\ny")), "selected=xy\n");
    }

    #[test]
    fn a_missing_folder_lists_nothing() {
        assert!(list_custom(Path::new("/nowhere/opc-luts")).is_empty());
    }
}
