import COpcDesktop
import Foundation
import OpenPocketViewCore

// Capture settings for the desktop shell: shooting modes, video formats, ISO and
// shutter ladders, colour wheels and their labels.
//
// The phones reach these through the same core types. The desktop asks here so a
// Pocket 3 gets its documented fallback tables, a photo SET carries the body's own
// byte and every ladder is the one Mimo offers, without a second copy of the rules.

private func model(_ modelId: Int32) -> CameraModel? {
    modelId < 0 ? nil : CameraModel.resolve(modelId: Int(modelId), name: nil)
}

private func shootingMode(_ raw: Int32) -> ShootingMode? {
    (0...255).contains(raw) ? ShootingMode.fromWire(UInt8(raw)) : nil
}

private func colorMode(_ raw: Int32) -> ColorMode? {
    (0...255).contains(raw) ? ColorMode(rawValue: UInt8(raw)) : nil
}

private func text(_ value: String, _ out: UnsafeMutablePointer<UInt8>?, _ capacity: Int)
    -> Int64
{
    DesktopFacade.emit(Data(value.utf8), into: out, capacity: capacity)
}

/// Writes `values` when they fit and always reports how many there are.
private func ints(_ values: [Int], _ out: UnsafeMutablePointer<Int32>?, _ capacity: Int)
    -> Int32
{
    if let out, capacity >= values.count {
        for (index, value) in values.enumerated() {
            out[index] = Int32(clamping: value)
        }
    }
    return Int32(values.count)
}

/// `[res, fps, res, fps, …]` pairs from the shell.
private func formats(_ pairs: UnsafePointer<Int32>?, _ count: Int) -> [VideoFormat] {
    guard let pairs, count > 0 else { return [] }
    return (0..<count).compactMap { index in
        let resolution = pairs[index * 2]
        let frameRate = pairs[index * 2 + 1]
        guard (0...255).contains(resolution), (0...255).contains(frameRate) else {
            return nil
        }
        return VideoFormat(
            resolution: VideoResolution(rawValue: UInt8(resolution)),
            frameRate: VideoFrameRate(rawValue: UInt8(frameRate)))
    }
}

// MARK: - Shooting modes

/// The `0x02/0xE1` byte for a tabled mode on this body: Photo is `0x05` on a Pocket 3
/// or Nano and `0x17` on a Pocket 4. -1 for a raw value the core does not table.
@_cdecl("opc_shooting_mode_wire_byte")
func opc_shooting_mode_wire_byte(_ raw: Int32, _ modelId: Int32) -> Int32 {
    guard let mode = shootingMode(raw) else { return -1 }
    return Int32(mode.wireByte(for: model(modelId)))
}

/// 1 for a stills mode (Photo, Live Photo), 0 for video, -1 when not tabled.
@_cdecl("opc_shooting_mode_is_photo")
func opc_shooting_mode_is_photo(_ raw: Int32) -> Int32 {
    guard let mode = shootingMode(raw) else { return -1 }
    return mode.isPhoto ? 1 : 0
}

/// 1 when the mode takes a `0x02/0x18` format pair.
@_cdecl("opc_shooting_mode_offers_format")
func opc_shooting_mode_offers_format(_ raw: Int32) -> Int32 {
    guard let mode = shootingMode(raw) else { return -1 }
    return mode.offersVideoFormat ? 1 : 0
}

/// 1 when start/stop in this mode is the Pocket 3 shutter trigger, not record.
@_cdecl("opc_shooting_mode_uses_shutter_trigger")
func opc_shooting_mode_uses_shutter_trigger(_ raw: Int32, _ modelId: Int32) -> Int32 {
    guard let mode = shootingMode(raw) else { return -1 }
    return mode.usesShutterTriggerOnPocket3 && model(modelId)?.isPocket3 == true ? 1 : 0
}

/// The mode's name as the body calls it (`Low-Light` on a Pocket 3, else `SuperNight`).
@_cdecl("opc_shooting_mode_label")
func opc_shooting_mode_label(
    _ raw: Int32, _ modelId: Int32, _ out: UnsafeMutablePointer<UInt8>?, _ capacity: Int
) -> Int64 {
    guard let mode = shootingMode(raw) else { return 0 }
    return text(mode.label(for: model(modelId)), out, capacity)
}

// MARK: - Video formats

/// Frames per second for a `0x02/0x18` rate index, 0 when the table has no entry.
@_cdecl("opc_frame_rate_fps")
func opc_frame_rate_fps(_ index: Int32) -> Int32 {
    guard (0...255).contains(index) else { return 0 }
    return Int32(VideoFrameRate(rawValue: UInt8(index)).fps)
}

