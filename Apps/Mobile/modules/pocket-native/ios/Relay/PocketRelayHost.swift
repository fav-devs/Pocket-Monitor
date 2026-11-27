import CoreVideo
import Foundation
import Network
import os

/// Host status as JS sees it (`RelayHostStatusEvent`).
struct PocketRelayHostStatus: Equatable {
  var state = "stopped"
  var error: String?
  var watchers = 0
  var pendingName: String?
  var pendingWatcherId: String?
  var holder = "Host"
  var joinable = false
  var watcherNames: [String] = []
  /// "reencode": the phone's HEVC encode (keyframes on demand); "forward": no hardware encoder, the
  /// camera's own access units are forwarded and a joiner may wait for a camera keyframe.
  var video = "reencode"
}

/// The sharing host (docs/watcher-relay.md "Ownership and bounds"). Twin of
/// android/.../relay/RelayHost.kt:
///
/// - Phone-as-encoder: the Pocket sends no regular keyframes and keyframe requests belong to the
///   watchdog, so the host re-encodes the decoded picture (`PocketRelayEncoder`, hardware HEVC, a
///   keyframe at least every 2 s) and a joiner gets a forced keyframe within a second. Frames never
///   cross JS: the decoder's frame tap (the same tap Picture in Picture uses) calls `submit`.
/// - Decoder lifetime: while sharing runs the host holds the camera's `PocketVideoSession` in
///   `PocketVideoSessionHub`, so decoding (and its reference chain) survives the picture view
///   unmounting. The frame tap and the VideoToolbox session exist only while at least one watcher is
///   authorized; the last watcher leaving tears the encoder down.
/// - Admission: at most two source frames are retained before dispatch, including queued encode work,
///   VideoToolbox output and fan-out. A busy encoder skips input; nothing is encoded while no watcher
///   can take a frame.
/// - Each authorized watcher has `window` video sends in flight; a watcher whose window is full skips
///   that frame and waits for a keyframe (others keep receiving). Hello, state and tokens do not use
///   that window; at most one state send is outstanding per watcher and newer states replace it.
/// - Bitrate: `PocketRelayBitrate` (10 → 7 → 4.5 → 3 Mb/s), sampled at 5 Hz on `q`.
/// - Fallback (`video == .forward`, no hardware HEVC encoder): a tap in `PocketVideoSinkRegistry`
///   forwards the camera's own access units and the host keeps the current camera GOP for joiners;
///   past its bound a joiner waits for the camera's next keyframe. The host never asks the camera for
///   one (no `0x09/0xa8`, no ACK pump involvement) in either mode.
/// - Refusals and an explicit stop are flushed before the socket closes (three-second bound).
/// - Control: one holder; a request waits for the operator's Grant / Deny (JS); a dropped holder with
///   a watcher id is parked for 20 s and restored when it returns.
///
/// Threading: the serial queue `q` owns every mutable field; socket callbacks run on it.
final class PocketRelayHost: PocketVideoSink {
  struct Options {
    var cameraSessionId: String
    var hostName: String
    var cameraName: String
    var passcode: String
    var allowsControl: Bool
    var window: Int
  }

  var onStatus: ((PocketRelayHostStatus) -> Void)?
  var onCommand: ((_ json: String, _ watcherId: String) -> Void)?

  private let q = DispatchQueue(label: "pocket.relay.host", qos: .userInitiated)
  private let log = Logger(subsystem: "com.favdevs.pocketmonitor", category: "relay")

  enum Video: String {
    case reencode
    case forward
  }

  private static let maxPeers = 16
  /// Source frames retained before dispatch (upstream `RelayBroadcastStages` encoding depth).
  private static let admissionDepth = 2
  private static let tickSeconds = 0.2
  private static let parkSeconds: TimeInterval = 20
  private static let closeSeconds: TimeInterval = 3
  /// The GOP a joiner can start from. Past this the host waits for the camera's next keyframe.
  private static let gopBytes = 48 * 1024 * 1024
  private static let gopUnits = 3000
  /// Frames kept behind live for watchers mid catch-up once the GOP is past its bound.
  private static let tailUnits: Int64 = 120

