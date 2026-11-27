#!/usr/bin/env python3
"""Bundle the native macOS release binary; run from Apps/Desktop (or use build-macos.sh)."""
import argparse
import pathlib
import plistlib
import shutil
import subprocess


def run(*args):
    return subprocess.check_output([str(arg) for arg in args], text=True).strip()


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--core', required=True, type=pathlib.Path)
parser.add_argument('--dmg', action='store_true')
args = parser.parse_args()
desktop = pathlib.Path(__file__).resolve().parents[1]
app = desktop / 'dist/Pocket Monitor.app'
if app.exists():
    shutil.rmtree(app)
macos = app / 'Contents/MacOS'
frameworks = app / 'Contents/Frameworks'
resources = app / 'Contents/Resources'
for folder in (macos, frameworks, resources):
    folder.mkdir(parents=True)
exe = macos / 'opc-monitor'
shutil.copy2(desktop / 'target/release/opc-monitor', exe)
info = {
    'CFBundleName': 'Pocket Monitor',
    'CFBundleDisplayName': 'Pocket Monitor',
    'CFBundleIdentifier': 'com.opencapture.pocket-monitor',
    'CFBundleExecutable': 'opc-monitor',
    'CFBundlePackageType': 'APPL',
    'CFBundleShortVersionString': '0.1.0',
    'CFBundleVersion': '1',
    'LSMinimumSystemVersion': '14.0',
    'NSHighResolutionCapable': True,
    'NSBluetoothAlwaysUsageDescription': 'Pair with your DJI Osmo camera over Bluetooth.',
    'NSBluetoothPeripheralUsageDescription': 'Pair with your DJI Osmo camera over Bluetooth.',
    'NSCameraUsageDescription': 'Use a webcam for hand gesture controls.',
    'NSMicrophoneUsageDescription': 'Monitor audio from your selected input.',
    'NSLocalNetworkUsageDescription': 'Find and connect to cameras and shared phone feeds on your network.',
    'NSBonjourServices': ['_opc-mon._tcp'],
    'NSLocationUsageDescription': 'Fill in the name of your Wi-Fi network when adding the camera to it.',
    'NSLocationWhenInUseUsageDescription': 'Fill in the name of your Wi-Fi network when adding the camera to it.',
}
with (app / 'Contents/Info.plist').open('wb') as file:
    plistlib.dump(info, file)

# Follow every non-system dylib, including FFmpeg's Homebrew dependencies. Rewrite
# both absolute paths and @rpath references so the app survives leaving this machine.
queue = []
copied = {}


def stage(source):
    source = source.resolve(strict=True)
    destination = frameworks / source.name
    if destination.name in copied:
        if copied[destination.name] != source:
            raise RuntimeError(f'dylib name collision: {source}')
        return destination
    copied[destination.name] = source
    shutil.copy2(source, destination)
    destination.chmod(0o755)
    run('install_name_tool', '-id', f'@rpath/{destination.name}', destination)
    queue.append((source, destination))
    return destination


core = stage(args.core)
molten_prefix = pathlib.Path(run('brew', '--prefix', 'molten-vk'))
stage(molten_prefix / 'lib/libMoltenVK.dylib')
queue.append((desktop / 'target/release/opc-monitor', exe))
while queue:
    source, destination = queue.pop()
    lines = run('otool', '-L', source).splitlines()[1:]
    for line in lines:
        dependency = line.strip().split(' (', 1)[0]
        if dependency.startswith(('/usr/lib/', '/System/Library/')):
            continue
        if dependency == f'@rpath/{core.name}':
            library = core
        else:
            candidate = pathlib.Path(dependency)
            if dependency.startswith('@loader_path/'):
                candidate = source.parent / dependency.removeprefix('@loader_path/')
            elif dependency.startswith('@rpath/'):
                # ONNX Runtime's static distribution and Swift may reference dylibs
                # beside the linked source library. Fail rather than ship a broken app.
                candidate = source.parent / dependency.removeprefix('@rpath/')
            if candidate.resolve() == source.resolve():
                continue  # A dylib's own install name.
            if not candidate.is_file():
                raise RuntimeError(f'cannot resolve {dependency} required by {source}')
            library = stage(candidate)
        run('install_name_tool', '-change', dependency, f'@rpath/{library.name}', destination)

# Remove build-machine rpaths, then add only locations inside this app.
for binary in [*frameworks.iterdir(), exe]:
    lines = run('otool', '-l', binary).splitlines()
    for index, line in enumerate(lines):
        if line.strip() == 'cmd LC_RPATH':
            old = lines[index + 2].strip().split('path ', 1)[1].rsplit(' (offset', 1)[0]
            run('install_name_tool', '-delete_rpath', old, binary)
    rpath = '@executable_path/../Frameworks' if binary == exe else '@loader_path'
    run('install_name_tool', '-add_rpath', rpath, binary)
    run('codesign', '--force', '--sign', '-', binary)

# Keep the local dependency inventory and the installed formula licences with it.
licences = resources / 'Licenses'
licences.mkdir()
shutil.copy2(desktop.parents[1] / 'LICENSE', licences / 'Pocket-Monitor-LICENSE')
for source in copied.values():
    if 'Cellar' in source.parts:
        cellar = source.parts.index('Cellar')
        formula = pathlib.Path(*source.parts[:cellar + 3])
        for pattern in ('LICENSE*', 'COPYING*'):
            for licence in formula.glob(pattern):
                if licence.is_file():
                    shutil.copy2(licence, licences / f'{source.parts[cellar + 1]}-{licence.name}')
(resources / 'native-dependencies.txt').write_text('\n'.join(p.name for p in copied.values()) + '\n')
run('codesign', '--force', '--sign', '-', app)
run('codesign', '--verify', '--deep', '--strict', app)
print(app)
if args.dmg:
    dmg = desktop / 'dist/Pocket Monitor.dmg'
    staging = desktop / 'dist/dmg-staging'
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir()
    shutil.copytree(app, staging / app.name)
    (staging / 'Applications').symlink_to('/Applications')
    run('hdiutil', 'create', '-volname', 'Pocket Monitor', '-srcfolder', staging,
        '-ov', '-format', 'UDZO', dmg)
    shutil.rmtree(staging)
    print(dmg)
