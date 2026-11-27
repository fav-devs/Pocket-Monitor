//! Mirrors the `opc_core_linked` flag from `opc-core-sys`, as `opc-monitor` does.
//!
//! The zoom policy, the scopes' level tables, the auto LUT and the gimbal stick curve
//! reach the Swift core when it is there and fall back to stand-ins when it is not, so
//! `cargo test` runs on a machine with no Swift toolchain. This is a library, so it
//! only sets the flag; the executables (`opc-monitor`, `pm-desktop`) emit the link line.

use std::path::{Path, PathBuf};

const LIB_NAME: &str = "OpenPocketCineDesktop";

fn has_library(dir: &Path) -> bool {
    ["dylib", "so", "dll"]
        .iter()
        .any(|ext| dir.join(format!("lib{LIB_NAME}.{ext}")).exists())
        || dir.join(format!("{LIB_NAME}.dll")).exists()
        || dir.join(format!("{LIB_NAME}.lib")).exists()
}

fn find_core() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("OPC_CORE_LIB_DIR") {
        if has_library(Path::new(&dir)) {
            return Some(PathBuf::from(dir));
        }
    }
    // crates/pm-controller -> crates -> Apps/Desktop -> Apps -> repo root
    let manifest = std::env::var("CARGO_MANIFEST_DIR").ok()?;
    let root = Path::new(&manifest).ancestors().nth(4)?.to_path_buf();
    [
        root.join(".build/x86_64-unknown-windows-msvc/debug"),
        root.join(".build/x86_64-unknown-windows-msvc/release"),
        root.join(".build/release"),
        root.join(".build/debug"),
    ]
    .into_iter()
    .find(|candidate| has_library(candidate))
}

fn main() {
    println!("cargo::rustc-check-cfg=cfg(opc_core_linked)");
    println!("cargo:rerun-if-env-changed=OPC_CORE_LIB_DIR");
    println!("cargo:rerun-if-env-changed=DEP_OPENPOCKETCINEDESKTOP_LIB_DIR");
    let core = find_core();
    // The library test harness is an executable too, and a dependency's rustc-link-arg
    // does not reach it: on macOS dyld needs the facade's @rpath from here (as
    // opc-monitor's build script does).
    if let Some(dir) = core.as_ref() {
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dir.display());
        }
    }
    if core.is_some() || std::env::var("DEP_OPENPOCKETCINEDESKTOP_LIB_DIR").is_ok() {
        println!("cargo:rustc-cfg=opc_core_linked");
    }
}