/// The resolution's name with its aspect when not 16:9 (`1080p`, `2.7K 4:3`).
@_cdecl("opc_resolution_label")
func opc_resolution_label(
    _ resolution: Int32, _ out: UnsafeMutablePointer<UInt8>?, _ capacity: Int
) -> Int64 {
    guard (0...255).contains(resolution) else { return 0 }
    return text(VideoResolution(rawValue: UInt8(resolution)).label, out, capacity)
}

/// The top-deck chip for a pair (`4K · 25p`).
@_cdecl("opc_format_chip_label")
func opc_format_chip_label(
    _ resolution: Int32, _ frameRate: Int32, _ out: UnsafeMutablePointer<UInt8>?,
    _ capacity: Int
) -> Int64 {
    guard (0...255).contains(resolution), (0...255).contains(frameRate) else { return 0 }
    let format = VideoFormat(
        resolution: VideoResolution(rawValue: UInt8(resolution)),
        frameRate: VideoFrameRate(rawValue: UInt8(frameRate)))
    return text(format.chipLabel, out, capacity)
}

/// The pairs the FORMAT sheet offers: the body's `camcap_video_format` when it sent
/// one, else the documented Pocket 3 table for this shooting mode, else nothing.
/// `available` and `out` are `[res, fps]` pairs; returns the pair count.
@_cdecl("opc_format_picker")
func opc_format_picker(
    _ available: UnsafePointer<Int32>?, _ availableCount: Int, _ modelId: Int32,
    _ shootingMode: Int32, _ out: UnsafeMutablePointer<Int32>?, _ capacity: Int
) -> Int32 {
    let legal = CamCapVideoFormat.pickerFormats(
        available: formats(available, availableCount), model: model(modelId),
        shootingMode: Int(shootingMode))
    let flat = legal.flatMap { [Int($0.resolution.rawValue), Int($0.frameRate.rawValue)] }
    if let out, capacity >= flat.count {
        for (index, value) in flat.enumerated() {
            out[index] = Int32(clamping: value)
        }
    }
    return Int32(legal.count)
}

/// Whether the operator may SET this pair: it has to be in the picker's list.
@_cdecl("opc_format_allows_set")
func opc_format_allows_set(
    _ resolution: Int32, _ frameRate: Int32, _ available: UnsafePointer<Int32>?,
    _ availableCount: Int, _ modelId: Int32, _ shootingMode: Int32
) -> Int32 {
    guard (0...255).contains(resolution), (0...255).contains(frameRate) else { return 0 }
    let format = VideoFormat(
        resolution: VideoResolution(rawValue: UInt8(resolution)),
        frameRate: VideoFrameRate(rawValue: UInt8(frameRate)))
    return CamCapVideoFormat.allowsOperatorSet(
        format, available: formats(available, availableCount), model: model(modelId),
        shootingMode: Int(shootingMode)) ? 1 : 0
}

// MARK: - Exposure ladders

/// The `0x02/0x2A` indices the ISO wheel offers: the body's `camcap_iso` list when it
/// published one, else the ones Mimo offers in this colour, Auto first where it exists.
@_cdecl("opc_iso_indices")
func opc_iso_indices(
    _ colorModeRaw: Int32, _ available: UnsafePointer<Int32>?, _ availableCount: Int,
    _ out: UnsafeMutablePointer<Int32>?, _ capacity: Int
) -> Int32 {
    let mode = colorMode(colorModeRaw) ?? .normal
    let published = (0..<max(0, availableCount)).compactMap { index -> IsoIndex? in
        guard let available, (0...255).contains(available[index]) else { return nil }
        return IsoIndex(rawValue: UInt8(available[index]))
    }
    let wheel = CamCapIso.wheelIndices(available: published, fallback: mode.isoIndices)
    return ints(wheel.map { Int($0.rawValue) }, out, capacity)
}

/// The ISO number for an index, 0 for Auto, -1 when not tabled.
@_cdecl("opc_iso_index_value")
func opc_iso_index_value(_ raw: Int32) -> Int32 {
    guard (0...255).contains(raw), let index = IsoIndex(rawValue: UInt8(raw)) else {
        return -1
    }
    return Int32(index.isoValue ?? 0)
}

/// Auto ISO floor in this colour on this body (50 on a Pocket 3 / Pocket 4 in
/// Rec.709, 400 in D-Log), or -1 when the colour has no Auto ISO.
@_cdecl("opc_iso_auto_base")
func opc_iso_auto_base(_ colorModeRaw: Int32, _ modelId: Int32) -> Int32 {
    let mode = colorMode(colorModeRaw) ?? .normal
    return Int32(mode.isoAutoBase(for: model(modelId)) ?? -1)
}

/// The `0x02/0x8E` pid `0x000F` ceiling codes this colour accepts.
@_cdecl("opc_iso_auto_limits")
func opc_iso_auto_limits(
    _ colorModeRaw: Int32, _ out: UnsafeMutablePointer<Int32>?, _ capacity: Int
) -> Int32 {
    let mode = colorMode(colorModeRaw) ?? .normal
    return ints(mode.isoAutoLimits.map { Int($0.rawValue) }, out, capacity)
}

