import AVFoundation
import CoreImage
import Foundation
import UIKit

/// Renders an edited clip: AVAssetExportSession with an AVVideoComposition whose Core Image
/// handler runs colour → face → geometry, an audio mix for the volume, and the trim as the time
/// range. HEVC output keeps an HLG/PQ source's HDR (10-bit) when `keepHdr`; otherwise the
/// composition's Rec.709 colour properties tone-map it to SDR.
final class PocketEditExporter: @unchecked Sendable {
  static let shared = PocketEditExporter()

  private let lock = NSLock()
  private var sessions: [String: AVAssetExportSession] = [:]
  private var cancelled: Set<String> = []

  func cancel(_ jobId: String) {
    lock.lock()
    cancelled.insert(jobId)
    let session = sessions[jobId]
    lock.unlock()
    session?.cancelExport()
  }

  private func isCancelled(_ jobId: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled.contains(jobId)
  }

  func run(_ jobId: String, plan: PocketEditExportPlan, progress: @escaping @Sendable (Double) -> Void) async throws -> URL {
    defer {
      lock.lock()
      sessions.removeValue(forKey: jobId)
      cancelled.remove(jobId)
      lock.unlock()
    }
    let url = URL(string: plan.sourceUri).flatMap { $0.scheme == nil ? nil : $0 } ?? URL(fileURLWithPath: plan.sourceUri)
    let asset = AVURLAsset(url: url)
    guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
      throw PocketEditError("This file has no video track.")
    }
    let audioTracks = (try? await asset.loadTracks(withMediaType: .audio)) ?? []
    let source = await PocketEditSourceColor.of(videoTrack)

    let color = PocketEditColorStage(colorSpace: source.lutSpace)
    color.update(lutKey: plan.lutKey, split: nil)
    let face = PocketFaceRetouchStage()
    face.update(plan.face)
    let output = CGSize(width: plan.width, height: plan.height)
    let geometry = PocketEditGeometry(rotation: plan.rotation, crop: plan.crop, flipH: plan.flipH, flipV: plan.flipV, output: output)
    let skipGeometry = plan.geometryIdentity
    let composition = AVMutableVideoComposition(asset: asset) { request in
      let time = request.compositionTime
      var image = request.sourceImage
      // Colour and face on the full source frame (landmarks are in source coordinates).
      image = color.apply(image, at: time)
      if face.isActive { image = face.apply(image, at: time) }
      if !skipGeometry { image = geometry.apply(image) }
      request.finish(with: image, context: nil)
    }
    if !skipGeometry { composition.renderSize = output }
    source.apply(to: composition, keepHdr: plan.keepHdr)

    let presets = AVAssetExportSession.exportPresets(compatibleWith: asset)
    let preset = presets.contains(AVAssetExportPresetHEVCHighestQuality) ? AVAssetExportPresetHEVCHighestQuality : AVAssetExportPresetHighestQuality
    guard let session = AVAssetExportSession(asset: asset, presetName: preset) else {
      throw PocketEditError("This clip cannot be exported on this device.")
    }
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pocket-edits", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let out = dir.appendingPathComponent(plan.outputName)
    try? FileManager.default.removeItem(at: out)
    session.outputURL = out
    session.outputFileType = session.supportedFileTypes.contains(.mp4) ? .mp4 : .mov
    session.videoComposition = composition
    session.shouldOptimizeForNetworkUse = true
    if plan.volume <= 0.001 {
      // Mute: silence every audio track (the track stays so players see a normal file).
      session.audioMix = PocketEditAudio.mix(for: audioTracks, volume: 0)
    } else {
      session.audioMix = PocketEditAudio.mix(for: audioTracks, volume: plan.volume)
    }
    if let trim = plan.trim {
      let start = CMTime(seconds: trim.start, preferredTimescale: 600)
      let end = CMTime(seconds: trim.end, preferredTimescale: 600)
      session.timeRange = CMTimeRange(start: start, end: end)
    }

    lock.lock()
    sessions[jobId] = session
    let alreadyCancelled = cancelled.contains(jobId)
    lock.unlock()
    if alreadyCancelled { throw PocketEditError("Export cancelled") }

    // Progress: poll the session while it runs.
    let poll = Task {
      while !Task.isCancelled {
        progress(Double(session.progress))
        try? await Task.sleep(nanoseconds: 200_000_000)
      }
    }
    defer { poll.cancel() }

    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
      session.exportAsynchronously { done.resume() }
    }
    switch session.status {
    case .completed:
      progress(1)
      return out
    case .cancelled:
      try? FileManager.default.removeItem(at: out)
      throw PocketEditError("Export cancelled")
    default:
      try? FileManager.default.removeItem(at: out)
      if isCancelled(jobId) { throw PocketEditError("Export cancelled") }
      throw PocketEditError(session.error?.localizedDescription ?? "Export failed")
    }
  }
}

/// A small RGBA frame of a clip (look thumbnails).
enum PocketEditFrameGrabber {
  static func grab(uri: String, seconds: Double, maxWidth: Int) async throws -> (width: Int, height: Int, rgba: Data)? {
    let url = URL(string: uri).flatMap { $0.scheme == nil ? nil : $0 } ?? URL(fileURLWithPath: uri)
    let asset = AVURLAsset(url: url)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    let edge = CGFloat(max(16, min(maxWidth, 512)))
    generator.maximumSize = CGSize(width: edge, height: edge)
    let tolerance = CMTime(seconds: 0.5, preferredTimescale: 600)
    generator.requestedTimeToleranceBefore = tolerance
    generator.requestedTimeToleranceAfter = tolerance
    let time = CMTime(seconds: max(0, seconds), preferredTimescale: 600)
    let cg = try await generator.image(at: time).image
    let w = cg.width
    let h = cg.height
    guard w > 0, h > 0 else { return nil }
    var data = Data(count: w * h * 4)
    let drawn: Bool = data.withUnsafeMutableBytes { raw in
      guard let base = raw.baseAddress,
        let ctx = CGContext(
          data: base, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
          space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      // CGContext's origin is bottom-left; drawing the image fills the buffer top-down.
      ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
      return true
    }
    return drawn ? (w, h, data) : nil
  }
}
