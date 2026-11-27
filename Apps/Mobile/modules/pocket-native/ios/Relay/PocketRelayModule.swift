import ExpoModulesCore
import Foundation
import UIKit

@Record
struct PocketRelayHostAdvertRecord {
  var id: String
  var name: String
  var camera: String
  var serviceType: String
  var watchable: Bool
}

@Record
struct PocketRelayHostsEvent {
  var hosts: [PocketRelayHostAdvertRecord]
  var browsing: Bool
  var error: String?
}

@Record
struct PocketRelayHostStartOptions {
  var cameraSessionId: String
  var hostName: String = ""
  var cameraName: String = ""
  var passcode: String = ""
  var allowsControl: Bool = false
  var window: Int = 2
}

@Record
struct PocketRelayHostUpdateOptions {
  var passcode: String = ""
  var allowsControl: Bool = false
  var window: Int = 2
}

@Record
struct PocketRelayPendingRecord {
  var name: String
  var watcherId: String
}

@Record
struct PocketRelayHostStatusEvent {
  var state: String
  var error: String?
  var watchers: Int
  var pending: PocketRelayPendingRecord?
  var holder: String
  var joinable: Bool
}

@Record
struct PocketRelayHostCommandEvent {
  var json: String
  var watcherId: String
}

@Record
struct PocketRelayJoinOptions {
  var sessionId: String
  var hostId: String
  var hello: String
}

@Record
struct PocketRelayWatcherStatusEvent {
  var sessionId: String
  var state: String
  var error: String?
}

@Record
struct PocketRelayWatcherMessageEvent {
  var sessionId: String
  var kind: String
  var json: String
}

@Record
struct PocketRelayWatcherStatsEvent {
  var sessionId: String
  var framesPerSec: Double
  var kbps: Double
  var frames: Double
  var lastFrameAgeMs: Double
  var codec: String?
  var catchingUp: Bool
}

final class PocketRelayException: Exception, @unchecked Sendable {
  private let text: String
  init(_ text: String) {
    self.text = text
    super.init()
  }
  override var reason: String { text }
}

/// This device's name for Bonjour and the hello. `UIDevice.name` is main-actor; it is read once on
/// main and cached (iOS 16+ returns the model name without the user-assigned-name entitlement).
enum PocketRelayDevice {
  private static let lock = NSLock()
  private static var cached: String?

  static var name: String {
    lock.lock()
    let value = cached
    lock.unlock()
    if let value { return value }
    if Thread.isMainThread {
      let name = MainActor.assumeIsolated { UIDevice.current.name }
      store(name)
      return name
    }
    DispatchQueue.main.async { store(MainActor.assumeIsolated { UIDevice.current.name }) }
    return "iPhone"
  }

  private static func store(_ name: String) {
    lock.lock()
    cached = name
    lock.unlock()
  }
}

/// JS module `PocketRelay` (`src/types.ts` `PocketRelayNativeModule`): the watcher relay host
/// (`PocketRelayHost`), browsing (`PocketRelayBrowser`) and watcher joins (`PocketRelayWatcher`).
/// Sockets, Bonjour, framing and video stay native; JS gets the small JSON messages and status.
@ExpoModule("PocketRelay")
public final class PocketRelayModule: Module {
  private let lock = NSLock()
  private var watchers: [String: PocketRelayWatcher] = [:]

  private lazy var host: PocketRelayHost = {
    let h = PocketRelayHost()
    h.onStatus = { [weak self] s in
      self?.onHostStatus(
        PocketRelayHostStatusEvent(
          state: s.state, error: s.error, watchers: s.watchers,
          pending: s.pendingName.map { PocketRelayPendingRecord(name: $0, watcherId: s.pendingWatcherId ?? "") },
          holder: s.holder, joinable: s.joinable))
    }
    h.onCommand = { [weak self] json, watcherId in
      self?.onHostCommand(PocketRelayHostCommandEvent(json: json, watcherId: watcherId))
    }
    return h
  }()

  private lazy var browser: PocketRelayBrowser = {
    let b = PocketRelayBrowser()
    b.onChange = { [weak self] hosts, browsing, error in
      self?.onHosts(
        PocketRelayHostsEvent(
          hosts: hosts.map {
            PocketRelayHostAdvertRecord(id: $0.id, name: $0.name, camera: $0.camera, serviceType: $0.serviceType, watchable: $0.watchable)
          },
          browsing: browsing, error: error))
    }
    return b
  }()

  @Event("onHosts")
  var onHosts: (PocketRelayHostsEvent) -> Void

  @Event("onHostStatus")
  var onHostStatus: (PocketRelayHostStatusEvent) -> Void

  @Event("onHostCommand")
  var onHostCommand: (PocketRelayHostCommandEvent) -> Void

