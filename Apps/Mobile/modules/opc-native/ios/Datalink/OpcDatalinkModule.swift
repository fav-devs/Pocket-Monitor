import ExpoModulesCore
import Foundation

@Record
struct OpcDatalinkTcpPoke {
  var port: Int
  var bytes: Data
}

@Record
struct OpcDatalinkOpenOptions {
  var host: String = "192.168.2.1"
  var port: Int = 9004
  var localPort: Int = 0
  var ackHz: Double = 40
  var tcpPoke: OpcDatalinkTcpPoke?
}

@Record
struct OpcDatalinkFrameEvent {
  var sessionId: String
  var bytes: Data
}

@Record
struct OpcDatalinkStateEvent {
  var sessionId: String
  var state: String
  var error: String?
}

@Record
struct OpcDatalinkStatsEvent {
  var sessionId: String
  var rxPackets: Int
  var txPackets: Int
  var rxBytesPerSec: Double
  var videoPacketsPerSec: Double
  var ackHz: Double
  var lastRxAgeMs: Double
}

final class OpcDatalinkOpenException: Exception, @unchecked Sendable {
  private let text: String
  init(_ text: String) {
    self.text = text
    super.init()
  }
  override var reason: String { text }
}

/// JS module `OpcDatalink` (see `src/types.ts` `OpcDatalinkNativeModule`). Owns the per-session
/// `OpcDatalinkSession`s; every hot-path byte stays native. JS only receives DUML frames, state
/// and 1 Hz stats.
@ExpoModule("OpcDatalink")
public final class OpcDatalinkModule: Module, OpcDatalinkSessionDelegate {
  private let lock = NSLock()
  private var sessions: [String: OpcDatalinkSession] = [:]
  /// attachVideo before open: applied when the session opens.
  private var pendingVideo: [String: OpcVideoCodec] = [:]

  @Event("onDuml")
  var onDuml: (OpcDatalinkFrameEvent) -> Void

  @Event("onState")
  var onState: (OpcDatalinkStateEvent) -> Void

  @Event("onStats")
  var onStats: (OpcDatalinkStatsEvent) -> Void

  /// Synchronous scope for the session table (NSLock is unavailable in async contexts).
  private func locked<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  private func session(_ id: String) -> OpcDatalinkSession? {
    locked { sessions[id] }
  }

  @JS("open")
  func openSession(sessionId: String, options: OpcDatalinkOpenOptions) async throws {
    let replaced = locked { sessions.removeValue(forKey: sessionId) }
    if let replaced {
      await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
        replaced.close { c.resume() }
      }
    }
    let poke = options.tcpPoke.flatMap { p -> (UInt16, Data)? in
      guard let port = UInt16(exactly: p.port), !p.bytes.isEmpty else { return nil }
      return (port, p.bytes)
    }
    let session = OpcDatalinkSession(
      id: sessionId,
      options: .init(
        host: options.host,
        port: UInt16(clamping: options.port),
        localPort: UInt16(clamping: options.localPort),
        ackHz: options.ackHz,
        tcpPokePort: poke?.0,
        tcpPokeBytes: poke?.1))
    session.delegate = self
    let codec: OpcVideoCodec? = locked {
      sessions[sessionId] = session
      return pendingVideo.removeValue(forKey: sessionId)
    }
    if let codec { session.attachVideo(codec: codec) }
    do {
      try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
        session.open { error in
          if let error { c.resume(throwing: error) } else { c.resume() }
        }
      }
    } catch {
      locked {
        if sessions[sessionId] === session { sessions.removeValue(forKey: sessionId) }
      }
      await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
        session.close { c.resume() }
      }
      throw OpcDatalinkOpenException(error.localizedDescription)
    }
  }

  @JS("close")
  func closeSession(sessionId: String) async {
    let session: OpcDatalinkSession? = locked {
      pendingVideo.removeValue(forKey: sessionId)
      return sessions.removeValue(forKey: sessionId)
    }
    guard let session else { return }
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      session.close { c.resume() }
    }
  }

  @JS
  func sendDuml(sessionId: String, bytes: Data) {
    session(sessionId)?.sendDuml(bytes)
  }

  @JS
  func sendRaw(sessionId: String, bytes: Data) {
    session(sessionId)?.sendRaw(bytes)
  }

  @JS
  func attachVideo(sessionId: String, codec: String) {
    let c: OpcVideoCodec = codec == "avc" ? .avc : .hevc
    if let s = session(sessionId) {
      s.attachVideo(codec: c)
    } else {
      locked { pendingVideo[sessionId] = c }
    }
  }

  @JS
  func detachVideo(sessionId: String) {
    locked { _ = pendingVideo.removeValue(forKey: sessionId) }
    session(sessionId)?.detachVideo()
  }

  public override func willDestroy() {
    let all: [OpcDatalinkSession] = locked {
      let values = Array(sessions.values)
      sessions.removeAll()
      pendingVideo.removeAll()
      return values
    }
    for s in all { s.close {} }
  }

  // MARK: - OpcDatalinkSessionDelegate (datalink queue)

  func datalinkSession(_ session: OpcDatalinkSession, didReceiveDuml frame: Data) {
    onDuml(OpcDatalinkFrameEvent(sessionId: session.id, bytes: frame))
  }

  func datalinkSession(_ session: OpcDatalinkSession, didChangeState state: String, error: String?) {
    onState(OpcDatalinkStateEvent(sessionId: session.id, state: state, error: error))
  }

  func datalinkSession(_ session: OpcDatalinkSession, didReport stats: OpcDatalinkSession.Stats) {
    onStats(
      OpcDatalinkStatsEvent(
        sessionId: session.id, rxPackets: stats.rxPackets, txPackets: stats.txPackets,
        rxBytesPerSec: stats.rxBytesPerSec, videoPacketsPerSec: stats.videoPacketsPerSec,
        ackHz: stats.ackHz, lastRxAgeMs: stats.lastRxAgeMs))
  }
}
