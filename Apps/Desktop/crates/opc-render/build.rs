//! Compiles the feed shaders to SPIR-V.
//!
//! The feed, blit and peaking programs came over from the retired Android shell with
//! the desktop-first move and now live beside the desktop-only ones.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Every program, in `shaders/` beside this file. `ycbcr` and `overlay` are desktop-only:
/// software decode hands over planes, not an AHardwareBuffer, and the chrome is
/// composited here.
const LOCAL: [&str; 7] = [
    "fullscreen.vert",
    "feed.frag",
    "blit.frag",
    "peaking_blur.frag",
    "peaking_mask.frag",
    "ycbcr.frag",
    "overlay.frag",
];

fn compiler() -> (&'static str, Vec<String>) {
    if Command::new("glslc").arg("--version").output().is_ok() {
        return ("glslc", vec!["-O".to_string()]);
    }
    ("glslangValidator", vec!["-V".to_string()])
}

fn compile(tool: &str, flags: &[String], source: &Path, output: &Path) {
    let result = Command::new(tool)
        .args(flags)
        .arg(source)
        .arg("-o")
        .arg(output)
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "could not run {tool}: {error}. Install the Vulkan SDK (glslc) or \
                 glslang-tools (glslangValidator)."
            )
        });
    if !result.status.success() {
        panic!(
            "{tool} failed on {}:\n{}\n{}",
            source.display(),
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
}

fn main() {
    println!("cargo::rustc-check-cfg=cfg(opc_core_linked)");
    println!("cargo:rerun-if-env-changed=DEP_OPENPOCKETCINEDESKTOP_LIB_DIR");
    if std::env::var("DEP_OPENPOCKETCINEDESKTOP_LIB_DIR").is_ok() {
        println!("cargo:rustc-cfg=opc_core_linked");
    }

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("a manifest dir"));
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("an output dir"));
    let (tool, flags) = compiler();

    for name in LOCAL {
        let source = manifest.join("shaders").join(name);
        println!("cargo:rerun-if-changed={}", source.display());
        compile(tool, &flags, &source, &out.join(format!("{name}.spv")));
    }
}
