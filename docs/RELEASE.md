# Windows releases

Pocket Monitor uses one SemVer version from `Apps/Desktop/Cargo.toml`. Product releases are
annotated `v*` tags on `main` and GitHub Releases containing an installer, a portable ZIP, and
checksums. Tags and publishing are human gates: prepare and verify on a branch, merge through a
PR, then tag the resulting `main` commit deliberately.

## Prepare the train

1. Update the workspace version in `Apps/Desktop/Cargo.toml` and `Apps/Desktop/Cargo.lock`.
2. Move the release notes from the `Unreleased` section of `CHANGELOG.md` into the new version.
3. Update `docs/releases/vX.Y.Z.md` with operator-facing notes and known limitations.
4. Use an x64 shared LGPL FFmpeg build made without `--enable-gpl` or `--enable-nonfree`.
5. Run the repository gates and the Windows release build on the physical release machine.

```powershell
$env:FFMPEG_DIR = 'C:\path\to\ffmpeg-win64-lgpl-shared'
swift test
just desktop-check
.\Apps\Desktop\build-release-assets.ps1 -StopRunning
```

The packaging command writes these ignored artifacts under `Apps/Desktop/dist/`:

- `OpenPocketCine-Setup-X.Y.Z.exe` — installer; registers the optional virtual camera.
- `OpenPocketCine-X.Y.Z-windows-x64.zip` — portable application and runtime DLLs.
- `SHA256SUMS.txt` — SHA-256 for every published binary asset.

The build is currently unsigned. Release notes and the README must say so until Authenticode
signing is added. Smoke-test both the staged executable and a clean installer on Windows 11. A
successful compile is not physical-camera proof; keep the validation language in the release
notes accurate.

## FFmpeg release compliance

The build script rejects FFmpeg configurations containing `--enable-gpl` or
`--enable-nonfree`, stages `FFmpeg-LICENSE.txt`, and removes stale DLLs from previous FFmpeg
majors. Attach the exact corresponding FFmpeg source archive and build provenance to the same
GitHub Release as the Windows binaries. Follow the upstream
[FFmpeg license checklist](https://ffmpeg.org/legal.html) before publishing.

## Tag and publish

After the preparation PR is green and merged, confirm `main` is at the intended commit. Then a
human creates and pushes the annotated tag:

```powershell
git switch main
git pull --ff-only origin main
git tag -a vX.Y.Z -m "OpenPocketCine X.Y.Z"
git push origin vX.Y.Z
```

Create the GitHub Release from that tag, paste `docs/releases/vX.Y.Z.md`, and upload the
installer, portable ZIP, checksum file, and FFmpeg source/provenance assets. Mark early hardware
validation trains as pre-releases. Download the published assets once, verify the hashes, and
launch the downloaded build before announcing it.