  @Event("onWatcherStatus")
  var onWatcherStatus: (PocketRelayWatcherStatusEvent) -> Void

  @Event("onWatcherMessage")
  var onWatcherMessage: (PocketRelayWatcherMessageEvent) -> Void

  @Event("onWatcherStats")
  var onWatcherStats: (PocketRelayWatcherStatsEvent) -> Void

  /// Synchronous scope for the join table (NSLock is unavailable in async contexts).
  private func locked<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  private func isCurrent(_ watcher: PocketRelayWatcher) -> Bool {
    locked { watchers[watcher.sessionId] === watcher }
  }

  @JS
  func deviceName() -> String {
    PocketRelayDevice.name
  }

  // MARK: Host

  @JS
  func startHost(options: PocketRelayHostStartOptions) async throws {
    let device = await MainActor.run { UIDevice.current.name }
    let name = options.hostName.isEmpty ? device : options.hostName
    let next = PocketRelayHost.Options(
      cameraSessionId: options.cameraSessionId, hostName: name, cameraName: options.cameraName,
      passcode: options.passcode.trimmingCharacters(in: .whitespacesAndNewlines),
      allowsControl: options.allowsControl, window: min(8, max(1, options.window)))
    let host = self.host
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
      host.start(next) { error in
        if let error { c.resume(throwing: PocketRelayException(error.localizedDescription)) } else { c.resume() }
      }
    }
  }

  @JS
  func stopHost(reason: String?) {
    host.stop(reason: reason.flatMap { $0.isEmpty ? nil : $0 })
  }

  @JS
  func updateHost(options: PocketRelayHostUpdateOptions) {
    host.update(passcode: options.passcode, allowsControl: options.allowsControl, window: options.window)
  }

  @JS
  func publishHostState(json: String) {
    host.publishState(json)
  }

  @JS
  func grantControl() {
    host.grantControl()
  }

  @JS
  func denyControl() {
    host.denyControl()
  }

  @JS
  func reclaimControl() {
    host.reclaimControl()
  }

  // MARK: Browse

  @JS
  func startBrowse() {
    browser.start()
  }

  @JS
  func stopBrowse() {
    browser.stop()
  }

  // MARK: Watcher

  @JS
  func join(options: PocketRelayJoinOptions) async throws {
    guard let endpoint = PocketRelayBrowser.endpoint(for: options.hostId) else {
      throw PocketRelayException("That feed is not on this Wi-Fi.")
    }
    let watcher = PocketRelayWatcher(sessionId: options.sessionId, endpoint: endpoint, hello: Data(options.hello.utf8))
    watcher.onStatus = { [weak self] w, state, error in
      guard let self, self.isCurrent(w) else { return }
      if state == "closed" {
        self.locked { if self.watchers[w.sessionId] === w { self.watchers[w.sessionId] = nil } }
      }
      self.onWatcherStatus(PocketRelayWatcherStatusEvent(sessionId: w.sessionId, state: state, error: error))
    }
    watcher.onMessage = { [weak self] w, kind, json in
      guard let self, self.isCurrent(w) else { return }
      self.onWatcherMessage(PocketRelayWatcherMessageEvent(sessionId: w.sessionId, kind: kind, json: json))
    }
    watcher.onStats = { [weak self] w, s in
      guard let self, self.isCurrent(w) else { return }
      self.onWatcherStats(
        PocketRelayWatcherStatsEvent(
          sessionId: w.sessionId, framesPerSec: s.framesPerSec, kbps: s.kbps, frames: s.frames,
          lastFrameAgeMs: s.lastFrameAgeMs, codec: s.codec, catchingUp: s.catchingUp))
    }
    let replaced: PocketRelayWatcher? = locked {
      let old = watchers[options.sessionId]
      watchers[options.sessionId] = watcher
      return old
    }
    replaced?.close()
    watcher.start()
  }

  @JS
  func leave(sessionId: String) {
    let watcher: PocketRelayWatcher? = locked { watchers.removeValue(forKey: sessionId) }
    watcher?.close()
  }

  @JS
  func requestControl(sessionId: String) {
    locked { watchers[sessionId] }?.send(.requestControl, Data())
  }

  @JS
  func releaseControl(sessionId: String) {
    locked { watchers[sessionId] }?.send(.releaseControl, Data())
  }

  @JS
  func sendCommand(sessionId: String, json: String) {
    locked { watchers[sessionId] }?.send(.command, Data(json.utf8))
  }

  public override func willDestroy() {
    let all: [PocketRelayWatcher] = locked {
      let values = Array(watchers.values)
      watchers.removeAll()
      return values
    }
    for w in all { w.close() }
    host.stop(reason: nil)
    browser.stop()
  }
}
