import Foundation
import Network

/// One watcher join (twin of android/.../relay/RelayWatcher.kt): a TCP connection to a host's
/// Bonjour service on the shared camera Wi-Fi (resolved again on every join: a restarted host can
/// listen on a different port), the hello, then frames into `PocketVideoSinkRegistry` under
/// `sessionId` so `PocketVideoView` decodes them, and the small messages to JS. Retry policy lives
/// in JS (`WatcherRelayRecovery`). After `close()` no callback fires.
final class PocketRelayWatcher {
  struct Stats {
    var framesPerSec: Double
    var kbps: Double
    var frames: Double
    var lastFrameAgeMs: Double
    var codec: String?
    var catchingUp: Bool
  }

  let sessionId: String
  var onStatus: ((PocketRelayWatcher, String, String?) -> Void)?
  var onMessage: ((PocketRelayWatcher, String, String) -> Void)?
  var onStats: ((PocketRelayWatcher, Stats) -> Void)?

  private static let catchUpPaceMicros: useconds_t = 4_000

  private let q: DispatchQueue
  private let connection: NWConnection
  private let hello: Data
  // q-confined
  private var closed = false
  private var reader = PocketRelayWire.Reader(maxPayload: PocketRelayWire.maxPayload)
  private var freshness = PocketRelayFreshness()
  private var sets: [Data] = []
  private var timer: DispatchSourceTimer?
  private var frames = 0
  private var bytes = 0
  private var windowFrames = 0
  private var windowBytes = 0
  private var lastFrameAt: TimeInterval = 0
  private var codec: PocketVideoCodec?
  private var catchingUp = false

  init(sessionId: String, endpoint: NWEndpoint, hello: Data) {
    self.sessionId = sessionId
    self.hello = hello
    q = DispatchQueue(label: "pocket.relay.watch.\(sessionId)", qos: .userInitiated)
    connection = NWConnection(to: endpoint, using: PocketRelayWire.parameters())
  }

  func start() {
    connection.stateUpdateHandler = { [weak self] state in
      guard let self, !self.closed else { return }
      switch state {
      case .ready:
        self.connection.send(content: PocketRelayWire.message(.hello, self.hello), completion: .contentProcessed { _ in })
        PocketVideoSinkRegistry.shared.reset(sessionId: self.sessionId)
        self.onStatus?(self, "open", nil)
        self.startStats()
        self.receive()
      case .waiting(let error):
        // No path to the host (another network, Local Network denied): let JS retry and explain.
        self.fail(Self.describe(error))
      case .failed(let error):
        self.fail(Self.describe(error))
      case .cancelled:
        self.fail(nil)
      default:
        break
      }
    }
    q.async { [self] in onStatus?(self, "connecting", nil) }
    connection.start(queue: q)
  }

  func close() {
    q.async { [self] in
      closed = true
      timer?.cancel()
      timer = nil
      connection.cancel()
    }
  }

  func send(_ kind: PocketRelayWire.Kind, _ payload: Data) {
    q.async { [self] in
      guard !closed else { return }
      connection.send(content: PocketRelayWire.message(kind, payload), completion: .contentProcessed { [weak self] error in
        guard let self, error != nil else { return }
        self.fail(error.map(Self.describe))
      })
    }
  }

  private static func describe(_ error: NWError) -> String {
    if case .dns = error { return "That feed is not on this Wi-Fi." }
    return error.localizedDescription
  }

  private func fail(_ error: String?) {
    guard !closed else { return }
    closed = true
    timer?.cancel()
    timer = nil
    connection.cancel()
    onStatus?(self, "closed", error)
  }

