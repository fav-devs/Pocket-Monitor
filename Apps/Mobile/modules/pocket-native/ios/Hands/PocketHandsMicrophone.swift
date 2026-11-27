import AVFoundation
import Foundation

/// The microphone for the double clap: `AVAudioEngine`'s input, mixed to mono and cut into 10 ms
/// blocks, each reduced to its peak and RMS level; ten blocks go to JS per `onAudio` (about ten
/// a second), where `ClapDetector` (`src/core/gestures/clap.ts`, the desktop's) listens. Raw
/// audio never leaves this file and nothing is recorded.
///
/// The audio session becomes `.playAndRecord` / `.measurement` (no automatic gain, which would
/// flatten a clap) and mixes with others; the category it had before (Picture in Picture's
/// `.playback`) is put back on `stop`. JS opens it only while gestures run on the live view.
final class PocketHandsMicrophone: @unchecked Sendable {
  var onAudio: ((PocketHandsAudioEvent) -> Void)?

  private let lock = NSLock()
  private var engine: AVAudioEngine?
  private var saved: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?

  // ---- the input tap's thread ----
  private var sampleRate: Double = 48_000
  private var blockLength = 480
  private var count = 0
  private var peak: Float = 0
  private var sumSquares: Float = 0
  private var peaks: [Double] = []
  private var levels: [Double] = []

  /// Opens the microphone. Returns why not, or nil once it listens.
  func start() -> String? {
    lock.lock()
    defer { lock.unlock() }
    if engine != nil { return nil }
    guard AVAudioApplication.shared.recordPermission == .granted else { return "microphone access is off" }
    let session = AVAudioSession.sharedInstance()
    saved = (session.category, session.mode, session.categoryOptions)
    do {
      try session.setCategory(.playAndRecord, mode: .measurement, options: [.mixWithOthers, .allowBluetoothA2DP])
      try session.setActive(true)
    } catch {
      restoreSession()
      return "the microphone could not open"
    }
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      restoreSession()
      return "this phone has no microphone"
    }
    sampleRate = format.sampleRate
    blockLength = max(1, Int(format.sampleRate * 0.01))
    count = 0
    peak = 0
    sumSquares = 0
    peaks = []
    levels = []
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.consume(buffer)
    }
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      restoreSession()
      return "the microphone could not start"
    }
    self.engine = engine
    return nil
  }

  func stop() {
    lock.lock()
    defer { lock.unlock() }
    guard let engine else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    self.engine = nil
    restoreSession()
  }

  /// Under `lock`.
  private func restoreSession() {
    guard let saved else { return }
    self.saved = nil
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(saved.category, mode: saved.mode, options: saved.options)
    if saved.category != .playback {
      try? session.setActive(false, options: [.notifyOthersOnDeactivation])
    }
  }

  /// The tap's thread: mono, 10 ms blocks, ten per event.
  private func consume(_ buffer: AVAudioPCMBuffer) {
    guard let data = buffer.floatChannelData else { return }
    let channels = Int(buffer.format.channelCount)
    let frames = Int(buffer.frameLength)
    guard channels > 0 else { return }
    let interleaved = buffer.format.isInterleaved
    for i in 0..<frames {
      var sum: Float = 0
      for c in 0..<channels {
        sum += interleaved ? data[0][i * channels + c] : data[c][i]
      }
      let sample = sum / Float(channels)
      peak = max(peak, abs(sample))
      sumSquares += sample * sample
      count += 1
      if count >= blockLength {
        peaks.append(Double(peak))
        levels.append(Double((sumSquares / Float(count)).squareRoot()))
        peak = 0
        sumSquares = 0
        count = 0
      }
    }
    if peaks.count >= 10 {
      let event = PocketHandsAudioEvent(sampleRate: sampleRate, peaks: peaks, levels: levels)
      peaks.removeAll(keepingCapacity: true)
      levels.removeAll(keepingCapacity: true)
      onAudio?(event)
    }
  }
}