  private struct Unit {
    let index: Int64
    let au: Data
    let codec: PocketVideoCodec
    let key: Bool
    let sets: [Data]?
    let at: TimeInterval
  }

  private final class Peer {
    let id: Int
    let connection: NWConnection
    var reader = PocketRelayWire.Reader(maxPayload: PocketRelayWire.maxWatcherPayload)
    var authorized = false
    var closing = false
    var name = "Watcher"
    var watcherId: String?
    /// Re-encode: skips frames until the next keyframe (a joiner, or after a full send window).
    var needsKey = true
    /// Forward: absolute GOP index of the next frame to send; -1 waits for a keyframe.
    var cursor: Int64 = -1
    var inFlight = 0
    var stateInFlight = false
    var pendingState: Data?
    init(id: Int, connection: NWConnection) {
      self.id = id
      self.connection = connection
    }
  }

  // q-confined
  private var options: Options?
  private var listener: NWListener?
  private var advertisedName = ""
  private var running = false
  private var generation = 0
  private var status = PocketRelayHostStatus()
  private var lastPublished: PocketRelayHostStatus?
  private var peers: [Int: Peer] = [:]
  private var nextPeer = 1
  private var holder: Peer?
  private var pending: Peer?
  private var parked: (id: String, name: String, until: TimeInterval)?
  private var latestState: Data?
  private var recording = false
  private var gop: [Unit] = []
  private var gopStart = 0
  private var gopByteCount = 0
  private var nextIndex: Int64 = 0
  private var joinable = false
  private var parameterSets: [Data] = []
  private var counters = (sent: 0, skipped: 0, keys: 0)
  private var metricsAt = PocketRelayWire.now()
  private var video: Video = .reencode
  /// Held while sharing runs (re-encode): keeps the camera decoder alive without a picture view.
  private var videoSession: PocketVideoSession?
  private var frameTap: UUID?
  private var encoder: PocketRelayEncoder?
  private var bitrate = PocketRelayBitrate(now: PocketRelayWire.now())
  private var ticker: DispatchSourceTimer?
  private var fpsWindow = (frames: 0, since: PocketRelayWire.now())
  private var measuredFPS: Double?
  private var baselineFPS: Double?
  private var encodeFailures = 0

  // Admission, behind `admissionLock` (the decoder thread admits before any queue hop).
  private let admissionLock = NSLock()
  private var admitted = 0
  private var admissionGeneration = 0
  private var framesIn = 0

  // MARK: Lifecycle (any thread)

  func start(_ next: Options, completion: @escaping (Error?) -> Void) {
    q.async { [self] in
      stopLocked(reason: nil)
      options = next
      running = true
      generation += 1
      openAdmission(generation)
      status.error = nil
      video = PocketRelayEncoder.isAvailable ? .reencode : .forward
      status.video = video.rawValue
      joinable = video == .reencode
      setState("starting")
      let gen = generation
      do {
        let listener = try NWListener(using: PocketRelayWire.parameters())
        var txt = NWTXTRecord()
        txt[PocketRelayWire.txtCamera] = next.cameraName
        txt[PocketRelayWire.txtWatchable] = "1"
        listener.service = NWListener.Service(
          name: next.hostName.isEmpty ? nil : next.hostName, type: PocketRelayWire.serviceType, domain: nil, txtRecord: txt)
        listener.serviceRegistrationUpdateHandler = { [weak self] change in
          guard let self, self.generation == gen else { return }
          if case .add(let endpoint) = change, case .service(let name, _, _, _) = endpoint { self.advertisedName = name }
        }
        listener.newConnectionHandler = { [weak self] connection in
          guard let self, self.generation == gen, self.running else {
            connection.cancel()
            return
          }
          self.accept(connection)
        }
        listener.stateUpdateHandler = { [weak self] state in
          guard let self, self.generation == gen else { return }
          switch state {
          case .ready:
            self.setState("advertising")
          case .failed(let error):
            self.status.error = "Sharing could not start (\(error.localizedDescription))"
            self.setState("failed")
            self.stopLocked(reason: nil)
          default:
            break
          }
        }
        self.listener = listener
        switch video {
        case .reencode:
          encoder = PocketRelayEncoder()
          bitrate = PocketRelayBitrate(now: PocketRelayWire.now())
          videoSession = PocketVideoSessionHub.shared.acquire(next.cameraSessionId)
        case .forward:
          PocketVideoSinkRegistry.shared.addTap(self, for: next.cameraSessionId)
        }
        listener.start(queue: q)
        log.info("relay: listening \(PocketRelayWire.serviceType, privacy: .public) video=\(self.video.rawValue, privacy: .public)")
        completion(nil)
      } catch {
        status.error = "Sharing could not start"
        setState("failed")
        stopLocked(reason: nil)
        completion(error)
      }
    }
  }

