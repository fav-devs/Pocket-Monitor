//! Mirrors the `opc_core_linked` flag from `opc-core-sys`.
//!
//! The window, the camera link and the colour cube all reach the Swift core, so they
//! compile only when there is a core to link against. Without one the binary still
//! builds and says what is missing — which is what lets `cargo test --workspace` run on
//! a machine with no Swift toolchain, since cargo links every binary in the workspace
//! before it runs a single integration test.

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
    // Prefer explicit override.
    if let Ok(dir) = std::env::var("OPC_CORE_LIB_DIR") {
        if has_library(Path::new(&dir)) {
            return Some(PathBuf::from(dir));
        }
    }
    // Fall back to Swift's default output directories relative to the repo root.
    // crates/opc-monitor -> crates -> Apps/Desktop -> Apps -> repo root
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let root = Path::new(&manifest)
            .ancestors()
            .nth(4)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        for candidate in [
            root.join(".build/x86_64-unknown-windows-msvc/debug"),
            root.join(".build/x86_64-unknown-windows-msvc/release"),
            root.join(".build/release"),
            root.join(".build/debug"),
        ] {
            if has_library(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn main() {
    println!("cargo::rustc-check-cfg=cfg(opc_core_linked)");
    println!("cargo:rerun-if-env-changed=OPC_CORE_LIB_DIR");
    println!("cargo:rerun-if-env-changed=DEP_OPENPOCKETCINEDESKTOP_LIB_DIR");
    // DEP_OPENPOCKETCINEDESKTOP_LIB_DIR reaches us only when opc-core-sys is a direct
    // dependency. Check the library path directly so the flag works transitively too.
    if let Some(dir) = find_core() {
        // `opc-core-sys` publishes this native dependency, but Cargo may omit a
        // transitive native link flag from a final Windows binary. The viewfinder
        // is the executable boundary, so make its Swift facade dependency explicit
        // for both debug and release builds.
        println!("cargo:rustc-link-search=native={}", dir.display());
        println!("cargo:rustc-link-lib=dylib={LIB_NAME}");
        println!("cargo:rustc-cfg=opc_core_linked");
    } else if std::env::var("DEP_OPENPOCKETCINEDESKTOP_LIB_DIR").is_ok() {
        println!("cargo:rustc-cfg=opc_core_linked");
    }
}
