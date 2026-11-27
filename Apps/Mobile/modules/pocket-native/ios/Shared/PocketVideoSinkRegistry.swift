import Foundation

/// Where the datalink hands complete video access units for a session.
/// Datalink (producer) and Video (consumer) live in the same pod and meet here.
public protocol PocketVideoSink: AnyObject {
  /// One Annex-B access unit (start-code-prefixed NAL units, parameter sets inline when sent).
  /// Called on the datalink's receive queue; implementations must not block.
  func receive(accessUnit: Data, codec: PocketVideoCodec, presentationTimeUs: Int64)
  /// The datalink lost or reset the stream; drop decoder state and wait for a keyframe.
  func reset()
}

public enum PocketVideoCodec: String {
  case hevc
  case avc
}

public final class PocketVideoSinkRegistry {
  public static let shared = PocketVideoSinkRegistry()
  private let lock = NSLock()
  private var sinks: [String: [WeakSink]] = [:]

  private struct WeakSink { weak var sink: PocketVideoSink? }

  public func add(_ sink: PocketVideoSink, for sessionId: String) {
    lock.lock(); defer { lock.unlock() }
    var list = sinks[sessionId, default: []].filter { $0.sink != nil }
    if !list.contains(where: { $0.sink === sink }) { list.append(WeakSink(sink: sink)) }
    sinks[sessionId] = list
  }

  public func remove(_ sink: PocketVideoSink, for sessionId: String) {
    lock.lock(); defer { lock.unlock() }
    sinks[sessionId] = sinks[sessionId]?.filter { $0.sink != nil && $0.sink !== sink }
  }

  /// Every consumer of `sessionId`: its decoders, then its taps.
  public func sinks(for sessionId: String) -> [PocketVideoSink] {
    lock.lock(); defer { lock.unlock() }
    return (sinks[sessionId]?.compactMap(\.sink) ?? []) + (taps[sessionId]?.compactMap(\.sink) ?? [])
  }

  // MARK: Taps (additive)
  //
  // A tap is a second consumer of a session's access units that is not a decoder: the watcher relay
  // host forwards the camera's encoded AUs to watchers from here, so frames never cross JS. Taps are
  // held weakly like sinks; the datalink reaches them through `sinks(for:)` unchanged.

  private var taps: [String: [WeakSink]] = [:]

  public func addTap(_ tap: PocketVideoSink, for sessionId: String) {
    lock.lock(); defer { lock.unlock() }
    var list = taps[sessionId, default: []].filter { $0.sink != nil }
    if !list.contains(where: { $0.sink === tap }) { list.append(WeakSink(sink: tap)) }
    taps[sessionId] = list
  }

  public func removeTap(_ tap: PocketVideoSink, for sessionId: String) {
    lock.lock(); defer { lock.unlock() }
    taps[sessionId] = taps[sessionId]?.filter { $0.sink != nil && $0.sink !== tap }
  }

  /// Producer side for sources other than the datalink (the relay watcher): one AU to every
  /// consumer of `sessionId`, on the caller's queue.
  public func publish(accessUnit: Data, codec: PocketVideoCodec, presentationTimeUs: Int64, to sessionId: String) {
    for sink in sinks(for: sessionId) {
      sink.receive(accessUnit: accessUnit, codec: codec, presentationTimeUs: presentationTimeUs)
    }
  }

  /// Producer side: the stream restarted (flush references, wait for a keyframe).
  public func reset(sessionId: String) {
    for sink in sinks(for: sessionId) { sink.reset() }
  }
}
