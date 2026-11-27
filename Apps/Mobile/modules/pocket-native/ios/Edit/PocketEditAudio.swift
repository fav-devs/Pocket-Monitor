import AVFoundation
import Foundation
import MediaToolbox

/// The audio stage: a gain on every audio track. Up to 1.0 uses the mix's own volume; above
/// (up to 2.0 = +6 dB) an MTAudioProcessingTap scales and clips the samples, because
/// `AVAudioMixInputParameters.setVolume` cannot boost.
final class PocketEditGain: @unchecked Sendable {
  /// Read on the audio thread; a plain Float store is atomic enough for a gain.
  var gain: Float
  fileprivate var isFloat = true
  fileprivate var bitsPerChannel: UInt32 = 32

  init(_ gain: Float) {
    self.gain = gain
  }
}

enum PocketEditAudio {
  /// An audio mix for `tracks` at `volume` (0…2), or nil at unity.
  static func mix(for tracks: [AVAssetTrack], volume: Double, gain box: PocketEditGain? = nil) -> AVMutableAudioMix? {
    guard !tracks.isEmpty, abs(volume - 1) > 0.001 else { return nil }
    let mix = AVMutableAudioMix()
    mix.inputParameters = tracks.map { track in
      let params = AVMutableAudioMixInputParameters(track: track)
      if volume <= 1 {
        params.setVolume(Float(max(0, volume)), at: .zero)
      } else if let tap = makeGainTap(box ?? PocketEditGain(Float(volume))) {
        params.audioTapProcessor = tap
      } else {
        params.setVolume(1, at: .zero)
      }
      return params
    }
    return mix
  }

  /// A post-effects tap that multiplies samples by `box.gain`.
  static func makeGainTap(_ box: PocketEditGain) -> MTAudioProcessingTap? {
    var callbacks = MTAudioProcessingTapCallbacks(
      version: kMTAudioProcessingTapCallbacksVersion_0,
      clientInfo: UnsafeMutableRawPointer(Unmanaged.passRetained(box).toOpaque()),
      init: { _, clientInfo, tapStorageOut in
        tapStorageOut.pointee = clientInfo
      },
      finalize: { tap in
        Unmanaged<PocketEditGain>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release()
      },
      prepare: { tap, _, format in
        let box = Unmanaged<PocketEditGain>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
        box.isFloat = (format.pointee.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        box.bitsPerChannel = format.pointee.mBitsPerChannel
      },
      unprepare: nil,
      process: { tap, numberFrames, _, bufferListInOut, numberFramesOut, flagsOut in
        let status = MTAudioProcessingTapGetSourceAudio(tap, numberFrames, bufferListInOut, flagsOut, nil, numberFramesOut)
        guard status == noErr else { return }
        let box = Unmanaged<PocketEditGain>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
        let gain = box.gain
        if abs(gain - 1) < 0.0001 { return }
        for buffer in UnsafeMutableAudioBufferListPointer(bufferListInOut) {
          guard let data = buffer.mData else { continue }
          if box.isFloat && box.bitsPerChannel == 32 {
            let n = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
            let p = data.assumingMemoryBound(to: Float.self)
            for i in 0..<n { p[i] = min(1, max(-1, p[i] * gain)) }
          } else if !box.isFloat && box.bitsPerChannel == 16 {
            let n = Int(buffer.mDataByteSize) / MemoryLayout<Int16>.size
            let p = data.assumingMemoryBound(to: Int16.self)
            for i in 0..<n { p[i] = Int16(clamping: Int(Float(p[i]) * gain)) }
          }
        }
      }
    )
    var tap: MTAudioProcessingTap?
    let err = MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PostEffects, &tap)
    if err != noErr {
      // The tap never took ownership of the box.
      Unmanaged<PocketEditGain>.fromOpaque(callbacks.clientInfo!).release()
      return nil
    }
    return tap
  }
}
