import Foundation

/// Where the datalink hands complete video access units for a session.
/// Datalink (producer) and Video (consumer) live in the same pod and meet here.
public protocol OpcVideoSink: AnyObject {
  /// One Annex-B access unit (start-code-prefixed NAL units, parameter sets inline when sent).
  /// Called on the datalink's receive queue; implementations must not block.
  func receive(accessUnit: Data, codec: OpcVideoCodec, presentationTimeUs: Int64)
  /// The datalink lost or reset the stream; drop decoder state and wait for a keyframe.
  func reset()
}

public enum OpcVideoCodec: String {
  case hevc
  case avc
}

public final class OpcVideoSinkRegistry {
  public static let shared = OpcVideoSinkRegistry()
  private let lock = NSLock()
  private var sinks: [String: [WeakSink]] = [:]

  private struct WeakSink { weak var sink: OpcVideoSink? }

  public func add(_ sink: OpcVideoSink, for sessionId: String) {
    lock.lock(); defer { lock.unlock() }
    var list = sinks[sessionId, default: []].filter { $0.sink != nil }
    if !list.contains(where: { $0.sink === sink }) { list.append(WeakSink(sink: sink)) }
    sinks[sessionId] = list
  }

  public func remove(_ sink: OpcVideoSink, for sessionId: String) {
    lock.lock(); defer { lock.unlock() }
    sinks[sessionId] = sinks[sessionId]?.filter { $0.sink != nil && $0.sink !== sink }
  }

  public func sinks(for sessionId: String) -> [OpcVideoSink] {
    lock.lock(); defer { lock.unlock() }
    return sinks[sessionId]?.compactMap(\.sink) ?? []
  }
}