  private func startStats() {
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + 1, repeating: 1)
    t.setEventHandler { [weak self] in self?.publishStats() }
    t.resume()
    timer = t
  }

  /// One batch per receive: parse, hand frames to the decoder, then read again (bounded work).
  private func receive() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, complete, error in
      guard let self, !self.closed else { return }
      do {
        for message in try self.reader.append(data ?? Data()) {
          guard !self.closed else { return }
          self.handle(message.kind, message.payload)
        }
      } catch {
        self.fail("The host sent a message this build cannot read.")
        return
      }
      guard !self.closed else { return }
      if let error {
        self.fail(Self.describe(error))
      } else if complete {
        self.fail(nil)
      } else {
        self.receive()
      }
    }
  }

  private func handle(_ kind: PocketRelayWire.Kind, _ payload: Data) {
    switch kind {
    case .hello: onMessage?(self, "hello", String(decoding: payload, as: UTF8.self))
    case .state: onMessage?(self, "state", String(decoding: payload, as: UTF8.self))
    case .controlToken: onMessage?(self, "token", String(decoding: payload, as: UTF8.self))
    case .joinDenied:
      onMessage?(self, "denied", String(decoding: payload, as: UTF8.self))
      closed = true
      timer?.cancel()
      timer = nil
      connection.cancel()
    case .frame:
      guard let frame = PocketRelayWire.decodeFrame(payload) else {
        fail("The host sent a message this build cannot read.")
        return
      }
      let now = PocketRelayWire.now()
      if !frame.catchUp, freshness.isFallingBehind(encodedAt: frame.encodedAt, receivedAt: now) {
        fail(PocketRelayWire.fellBehind)
        return
      }
      if !frame.parameterSets.isEmpty { sets = frame.parameterSets }
      var au = frame.accessUnit
      if frame.keyframe, !sets.isEmpty, PocketRelayWire.classify(au, codec: frame.codec).parameterSets.isEmpty {
        au = PocketRelayWire.prefixed(sets, au)
      }
      frames += 1
      bytes += payload.count
      lastFrameAt = now
      codec = frame.codec
      catchingUp = frame.catchUp
      PocketVideoSinkRegistry.shared.publish(
        accessUnit: au, codec: frame.codec, presentationTimeUs: Int64(now * 1_000_000), to: sessionId)
      // A joiner's catch-up arrives as a burst; pace it so the decoder does not shed it.
      if frame.catchUp { usleep(Self.catchUpPaceMicros) }
    case .requestControl, .releaseControl, .command:
      break
    }
  }

  private func publishStats() {
    guard !closed else { return }
    let fps = Double(frames - windowFrames)
    let kbps = Double(bytes - windowBytes) * 8 / 1000
    windowFrames = frames
    windowBytes = bytes
    let age = lastFrameAt > 0 ? (PocketRelayWire.now() - lastFrameAt) * 1000 : -1
    onStats?(
      self,
      Stats(
        framesPerSec: fps, kbps: kbps, frames: Double(frames), lastFrameAgeMs: age,
        codec: codec.map { $0 == .avc ? "avc" : "hevc" }, catchingUp: catchingUp))
  }
}

/// Finds sharing hosts on both service types with TXT (`c` camera, `w` watchable). Same network
/// recipe as joins: no peer-to-peer, no cellular, so an off-network host is never listed.
final class PocketRelayBrowser {
  struct Host: Equatable {
    var id: String
    var name: String
    var camera: String
    var serviceType: String
    var watchable: Bool
  }

  var onChange: (([Host], _ browsing: Bool, _ error: String?) -> Void)?

  private let q = DispatchQueue(label: "pocket.relay.browse")
  private var browsers: [String: NWBrowser] = [:]
  private var results: [String: [Host]] = [:]
  private var error: String?
  private var generation = 0

  func start() {
    q.async { [self] in
      guard browsers.isEmpty else { return }
      generation += 1
      let gen = generation
      error = nil
      for type in PocketRelayWire.browseTypes {
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: type, domain: nil), using: PocketRelayWire.parameters())
        browser.stateUpdateHandler = { [weak self] state in
          guard let self, self.generation == gen else { return }
          switch state {
          case .failed(let e), .waiting(let e):
            self.error = "Could not look for shared feeds. Allow Local Network and join the camera Wi-Fi. (\(e.localizedDescription))"
            self.publish()
          case .ready:
            if self.error != nil {
              self.error = nil
              self.publish()
            }
          default:
            break
          }
        }
        browser.browseResultsChangedHandler = { [weak self] found, _ in
          guard let self, self.generation == gen else { return }
          self.results[type] = found.compactMap { result in
            guard case .service(let name, _, _, _) = result.endpoint else { return nil }
            var camera = ""
            var watchable = true
            if case .bonjour(let txt) = result.metadata {
              camera = txt[PocketRelayWire.txtCamera] ?? ""
              watchable = txt[PocketRelayWire.txtWatchable] != "0"
            }
            return Host(id: "\(type)/\(name)", name: name, camera: camera, serviceType: type, watchable: watchable)
          }
          self.publish()
        }
        browsers[type] = browser
        browser.start(queue: q)
      }
      publish()
    }
  }

  func stop() {
    q.async { [self] in
      generation += 1
      for browser in browsers.values { browser.cancel() }
      browsers.removeAll()
      results.removeAll()
      error = nil
      publish()
    }
  }

  private func publish() {
    var seen = Set<String>()
    var hosts: [Host] = []
    // Ours first, so a name on both types shows once, as ours.
    for type in PocketRelayWire.browseTypes {
      for host in results[type] ?? [] where !seen.contains(host.name) {
        seen.insert(host.name)
        hosts.append(host)
      }
    }
    hosts.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    onChange?(hosts, !browsers.isEmpty, error)
  }

  /// A host id (`<type>/<name>`) as a Bonjour endpoint NWConnection resolves itself.
  static func endpoint(for hostId: String) -> NWEndpoint? {
    guard let slash = hostId.firstIndex(of: "/") else { return nil }
    let type = String(hostId[..<slash])
    let name = String(hostId[hostId.index(after: slash)...])
    guard PocketRelayWire.browseTypes.contains(type), !name.isEmpty else { return nil }
    return .service(name: name, type: type, domain: "local.", interface: nil)
  }
}
