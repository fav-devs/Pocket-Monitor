import ExpoModulesCore
import Foundation

/// `start` options (`HandsStartOptions` in src/types.ts).
@Record
struct PocketHandsStartOptions {
  /// `cameraFeed` or `frontCamera`.
  var source: String = "cameraFeed"
  /// `cameraFeed`: the native video session whose decoded picture is read.
  var sessionId: String?
  /// Pictures offered to the models per second.
  var rate: Double = 15
  /// Width the camera's picture is scaled to before the models read it.
  var width: Int = 480
}

/// One hand: 42 numbers (x, y of MediaPipe's 21 landmarks, picture fractions, origin top-left).
@Record
struct PocketHandsLandmarks {
  var points: [Double]
  var score: Double
  var right: Bool
}

@Record
struct PocketHandsFace {
  var x: Double
  var y: Double
  var width: Double
  var height: Double
  var score: Double
}

/// `onHands`.
@Record
struct PocketHandsSeenEvent {
  var source: String
  var hands: [PocketHandsLandmarks]
  /// Nil unless this picture was searched for faces.
  var faces: [PocketHandsFace]?
  var aspect: Double
  var ms: Double
}

/// `onStatus`.
@Record
struct PocketHandsStatusEvent {
  var state: String
  var provider: String?
  var error: String?
}

/// `onAudio`: 10 ms blocks of the microphone, each its peak and RMS level.
@Record
struct PocketHandsAudioEvent {
  var sampleRate: Double
  var peaks: [Double]
  var levels: [Double]
}

final class PocketHandsException: Exception, @unchecked Sendable {
  private let text: String
  init(_ text: String) {
    self.text = text
    super.init()
  }
  override var reason: String { text }
}

/// JS module `PocketHands` (`PocketHandsNativeModule` in src/types.ts): hands and faces read with
/// Apple Vision from the camera's decoded live picture (`PocketVideoSessionHub`) or the front
/// camera, and the microphone's level blocks for the double clap. Every gesture rule is
/// TypeScript (`src/core/gestures`); this only reads pictures and sound, off the render path,
/// and only while JS has it started (gestures on, the live view in front).
@ExpoModule("PocketHands")
public final class PocketHandsModule: Module {
  private lazy var reader: PocketHandsReader = {
    let r = PocketHandsReader()
    r.onSeen = { [weak self] event in self?.onHands(event) }
    r.onStatus = { [weak self] event in self?.onStatus(event) }
    return r
  }()

  private lazy var microphone: PocketHandsMicrophone = {
    let m = PocketHandsMicrophone()
    m.onAudio = { [weak self] event in self?.onAudio(event) }
    return m
  }()

  @Event("onHands")
  var onHands: (PocketHandsSeenEvent) -> Void

  @Event("onStatus")
  var onStatus: (PocketHandsStatusEvent) -> Void

  @Event("onAudio")
  var onAudio: (PocketHandsAudioEvent) -> Void

  @JS
  func isAvailable() -> Bool {
    true
  }

  @JS
  func start(options: PocketHandsStartOptions) async throws {
    if let error = await reader.start(options) { throw PocketHandsException(error) }
  }

  @JS
  func stop() {
    reader.stop()
  }

  @JS
  func setWantsFaces(on: Bool) {
    reader.setWantsFaces(on)
  }

  @JS
  func startMicrophone() async throws {
    if let error = microphone.start() { throw PocketHandsException(error) }
  }

  @JS
  func stopMicrophone() {
    microphone.stop()
  }

  public override func willDestroy() {
    reader.stop()
    microphone.stop()
  }
}
