# Contributing

OpenPocketCine is a desktop application. Install Swift, FFmpeg development libraries,
Vulkan, a GLSL compiler, Rust, and `just`, then run:

```sh
just desktop-check
```

Open a focused pull request into `main` with Conventional Commits. Keep protocol changes
portable in `Sources/OpenPocketViewCore/`; desktop UI, sockets, decoding, and rendering belong
in `Apps/Desktop/`. Never commit camera Wi-Fi passwords, captures, keys, or unofficial LUTs.

Live-camera work requires a physical Windows check. Report bugs with the desktop version,
camera model, and redacted `opc-monitor.log` where relevant.

See [AGENTS.md](AGENTS.md) for the repository workflow and [SECURITY.md](SECURITY.md) for
vulnerability reporting.
