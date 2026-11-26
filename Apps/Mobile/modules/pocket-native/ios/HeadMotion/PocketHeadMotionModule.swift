import CoreMotion
import ExpoModulesCore
import Foundation

@Record
struct PocketHeadMotionSample {
  /// (x, y, z, w)
  var quaternion: [Double]
  /// Device clock, seconds (`CMDeviceMotion.timestamp`, uptime base).
  var timestamp: Double
}

@Record
struct PocketHeadMotionConnection {
  var connected: Bool
}

final class PocketHeadMotionException: Exception, @unchecked Sendable {
  private let text: String
  init(_ text: String) {
    self.text = text
    super.init()
  }
  override var reason: String { text }
}

/// AirPods head tracking via `CMHeadphoneMotionManager` (iOS 14+). Needs
/// `NSMotionUsageDescription` in Info.plist. Samples are delivered on a private operation queue
/// and forwarded as-is; expiry by measurement age and all head-track policy live in JS
/// (`HeadTrack` / `HeadTrackNative` ports).
@ExpoModule("PocketHeadMotion")
public final class PocketHeadMotionModule: Module {
  private lazy var bridge: PocketHeadMotionBridge = {
    let b = PocketHeadMotionBridge()
    b.onSample = { [weak self] q, t in
      self?.onSample(PocketHeadMotionSample(quaternion: q, timestamp: t))
    }
    b.onConnection = { [weak self] connected in
      self?.onConnection(PocketHeadMotionConnection(connected: connected))
    }
    return b
  }()

  @Event("onSample")
  var onSample: (PocketHeadMotionSample) -> Void

  @Event("onConnection")
  var onConnection: (PocketHeadMotionConnection) -> Void

  @JS
  func isAvailable() -> Bool {
    bridge.isAvailable
  }

  @JS
  func start() async throws {
    if let error = bridge.start() { throw PocketHeadMotionException(error) }
  }

  @JS
  func stop() {
    bridge.stop()
  }

  public override func willDestroy() {
    bridge.stop()
  }
}

/// Owns the manager. `CMHeadphoneMotionManager` methods are called under `lock`; callbacks arrive on
/// `queue`.
final class PocketHeadMotionBridge: NSObject, CMHeadphoneMotionManagerDelegate, @unchecked Sendable {
  var onSample: (([Double], Double) -> Void)?
  var onConnection: ((Bool) -> Void)?
  private let manager = CMHeadphoneMotionManager()
  private let queue: OperationQueue = {
    let q = OperationQueue()
    q.name = "pocket.headmotion"
    q.maxConcurrentOperationCount = 1
    q.qualityOfService = .userInteractive
    return q
  }()
  private let lock = NSLock()
  private var running = false

  override init() {
    super.init()
    manager.delegate = self
  }

  var isAvailable: Bool { manager.isDeviceMotionAvailable }

  /// Returns an error message, or nil once updates are running.
  func start() -> String? {
    lock.lock()
    defer { lock.unlock() }
    guard manager.isDeviceMotionAvailable else { return "headphone motion is not available on this device" }
    switch CMHeadphoneMotionManager.authorizationStatus() {
    case .denied: return "Motion & Fitness access is denied for this app"
    case .restricted: return "Motion & Fitness access is restricted"
    default: break
    }
    if running { return nil }
    running = true
    manager.startDeviceMotionUpdates(to: queue) { [weak self] motion, error in
      guard let self, let motion, error == nil else { return }
      let q = motion.attitude.quaternion
      self.onSample?([q.x, q.y, q.z, q.w], motion.timestamp)
    }
    return nil
  }

  func stop() {
    lock.lock()
    defer { lock.unlock() }
    guard running else { return }
    running = false
    manager.stopDeviceMotionUpdates()
  }

  func headphoneMotionManagerDidConnect(_ manager: CMHeadphoneMotionManager) {
    onConnection?(true)
  }

  func headphoneMotionManagerDidDisconnect(_ manager: CMHeadphoneMotionManager) {
    onConnection?(false)
  }
}