  func stop(reason: String?) {
    q.async { [self] in stopLocked(reason: reason) }
  }

  func update(passcode: String, allowsControl: Bool, window: Int) {
    q.async { [self] in
      guard var o = options else { return }
      o.passcode = passcode.trimmingCharacters(in: .whitespacesAndNewlines)
      o.allowsControl = allowsControl
      o.window = min(8, max(1, window))
      options = o
      if !allowsControl { pending = nil }
      publishStatus()
      for peer in peers.values { pump(peer) }
    }
  }

  func publishState(_ json: String) {
    let bytes = Data(json.utf8)
    let rec = (PocketRelayWire.jsonObject(bytes)?["isRecording"] as? Bool) ?? false
    q.async { [self] in
      guard running else { return }
      latestState = bytes
      recording = rec
      for peer in peers.values where peer.authorized && !peer.closing { sendState(peer, bytes) }
      logMetrics()
    }
  }

  func grantControl() {
    q.async { [self] in
      guard let p = pending else { return }
      pending = nil
      let identified = !(p.watcherId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      holder = peers[p.id] === p && p.authorized && identified ? p : nil
      parked = nil
      broadcastTokens()
      publishStatus()
    }
  }

  func denyControl() {
    q.async { [self] in
      pending = nil
      publishStatus()
    }
  }

  func reclaimControl() {
    q.async { [self] in
      holder = nil
      parked = nil
      broadcastTokens()
      publishStatus()
    }
  }

  private func stopLocked(reason: String?) {
    if let o = options { PocketVideoSinkRegistry.shared.removeTap(self, for: o.cameraSessionId) }
    closeAdmission()
    stopEncoding()
    if let videoSession { PocketVideoSessionHub.shared.release(videoSession) }
    videoSession = nil
    encoder = nil
    listener?.cancel()
    listener = nil
    for peer in Array(peers.values) {
      if let reason, peer.authorized { closeWithDenial(peer, reason: reason, passcodeRequired: false) } else { drop(peer) }
    }
    holder = nil
    pending = nil
    parked = nil
    latestState = nil
    clearGop()
    joinable = false
    if running {
      running = false
      generation += 1
      if status.state != "failed" { setState("stopped") }
    }
    options = nil
  }

  // MARK: Sockets (q)

  private func accept(_ connection: NWConnection) {
    guard peers.count < Self.maxPeers else {
      connection.cancel()
      return
    }
    let peer = Peer(id: nextPeer, connection: connection)
    nextPeer += 1
    peers[peer.id] = peer
    connection.stateUpdateHandler = { [weak self, weak peer] state in
      guard let self, let peer, self.peers[peer.id] === peer else { return }
      switch state {
      case .failed, .cancelled: self.drop(peer)
      default: break
      }
    }
    receive(peer)
    connection.start(queue: q)
    // An unauthenticated peer that never says hello is dropped.
    q.asyncAfter(deadline: .now() + 15) { [weak self, weak peer] in
      guard let self, let peer, self.peers[peer.id] === peer, !peer.authorized, !peer.closing else { return }
      self.drop(peer)
    }
  }

  private func receive(_ peer: Peer) {
    peer.connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self, weak peer] data, _, complete, error in
      guard let self, let peer, self.peers[peer.id] === peer, !peer.closing else { return }
      do {
        for message in try peer.reader.append(data ?? Data()) {
          guard self.peers[peer.id] === peer, !peer.closing else { return }
          self.handle(peer, kind: message.kind, payload: message.payload)
        }
      } catch {
        self.drop(peer)
        return
      }
      if complete || error != nil {
        self.drop(peer)
      } else if self.peers[peer.id] === peer, !peer.closing {
        self.receive(peer)
      }
    }
  }

  private func send(_ peer: Peer, _ data: Data, completion: (() -> Void)? = nil) {
    peer.connection.send(content: data, completion: .contentProcessed { [weak self, weak peer] error in
      guard let self, let peer, self.peers[peer.id] === peer else { return }
      if error != nil {
        self.drop(peer)
        return
      }
      completion?()
    })
  }

  private func drop(_ peer: Peer) {
    guard peers.removeValue(forKey: peer.id) === peer else { return }
    peer.closing = true
    peer.connection.cancel()
    if pending === peer { pending = nil }
    updateEncoding()
    if holder === peer {
      holder = nil
      if let id = peer.watcherId, !id.isEmpty {
        parked = (id, peer.name, PocketRelayWire.now() + Self.parkSeconds)
      }
    }
    broadcastTokens()
    publishStatus()
  }

  private func closeWithDenial(_ peer: Peer, reason: String, passcodeRequired: Bool) {
    guard !peer.closing else { return }
    let finish = { [weak self, weak peer] in
      guard let self, let peer, self.peers[peer.id] === peer else { return }
      peer.closing = false
      self.drop(peer)
    }
    send(peer, PocketRelayWire.message(.joinDenied, json: PocketRelayWire.denied(reason, passcodeRequired: passcodeRequired)), completion: finish)
    peer.closing = true
    q.asyncAfter(deadline: .now() + Self.closeSeconds, execute: finish)
  }

  // MARK: Messages (q)

  private func handle(_ peer: Peer, kind: PocketRelayWire.Kind, payload: Data) {
    guard let o = options else { return }
    switch kind {
    case .hello:
      guard !peer.authorized else { return }
      guard let hello = PocketRelayWire.jsonObject(payload), let version = (hello["version"] as? NSNumber)?.intValue,
        hello["hostName"] is String
      else {
        drop(peer)
        return
      }
      guard version == PocketRelayWire.version else {
        closeWithDenial(peer, reason: PocketRelayWire.versionMismatch, passcodeRequired: false)
        return
      }
      let need = o.passcode.trimmingCharacters(in: .whitespacesAndNewlines)
      if !need.isEmpty, (hello["passcode"] as? String) != need {
        log.info("relay host: passcode refused")
        closeWithDenial(peer, reason: PocketRelayWire.wrongPasscode, passcodeRequired: true)
        return
      }
      peer.authorized = true
      let name = (hello["hostName"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      peer.name = name.isEmpty ? "Watcher" : name
      let id = (hello["watcherID"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      peer.watcherId = id.isEmpty ? nil : id
      send(peer, PocketRelayWire.message(.hello, json: PocketRelayWire.hello(hostName: advertisedName.isEmpty ? o.hostName : advertisedName, cameraName: o.cameraName)))
      if let latestState { sendState(peer, latestState) }
      if let parked, let id = peer.watcherId, parked.id == id, PocketRelayWire.now() < parked.until {
        holder = peer
        self.parked = nil
        broadcastTokens()
      } else {
        sendToken(peer)
      }
      peer.needsKey = true
      peer.cursor = video == .forward && joinable && gopStart < gop.count ? gop[gopStart].index : -1
      updateEncoding()
      pump(peer)
      log.info("relay host: watcher joined (\(self.peers.values.filter(\.authorized).count))")
      publishStatus()
    case .requestControl:
      guard peer.authorized, o.allowsControl, holder !== peer, pending == nil else { return }
      pending = peer
      publishStatus()
    case .releaseControl:
      guard holder === peer else { return }
      holder = nil
      broadcastTokens()
      publishStatus()
    case .command:
      guard holder === peer, peer.authorized else { return }
      onCommand?(String(decoding: payload, as: UTF8.self), peer.watcherId ?? "")
    default:
      break
    }
  }

  private func sendToken(_ peer: Peer) {
    guard peer.authorized, !peer.closing else { return }
    send(peer, PocketRelayWire.message(.controlToken, json: PocketRelayWire.token(holderName: holder?.name ?? "Host", recipient: holder === peer)))
  }

  private func broadcastTokens() {
    for peer in peers.values { sendToken(peer) }
  }

  private func sendState(_ peer: Peer, _ bytes: Data) {
    if peer.stateInFlight {
      peer.pendingState = bytes
      return
    }
    peer.stateInFlight = true
    send(peer, PocketRelayWire.message(.state, bytes)) { [weak self, weak peer] in
      guard let self, let peer else { return }
      peer.stateInFlight = false
      let next = peer.pendingState
      peer.pendingState = nil
      if let next, peer.authorized, !peer.closing { self.sendState(peer, next) }
    }
  }

  // MARK: Video tap (datalink video queue → q)

  func receive(accessUnit: Data, codec: PocketVideoCodec, presentationTimeUs: Int64) {
    let at = PocketRelayWire.now()
    q.async { [self] in
      guard running, video == .forward else { return }
      ingest(accessUnit, codec: codec, at: at)
    }
  }

  func reset() {
    q.async { [self] in
      guard video == .forward else { return }
      clearGop()
      if joinable {
        joinable = false
        publishStatus()
      }
      for peer in peers.values { peer.cursor = -1 }
    }
  }

  private func clearGop() {
    gop.removeAll(keepingCapacity: true)
    gopStart = 0
    gopByteCount = 0
  }

  private func ingest(_ au: Data, codec: PocketVideoCodec, at: TimeInterval) {
    let c = PocketRelayWire.classify(au, codec: codec)
    if !c.parameterSets.isEmpty { parameterSets = c.parameterSets }
    let unit: Unit
    if c.keyframe {
      let data = c.parameterSets.isEmpty && !parameterSets.isEmpty ? PocketRelayWire.prefixed(parameterSets, au) : au
      clearGop()
      unit = Unit(index: nextIndex, au: data, codec: codec, key: true, sets: parameterSets.isEmpty ? nil : parameterSets, at: at)
      nextIndex += 1
      counters.keys += 1
      let was = joinable
      joinable = true
      for peer in peers.values where peer.authorized { peer.cursor = unit.index }
      if !was { publishStatus() }
    } else {
      // Nothing to decode from until the first keyframe.
      guard gopStart < gop.count else { return }
      unit = Unit(index: nextIndex, au: au, codec: codec, key: false, sets: nil, at: at)
      nextIndex += 1
    }
    gop.append(unit)
    gopByteCount += unit.au.count
    if joinable, gopByteCount > Self.gopBytes || gop.count - gopStart > Self.gopUnits {
      joinable = false
      publishStatus()
    }
    if !joinable { trimGop() }
    for peer in peers.values { pump(peer) }
  }

  /// Past the bound only frames a watcher still needs are kept; one too far behind waits for a keyframe.
  private func trimGop() {
    guard let last = gop.last else { return }
    if gopByteCount > Self.gopBytes * 2 {
      let keepFrom = last.index - Self.tailUnits
      for peer in peers.values where peer.authorized && peer.cursor >= 0 && peer.cursor < keepFrom {
        peer.cursor = -1
        counters.skipped += 1
      }
    }
    let minimum = peers.values.filter { $0.authorized && $0.cursor >= 0 }.map(\.cursor).min() ?? last.index
    while gop.count - gopStart > 1, gop[gopStart].index < minimum {
      gopByteCount -= gop[gopStart].au.count
      gopStart += 1
    }
    if gopStart > 256, gopStart * 2 > gop.count {
      gop.removeFirst(gopStart)
      gopStart = 0
    }
  }

  private func unit(at index: Int64) -> Unit? {
    guard gopStart < gop.count else { return nil }
    let offset = Int(index - gop[gopStart].index)
    guard offset >= 0, gopStart + offset < gop.count else { return nil }
    return gop[gopStart + offset]
  }

  private func pump(_ peer: Peer) {
    guard video == .forward, let o = options, peer.authorized, !peer.closing else { return }
    while peer.cursor >= 0, peer.inFlight < o.window, let unit = unit(at: peer.cursor) {
      let behind = (nextIndex - 1 - unit.index) > Int64(o.window)
      var wire = PocketRelayWire.frameHead(
        codec: unit.codec, keyframe: unit.key, parameterSets: unit.sets, recording: recording, mirrored: false,
        encodedAt: unit.at, catchUp: behind, accessUnitLength: unit.au.count)
      wire.append(unit.au)
      peer.cursor += 1
      peer.inFlight += 1
      counters.sent += 1
      send(peer, wire) { [weak self, weak peer] in
        guard let self, let peer else { return }
        peer.inFlight = max(0, peer.inFlight - 1)
        self.pump(peer)
      }
    }
  }

  // MARK: Status (q)

  private func setState(_ next: String) {
    status.state = next
    publishStatus()
  }

  private func publishStatus() {
    status.watchers = peers.values.filter { $0.authorized && !$0.closing }.count
    status.pendingName = pending?.name
    status.pendingWatcherId = pending.map { $0.watcherId ?? "" }
    status.holder = holder?.name ?? "Host"
    status.joinable = joinable
    status.watcherNames = peers.values.filter { $0.authorized && !$0.closing }.sorted { $0.id < $1.id }.map(\.name)
    status.video = video.rawValue
    guard status != lastPublished else { return }
    lastPublished = status
    onStatus?(status)
  }

  /// Console counters every five seconds (docs/watcher-relay.md); no peer names or codes.
  private func logMetrics() {
    let now = PocketRelayWire.now()
    guard now - metricsAt >= 5 else { return }
    metricsAt = now
    let authorized = peers.values.filter(\.authorized).count
    guard authorized > 0 else {
      counters = (0, 0, 0)
      return
    }
    if video == .reencode {
      log.info(
        "relay: peers=\(authorized) bps=\(self.bitrate.bitsPerSecond) sent=\(self.counters.sent) skipped=\(self.counters.skipped) keys=\(self.counters.keys) cameraFPS=\(self.measuredFPS ?? 0, format: .fixed(precision: 1)) failures=\(self.encodeFailures)"
      )
      encodeFailures = 0
    } else {
      log.info(
        "relay: peers=\(authorized) sent=\(self.counters.sent) skipped=\(self.counters.skipped) keys=\(self.counters.keys) gop=\(self.gop.count - self.gopStart) (forwarding)"
      )
    }
    counters = (0, 0, 0)
  }

  // MARK: Re-encode (q unless noted)

  private var authorizedCount: Int { peers.values.filter { $0.authorized && !$0.closing }.count }

  private func ready(_ peer: Peer) -> Bool {
    guard let o = options else { return false }
    return peer.authorized && !peer.closing && peer.inFlight < o.window
  }

  /// Frame tap and encoder while at least one watcher is authorized; torn down at zero.
  private func updateEncoding() {
    guard running, video == .reencode, let videoSession else { return }
    let wanted = authorizedCount > 0
    if wanted, frameTap == nil {
      let gen = generation
      frameTap = videoSession.addFrameTap { [weak self] buffer in self?.submit(buffer, generation: gen) }
      baselineFPS = nil
      measuredFPS = nil
      fpsWindow = (0, PocketRelayWire.now())
      startTicker()
      log.info("relay: encoder on")
    } else if !wanted, frameTap != nil {
      stopEncoding()
      log.info("relay: encoder off (no watchers)")
    }
  }

  private func stopEncoding() {
    if let frameTap, let videoSession { videoSession.removeFrameTap(frameTap) }
    frameTap = nil
    ticker?.cancel()
    ticker = nil
    encoder?.invalidate()
  }

  private func openAdmission(_ gen: Int) {
    admissionLock.lock()
    admissionGeneration = gen
    admitted = 0
    framesIn = 0
    admissionLock.unlock()
  }

  private func closeAdmission() {
    admissionLock.lock()
    admissionGeneration = -1
    admitted = 0
    admissionLock.unlock()
  }

  private func releaseAdmission(_ gen: Int) {
    admissionLock.lock()
    if admissionGeneration == gen { admitted = max(0, admitted - 1) }
    admissionLock.unlock()
  }

  /// Decoder thread (frame tap); must not block. Admits before the queue hop.
  private func submit(_ buffer: CVPixelBuffer, generation gen: Int) {
    admissionLock.lock()
    framesIn += 1
    guard admissionGeneration == gen, admitted < Self.admissionDepth else {
      admissionLock.unlock()
      return
    }
    admitted += 1
    admissionLock.unlock()
    q.async { [self] in
      guard running, generation == gen, let encoder, peers.values.contains(where: ready) else {
        releaseAdmission(gen)
        return
      }
      let key = peers.values.contains { $0.needsKey && ready($0) }
      encoder.encode(buffer, forceKey: key) { [weak self] output, failed in
        guard let self else { return }
        self.q.async {
          defer { self.releaseAdmission(gen) }
          guard self.running, self.generation == gen else { return }
          if let output { self.broadcast(output) } else if failed { self.encodeFailures += 1 }
        }
      }
    }
  }

  private func broadcast(_ frame: PocketRelayEncoder.Output) {
    guard let o = options else { return }
    if frame.key { counters.keys += 1 }
    var wire = PocketRelayWire.frameHead(
      codec: .hevc, keyframe: frame.key, parameterSets: frame.sets, recording: recording, mirrored: false,
      encodedAt: PocketRelayWire.now(), catchUp: false, accessUnitLength: frame.data.count)
    wire.append(frame.data)
    for peer in peers.values where peer.authorized && !peer.closing {
      guard peer.inFlight < o.window else {
        // Dropping after encode breaks this watcher's reference chain: it resumes at a keyframe.
        peer.needsKey = true
        counters.skipped += 1
        continue
      }
      if peer.needsKey && !frame.key { continue }
      peer.needsKey = false
      peer.inFlight += 1
      counters.sent += 1
      send(peer, wire) { [weak peer] in
        guard let peer else { return }
        peer.inFlight = max(0, peer.inFlight - 1)
      }
    }
  }

  private func startTicker() {
    guard ticker == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: q)
    timer.schedule(deadline: .now() + Self.tickSeconds, repeating: Self.tickSeconds, leeway: .milliseconds(20))
    timer.setEventHandler { [weak self] in self?.tick() }
    ticker = timer
    timer.resume()
  }

  /// 5 Hz: camera delivery rate (decoded frames reaching the tap), saturation, bitrate, counters.
  private func tick() {
    guard running, video == .reencode else { return }
    let now = PocketRelayWire.now()
    admissionLock.lock()
    let frames = framesIn
    framesIn = 0
    admissionLock.unlock()
    fpsWindow.frames += frames
    let elapsed = now - fpsWindow.since
    if elapsed >= 1 {
      let fps = Double(fpsWindow.frames) / elapsed
      measuredFPS = fps
      if fps > 0 { baselineFPS = max(baselineFPS ?? fps, fps) }
      fpsWindow = (0, now)
    }
    let starving: Bool
    if let measuredFPS, measuredFPS > 0 {
      starving = measuredFPS < (baselineFPS ?? measuredFPS) * PocketRelayBitrate.starvationFraction
    } else {
      starving = baselineFPS != nil
    }
    let authorized = peers.values.filter { $0.authorized && !$0.closing }
    let saturated = !authorized.isEmpty && !authorized.contains(where: ready)
    if let bps = bitrate.tick(saturated: saturated, cameraStarving: starving, now: now) {
      encoder?.setBitrate(bps)
      log.info("relay: bitrate \(bps)")
    }
    logMetrics()
  }
}
