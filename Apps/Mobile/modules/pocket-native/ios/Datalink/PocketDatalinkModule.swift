import ExpoModulesCore
import Foundation

@Record
struct PocketDatalinkTcpPoke {
  var port: Int
  var bytes: Data
}

@Record
struct PocketDatalinkOpenOptions {
  var host: String = "192.168.2.1"
  var port: Int = 9004
  var localPort: Int = 0
  var ackHz: Double = 40
  var tcpPoke: PocketDatalinkTcpPoke?
}

@Record
struct PocketDatalinkFrameEvent {
  var sessionId: String
  var bytes: Data
}

@Record
struct PocketDatalinkStateEvent {
  var sessionId: String
  var state: String
  var error: String?
}

@Record
struct PocketDatalinkStatsEvent {
  var sessionId: String
  var rxPackets: Int
  var txPackets: Int
  var rxBytesPerSec: Double
  var videoPacketsPerSec: Double
  var ackHz: Double
  var lastRxAgeMs: Double
}

final class PocketDatalinkOpenException: Exception, @unchecked Sendable {
  private let text: String
  init(_ text: String) {
    self.text = text
    super.init()
  }
  override var reason: String { text }
}

/// JS module `PocketDatalink` (see `src/types.ts` `PocketDatalinkNativeModule`). Owns the per-session
/// `PocketDatalinkSession`s; every hot-path byte stays native. JS only receives DUML frames, state
/// and 1 Hz stats.
@ExpoModule("PocketDatalink")
public final class PocketDatalinkModule: Module, PocketDatalinkSessionDelegate {
  private let lock = NSLock()
  private var sessions: [String: PocketDatalinkSession] = [:]
  /// attachVideo before open: applied when the session opens.
  private var pendingVideo: [String: PocketVideoCodec] = [:]

  @Event("onDuml")
  var onDuml: (PocketDatalinkFrameEvent) -> Void

  @Event("onState")
  var onState: (PocketDatalinkStateEvent) -> Void

  @Event("onStats")
  var onStats: (PocketDatalinkStatsEvent) -> Void

  /// Synchronous scope for the session table (NSLock is unavailable in async contexts).
  private func locked<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  private func session(_ id: String) -> PocketDatalinkSession? {
    locked { sessions[id] }
  }

  @JS("open")
  func openSession(sessionId: String, options: PocketDatalinkOpenOptions) async throws {
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
    let session = PocketDatalinkSession(
      id: sessionId,
      options: .init(
        host: options.host,
        port: UInt16(clamping: options.port),
        localPort: UInt16(clamping: options.localPort),
        ackHz: options.ackHz,
        tcpPokePort: poke?.0,
        tcpPokeBytes: poke?.1))
    session.delegate = self
    let codec: PocketVideoCodec? = locked {
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
      throw PocketDatalinkOpenException(error.localizedDescription)
    }
  }

  @JS("close")
  func closeSession(sessionId: String) async {
    let session: PocketDatalinkSession? = locked {
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
    let c: PocketVideoCodec = codec == "avc" ? .avc : .hevc
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
    let all: [PocketDatalinkSession] = locked {
      let values = Array(sessions.values)
      sessions.removeAll()
      pendingVideo.removeAll()
      return values
    }
    for s in all { s.close {} }
  }

  // MARK: - PocketDatalinkSessionDelegate (datalink queue)

  func datalinkSession(_ session: PocketDatalinkSession, didReceiveDuml frame: Data) {
    onDuml(PocketDatalinkFrameEvent(sessionId: session.id, bytes: frame))
  }

  func datalinkSession(_ session: PocketDatalinkSession, didChangeState state: String, error: String?) {
    onState(PocketDatalinkStateEvent(sessionId: session.id, state: state, error: error))
  }

  func datalinkSession(_ session: PocketDatalinkSession, didReport stats: PocketDatalinkSession.Stats) {
    onStats(
      PocketDatalinkStatsEvent(
        sessionId: session.id, rxPackets: stats.rxPackets, txPackets: stats.txPackets,
        rxBytesPerSec: stats.rxBytesPerSec, videoPacketsPerSec: stats.videoPacketsPerSec,
        ackHz: stats.ackHz, lastRxAgeMs: stats.lastRxAgeMs))
  }
}