/// The operator's label for a ceiling code in this colour on this body (`50–1600`).
@_cdecl("opc_iso_auto_limit_label")
func opc_iso_auto_limit_label(
    _ raw: Int32, _ colorModeRaw: Int32, _ modelId: Int32,
    _ out: UnsafeMutablePointer<UInt8>?, _ capacity: Int
) -> Int64 {
    guard (0...255).contains(raw), let limit = IsoLimit(rawValue: UInt8(raw)) else { return 0 }
    let mode = colorMode(colorModeRaw) ?? .normal
    guard let base = mode.isoAutoBase(for: model(modelId)) else { return 0 }
    return text(limit.label(base: base), out, capacity)
}

/// Shutter wheel denominators: the body's `camcap_shutter` list when it published
/// one, else the documented video ladder with the live 1/N merged in.
@_cdecl("opc_shutter_wheel")
func opc_shutter_wheel(
    _ available: UnsafePointer<Int32>?, _ availableCount: Int, _ current: Int32,
    _ out: UnsafeMutablePointer<Int32>?, _ capacity: Int
) -> Int32 {
    let published = (0..<max(0, availableCount)).compactMap { index -> Int? in
        guard let available else { return nil }
        return available[index] > 0 ? Int(available[index]) : nil
    }
    return ints(
        CamCapShutter.wheelDenoms(available: published, current: Int(current)), out, capacity)
}

/// The shutter-angle stops the phones offer, in degrees.
@_cdecl("opc_shutter_angles")
func opc_shutter_angles(_ out: UnsafeMutablePointer<Double>?, _ capacity: Int) -> Int32 {
    let degrees = ShutterAngle.degrees
    if let out, capacity >= degrees.count {
        for (index, value) in degrees.enumerated() {
            out[index] = value
        }
    }
    return Int32(degrees.count)
}

/// The 1/N that gives `degrees` at `fps`, snapped to the body's published list when it
/// sent one. Unknown or out-of-range fps counts as 24, as on the phones.
@_cdecl("opc_shutter_angle_denom")
func opc_shutter_angle_denom(
    _ degrees: Double, _ fps: Int32, _ available: UnsafePointer<Int32>?, _ availableCount: Int
) -> Int32 {
    let published = (0..<max(0, availableCount)).compactMap { index -> Int? in
        guard let available else { return nil }
        return available[index] > 0 ? Int(available[index]) : nil
    }
    return Int32(ShutterAngle.denom(degrees: degrees, fps: Int(fps), available: published))
}

/// The angle a 1/N reads as at `fps`, snapped to the phones' stops (`180°`).
@_cdecl("opc_shutter_angle_label")
func opc_shutter_angle_label(
    _ denom: Int32, _ fps: Int32, _ out: UnsafeMutablePointer<UInt8>?, _ capacity: Int
) -> Int64 {
    text(ShutterAngle.nearestLabel(denom: Int(denom), fps: Int(fps)), out, capacity)
}

/// EV as the operator reads it: `0.0`, `+1.0`, `−1.3`.
@_cdecl("opc_ev_label")
func opc_ev_label(_ thirds: Int32, _ out: UnsafeMutablePointer<UInt8>?, _ capacity: Int)
    -> Int64
{
    text(EvComp(thirds: Int(thirds)).label, out, capacity)
}

// MARK: - Colour

/// The colour wheel for this body, in Mimo's order: the semantic ids the shell keys
/// status and SETs by, not the Pocket 3 / Nano wire bytes.
@_cdecl("opc_color_modes")
func opc_color_modes(
    _ modelId: Int32, _ available: UnsafePointer<Int32>?, _ availableCount: Int,
    _ out: UnsafeMutablePointer<Int32>?, _ capacity: Int
) -> Int32 {
    let published = (0..<max(0, availableCount)).compactMap { index -> ColorMode? in
        guard let available else { return nil }
        return colorMode(available[index])
    }
    let wheel: [ColorMode]
    if let model = model(modelId) {
        wheel = CamCapColorMode.wheel(available: published, model: model)
    } else {
        wheel = CamCapColorMode.wheel(available: published, family: .other)
    }
    return ints(wheel.map { Int($0.rawValue) }, out, capacity)
}

/// The colour's name on this body (`Normal 8-bit` on a Nano, `D-Log M` on a Pocket 3).
@_cdecl("opc_color_mode_label")
func opc_color_mode_label(
    _ raw: Int32, _ modelId: Int32, _ out: UnsafeMutablePointer<UInt8>?, _ capacity: Int
) -> Int64 {
    guard let mode = colorMode(raw) else { return 0 }
    let family = model(modelId)?.family ?? .other
    return text(mode.label(for: family), out, capacity)
}
