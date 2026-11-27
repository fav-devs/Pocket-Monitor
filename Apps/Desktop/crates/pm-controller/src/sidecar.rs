//! Clip metadata sidecars and marker exports on disk (`docs/clip-metadata.md`).
//!
//! The web keeps a clip's markers, tags and notes and builds the sidecar's JSON
//! (`Apps/Mobile/src/core/markers/sidecar.ts`); the desktop only puts the file in the
//! right place: `<clip basename>.pocketmeta.json` beside the clip, written whole (to a
//! temporary file, then renamed) so an editor watching the folder never reads half of
//! one. Marker exports (FCPXML, EDL, CSV) go to `Videos/Pocket Monitor/Markers`. Nothing
//! here logs what a sidecar says.

use std::path::{Path, PathBuf};

/// The sidecar's `format`.
pub const FORMAT: &str = "pocket-monitor.clip-metadata";
/// The sidecar file's suffix after the clip's base name.
pub const SUFFIX: &str = ".pocketmeta.json";
/// Larger than any real sidecar or export.
pub const MAX_BYTES: usize = 2_000_000;

/// `…/DJI_0001.MP4` → `…/DJI_0001.pocketmeta.json`.
pub fn sidecar_path(clip: &Path) -> PathBuf {
    let stem = clip
        .file_stem()
        .map_or_else(|| "clip".into(), |s| s.to_string_lossy().into_owned());
    clip.with_file_name(format!("{stem}{SUFFIX}"))
}

/// What the web sent is a v1-or-later sidecar for a clip: an object with this format, a
/// version, and a clip with a file name. The content is otherwise the web's.
pub fn validate(json: &str) -> Result<(), String> {
    if json.len() > MAX_BYTES {
        return Err("too large for a sidecar".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| "not JSON".to_string())?;
    if value.get("format").and_then(|f| f.as_str()) != Some(FORMAT) {
        return Err("not a Pocket Monitor sidecar".into());
    }
    if value.get("version").and_then(|v| v.as_u64()).unwrap_or(0) < 1 {
        return Err("unknown sidecar version".into());
    }
    let named = value
        .get("clip")
        .and_then(|c| c.get("fileName"))
        .and_then(|n| n.as_str())
        .is_some_and(|n| !n.is_empty());
    if !named {
        return Err("the sidecar names no clip".into());
    }
    Ok(())
}

/// A file name the web asked for, made safe for any file system: no folders, no
/// reserved characters, not empty, at most 120 characters.
pub fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let mut out: String = trimmed.chars().take(120).collect();
    if out.is_empty() {
        out = "markers.txt".into();
    }
    out
}

/// `Videos/Pocket Monitor/Markers` under `home`.
pub fn markers_folder(home: &Path) -> PathBuf {
    home.join("Videos").join("Pocket Monitor").join("Markers")
}

/// `name` in `folder`, or `name (2)`, `name (3)`, … when taken.
pub fn unique_path(folder: &Path, name: &str) -> PathBuf {
    let first = folder.join(name);
    if !first.exists() {
        return first;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map_or_else(String::new, |s| s.to_string_lossy().into_owned());
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (2..)
        .map(|n| folder.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// Writes `bytes` to `path` whole: a temporary file beside it, then a rename.
pub fn write_whole(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".part");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Validates the web's sidecar and writes it beside `clip`. Returns where it went.
pub fn write_beside(clip: &Path, json: &str) -> Result<PathBuf, String> {
    validate(json)?;
    let path = sidecar_path(clip);
    write_whole(&path, json.as_bytes()).map_err(|e| format!("could not write the sidecar: {e}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pm-sidecar-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const GOOD: &str = r#"{"format":"pocket-monitor.clip-metadata","version":1,"clip":{"fileName":"DJI_0001.MP4"},"markers":[],"future":{"kept":true}}"#;

    #[test]
    fn the_sidecar_sits_beside_the_clip_under_its_base_name() {
        assert_eq!(
            sidecar_path(Path::new("/cache/files/DJI_20260814125250_0034_D.MP4")),
            PathBuf::from("/cache/files/DJI_20260814125250_0034_D.pocketmeta.json")
        );
        assert_eq!(
            sidecar_path(Path::new("clip")),
            PathBuf::from("clip.pocketmeta.json")
        );
    }

    #[test]
    fn only_a_sidecar_naming_a_clip_is_written() {
        assert!(validate(GOOD).is_ok());
        assert!(validate("{").is_err());
        assert!(validate(r#"{"format":"other","version":1,"clip":{"fileName":"a"}}"#).is_err());
        assert!(validate(
            r#"{"format":"pocket-monitor.clip-metadata","version":0,"clip":{"fileName":"a"}}"#
        )
        .is_err());
        assert!(
            validate(r#"{"format":"pocket-monitor.clip-metadata","version":1,"clip":{}}"#).is_err()
        );
        // A newer version is the web's business: written as it is.
        assert!(validate(
            r#"{"format":"pocket-monitor.clip-metadata","version":2,"clip":{"fileName":"a"}}"#
        )
        .is_ok());
        assert!(validate(&" ".repeat(MAX_BYTES + 1)).is_err());
    }

    #[test]
    fn writing_replaces_the_old_sidecar_whole_and_keeps_every_byte() {
        let dir = scratch("write");
        let clip = dir.join("DJI_0001.MP4");
        std::fs::write(&clip, b"video").unwrap();
        let path = write_beside(&clip, GOOD).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), GOOD);
        let newer = GOOD.replace("[]", r#"[{"id":"m1","time":1.5}]"#);
        write_beside(&clip, &newer).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), newer);
        assert!(!dir.join("DJI_0001.pocketmeta.json.part").exists());
        assert!(write_beside(&clip, "not json").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), newer);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_names_are_safe_and_never_overwrite() {
        assert_eq!(safe_file_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_file_name("a:b*c?.csv"), "a_b_c_.csv");
        assert_eq!(safe_file_name("   "), "markers.txt");
        assert_eq!(safe_file_name(&"x".repeat(300)).len(), 120);
        let dir = scratch("unique");
        assert_eq!(unique_path(&dir, "m.csv"), dir.join("m.csv"));
        std::fs::write(dir.join("m.csv"), b"1").unwrap();
        assert_eq!(unique_path(&dir, "m.csv"), dir.join("m (2).csv"));
        assert_eq!(
            markers_folder(Path::new("/home/u")),
            PathBuf::from("/home/u/Videos/Pocket Monitor/Markers")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
