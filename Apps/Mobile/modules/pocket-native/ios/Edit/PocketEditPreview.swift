import AVFoundation
import CoreImage
import Foundation

/// Live preview of the edit's colour and face stages on an expo-video `AVPlayer`: an
/// AVVideoComposition with a Core Image handler on the current item. The handler reads the
/// latest plan on every frame, so strength changes show on the next frame; while paused the
/// current frame is re-rendered with a zero-tolerance seek. Main thread only.
@MainActor
final class PocketEditPreview {
  static let shared = PocketEditPreview()

  private final class Attachment {
    weak var player: AVPlayer?
    weak var item: AVPlayerItem?
    var color: PocketEditColorStage?
    let face = PocketFaceRetouchStage(mode: .preview)
    var composition: AVVideoComposition?
    var plan: PocketEditPreviewPlan?
    var gain: PocketEditGain?
    var gainInstalled = false
    var building = false
    var toneMapSdr = false
  }

  private var attachments: [ObjectIdentifier: Attachment] = [:]

  /// The face stage's count of faces in the frame (sent to JS as `onFaceCount`).
  var onFaceCount: ((Int) -> Void)?

  func attach(_ player: AVPlayer, plan: PocketEditPreviewPlan) {
    attachments = attachments.filter { $0.value.player != nil }
    let key = ObjectIdentifier(player)
    let att = attachments[key] ?? Attachment()
    att.player = player
    attachments[key] = att
    guard let item = player.currentItem else { return }
    let previous = att.plan
    att.plan = plan
    att.face.update(plan.face, probe: plan.faceProbe)
    if att.face.onFaces == nil {
      att.face.onFaces = { [weak self] count in
        DispatchQueue.main.async { MainActor.assumeIsolated { self?.onFaceCount?(count) } }
      }
      // Landmarks for a paused frame arrived after it was drawn: draw it again.
      att.face.onRedraw = { [weak self, weak player] in
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            guard let self, let player, self.attachments[ObjectIdentifier(player)] != nil else { return }
            self.refresh(player)
          }
        }
      }
    }

    let sameItem = att.item === item && att.composition != nil
    if sameItem && att.toneMapSdr == plan.toneMapSdr {
      att.color?.update(lutKey: plan.lutKey, split: plan.split)
      if previous?.lutKey != plan.lutKey || previous?.split != plan.split || previous?.face != plan.face || previous?.faceProbe != plan.faceProbe {
        refresh(player)
      }
    } else if !att.building {
      att.building = true
      att.item = item
      Task { @MainActor in
        await self.build(att, item: item)
        att.building = false
        // A newer plan may have arrived while building.
        if let latest = att.plan {
          att.color?.update(lutKey: latest.lutKey, split: latest.split)
          self.refresh(player)
        }
      }
    }
    applyAudio(att, item: item, volume: plan.volume)
  }

  func detach(_ player: AVPlayer) {
    let key = ObjectIdentifier(player)
    guard let att = attachments.removeValue(forKey: key) else { return }
    if let item = att.item, item === player.currentItem {
      item.videoComposition = nil
      if att.gainInstalled { item.audioMix = nil }
    }
  }

  private func build(_ att: Attachment, item: AVPlayerItem) async {
    let asset = item.asset
    guard let track = try? await asset.loadTracks(withMediaType: .video).first else { return }
    let source = await PocketEditSourceColor.of(track)
    let color = PocketEditColorStage(colorSpace: source.lutSpace)
    let face = att.face
    color.update(lutKey: att.plan?.lutKey, split: att.plan?.split)
    // The handler runs on AVFoundation's render threads; the stages lock their own state.
    let composition = AVMutableVideoComposition(asset: asset) { request in
      let original = request.sourceImage
      let time = request.compositionTime
      var image = color.apply(original, at: time)
      if face.isActive { image = face.apply(image, at: time) }
      request.finish(with: color.composeSplit(original: original, edited: image), context: nil)
    }
    let toneMap = att.plan?.toneMapSdr ?? false
    if source.isHdr { source.apply(to: composition, keepHdr: !toneMap) }
    guard att.item === item else { return }
    att.color = color
    att.toneMapSdr = toneMap
    att.composition = composition
    item.videoComposition = composition
  }

  private func applyAudio(_ att: Attachment, item: AVPlayerItem, volume: Double) {
    if volume > 1.001 {
      if let gain = att.gain, att.gainInstalled, att.item === item {
        gain.gain = Float(volume)
        return
      }
      let gain = PocketEditGain(Float(volume))
      att.gain = gain
      Task { @MainActor in
        guard let tracks = try? await item.asset.loadTracks(withMediaType: .audio), !tracks.isEmpty else { return }
        item.audioMix = PocketEditAudio.mix(for: tracks, volume: volume, gain: gain)
        att.gainInstalled = true
      }
    } else if att.gainInstalled {
      // At or below 100 % the player's own volume (set from JS) does the work.
      att.gain?.gain = 1
    }
  }

  /// Re-render the paused frame through the composition.
  private func refresh(_ player: AVPlayer) {
    guard player.rate == 0, let item = player.currentItem else { return }
    item.seek(to: item.currentTime(), toleranceBefore: .zero, toleranceAfter: .zero, completionHandler: nil)
  }
}
