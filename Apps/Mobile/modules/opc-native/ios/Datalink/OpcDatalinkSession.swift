import Foundation
import Network
import os

/// What a session hands its owner. Called on the session's datalink queue.
protocol OpcDatalinkSessionDelegate: AnyObject {
  func datalinkSession(_ session: OpcDatalinkSession, didReceiveDuml frame: Data)
  func datalinkSession(_ session: OpcDatalinkSession, didChangeState state: String, error: String?)
  func datalinkSession(_ session: OpcDatalinkSession, didReport stats: OpcDatalinkSession.Stats)
}

/// One camera datalink: UDP to `host:9004` pinned to the camera Wi-Fi, the 40 Hz window-ACK pump,
/// DUML command wrapping, inbound frame scanning and video reassembly.
///
/// Threading: every piece of mutable state lives on `q` (a private serial queue at
/// `.userInteractive`, never the main or JS thread). Receive, every UDP write (ACK, commands, raw)
/// and the ACK timer run there, so writes serialize exactly like upstream `DjiAppleDatalink.q`.
/// Complete access units hop to `videoQ` before reaching `OpcVideoSinkRegistry` sinks, so a slow
/// decoder can never delay a window ACK.
///
/// Sequencing split with JS (`src/core/transport/datalink.ts` `DatalinkSequencer`):
/// - JS builds the handshake (`sendRaw`). Native sniffs it for session id, seq and `baseSeq`,
///   then reseeds the command seq from the admitted 34-byte initial window.
/// - JS stamps the DUML seq inside each frame (it needs it to match replies). Native only adds the
///   transport + routing headers (session id, udpSeq += 8, cmdCounter += 1).
/// - Native never sends `0x09/0xa8` (or any command) on its own; only window ACKs.
final class OpcDatalinkSession: @unchecked Sendable {
  struct Options {
    var host: String
    var port: UInt16
    var localPort: UInt16
    var ackHz: Double
    var tcpPokePort: UInt16?
    var tcpPokeBytes: Data?
  }

  struct Stats {
    var rxPackets: Int
    var txPackets: Int
    var rxBytesPerSec: Double
    var videoPacketsPerSec: Double
    var ackHz: Double
    var lastRxAgeMs: Double
  }

  enum OpenError: LocalizedError {
    case closed
    case pathNotReady
    case localNetworkDenied
    case notReady(String)

    var errorDescription: String? {
      switch self {
      case .closed: return "datalink closed while opening"
      case .pathNotReady: return "camera Wi-Fi path not ready (no 192.168.2.x address)"
      case .localNetworkDenied:
        return "Local Network access is denied. Enable Local Network access in Settings, then try again."
      case .notReady(let why): return "UDP socket never became ready (\(why))"
      }
    }
  }

  private enum BindMode {
    case bound(ip: String, interface: NWInterface?)
    case interface(NWInterface)
    case wifiType

    var label: String {
      switch self {
      case .bound: return "bound"
      case .interface: return "interface"
      case .wifiType: return "wifi-type"
      }
    }
  }

  let id: String
  private let options: Options
  private let q: DispatchQueue
  private let videoQ: DispatchQueue
  private let log = Logger(subsystem: "opc-native", category: "datalink")
  weak var delegate: OpcDatalinkSessionDelegate?

  // ---- state below is touched on `q` only ----
  private var conn: NWConnection?
  private var connReady = false
  private var poke: NWConnection?
  private var ackTimer: DispatchSourceTimer?
  private var statsTimer: DispatchSourceTimer?
  private var closed = false
  private var state = ""
  private var cameraLocalIPv4: String?
  private var cameraInterface: NWInterface?

  private var handshake: OpcDumlWire.HandshakeInfo?
  private var admission = OpcHandshakeAdmission()
  private var admitted = false
  private var udpSeq: UInt16 = 0
  private var cmdCounter: UInt8 = 0
  private var windows = OpcAckWindows()

  private var videoAccepting = false
  private var videoCodec: OpcVideoCodec?
  private var assembler = OpcVideoAssembler()

  private var rxPackets = 0
  private var txPackets = 0
  private var droppedCommands = 0
  private var sendErrors = 0
  private var rxBytesWindow = 0
  private var videoWindow = 0
  private var acksWindow = 0
  private var windowStart: UInt64 = 0
  private var openedAt: UInt64 = 0
  private var lastRxAt: UInt64?

  init(id: String, options: Options) {
    self.id = id
    var o = options
    // Binding local :9004 kept 0x01 and dropped every 0x02 on Samsung; Mimo uses an ephemeral port.
    if o.localPort == 9004 { o.localPort = 0 }
    if !(o.ackHz > 0 && o.ackHz <= 200) { o.ackHz = 40 }
    self.options = o
    self.q = DispatchQueue(label: "opc.datalink.\(id)", qos: .userInteractive)
    self.videoQ = DispatchQueue(label: "opc.datalink.video.\(id)", qos: .userInitiated)
  }

  @inline(__always) private static func now() -> UInt64 { DispatchTime.now().uptimeNanoseconds }

  // MARK: - Open

  func open(completion: @escaping @Sendable (Error?) -> Void) {
    q.async {
      self.openedAt = Self.now()
      self.windowStart = self.openedAt
      self.setState("opening")
      let isSoftAP = self.options.host.hasPrefix("192.168.2.")
      let deadline = Self.now() + 8_000_000_000
      self.waitForPath(isSoftAP: isSoftAP, deadline: deadline) { ok in
        guard !self.closed else { return completion(OpenError.closed) }
        guard ok else {
          self.setState("failed", error: OpenError.pathNotReady.localizedDescription)
          return completion(OpenError.pathNotReady)
        }
        self.resolveInterface {
          self.openPoke(attempt: 1) {
            self.openUDP(modes: self.bindModes(), lastError: nil) { error in
              if let error {
                self.setState("failed", error: error.localizedDescription)
              }
              completion(error)
            }
          }
        }
      }
    }
  }

  /// Sockets created before 192.168.2.x exists bind to the old Wi-Fi and then RST (first-connect
  /// black feed). Wait for DHCP on the SoftAP; station hosts only need some address on their /24.
  private func waitForPath(isSoftAP: Bool, deadline: UInt64, done: @escaping @Sendable (Bool) -> Void) {
    if closed { return done(false) }
    let address: OpcNetworkInterfaces.Address? =
      isSoftAP ? OpcNetworkInterfaces.cameraAddress() : OpcNetworkInterfaces.address(sameSubnetAs: options.host)
    if let address {
      cameraLocalIPv4 = address.ipv4
      return done(true)
    }
    if OpcNetworkInterfaces.isSimulator || !isSoftAP { return done(true) }
    guard Self.now() < deadline else { return done(false) }
    q.asyncAfter(deadline: .now() + .milliseconds(150)) {
      self.waitForPath(isSoftAP: isSoftAP, deadline: deadline, done: done)
    }
  }

  /// `requiredInterfaceType = .wifi` alone scopes the flow to the default Wi-Fi; resolve the
  /// interface that owns the camera address and pin it.
  private func resolveInterface(done: @escaping @Sendable () -> Void) {
    guard let ip = cameraLocalIPv4,
      let name = OpcNetworkInterfaces.ipv4Addresses().first(where: { $0.ipv4 == ip })?.name
    else { return done() }
    let monitor = NWPathMonitor(requiredInterfaceType: .wifi)
    let once = OpcOnce()
    let finish: @Sendable (NWInterface?) -> Void = { [weak self] iface in
      guard once.claim() else { return }
      monitor.cancel()
      self?.cameraInterface = iface
      done()
    }
    monitor.pathUpdateHandler = { path in
      finish(path.availableInterfaces.first { $0.name == name })
    }
    monitor.start(queue: q)
    q.asyncAfter(deadline: .now() + .milliseconds(600)) { finish(nil) }
  }

  private func bindModes() -> [BindMode] {
    var modes: [BindMode] = []
    if let ip = cameraLocalIPv4, !OpcNetworkInterfaces.isSimulator {
      modes.append(.bound(ip: ip, interface: cameraInterface))
    }
    if let iface = cameraInterface { modes.append(.interface(iface)) }
    modes.append(.wifiType)
    return modes
  }

  private func parameters(tcp: Bool, mode: BindMode) -> NWParameters {
    let p: NWParameters = tcp ? .tcp : .udp
    // The SoftAP has no internet: iOS keeps cellular as the default route.
    p.prohibitedInterfaceTypes = [.cellular]
    p.allowLocalEndpointReuse = true
    let localPort = NWEndpoint.Port(rawValue: tcp ? 0 : options.localPort) ?? .any
    switch mode {
    case .bound(let ip, let iface):
      p.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(ip), port: localPort)
      if let iface { p.requiredInterface = iface }
    case .interface(let iface):
      p.requiredInterface = iface
    case .wifiType:
      p.requiredInterfaceType = .wifi
    }
    return p
  }

  private func isLocalNetworkDenied(_ error: NWError?, path: NWPath?) -> Bool {
    if case .dns(let code)? = error, code == -65570 { return true }
    return path?.unsatisfiedReason == .localNetworkDenied
  }

  /// Starts `c` on `q`; `done` fires once with nil on `.ready`.
  private func start(_ c: NWConnection, timeout: TimeInterval, done: @escaping @Sendable (Error?) -> Void) {
    let once = OpcOnce()
    let denied = OpcOnce()
    let finish: @Sendable (Error?) -> Void = { error in
      guard once.claim() else { return }
      done(error)
    }
    c.stateUpdateHandler = { [weak self, weak c] state in
      switch state {
      case .ready: finish(nil)
      case .failed(let e): finish(e)
      case .cancelled: finish(OpenError.closed)
      case .waiting(let e):
        if self?.isLocalNetworkDenied(e, path: c?.currentPath) == true { _ = denied.claim() }
      default: break
      }
    }
    c.start(queue: q)
    q.asyncAfter(deadline: .now() + timeout) { [weak self] in
      let isDenied = denied.isClaimed || (self?.isLocalNetworkDenied(nil, path: c.currentPath) ?? false)
      finish(isDenied ? OpenError.localNetworkDenied : OpenError.notReady("timeout"))
    }
  }

  /// TCP 7001 "poke" (SetPairingPIN bytes built by JS). Mimo keeps it open for the session; the
  /// camera pushes 0x21/0x06 there ~3 Hz, so it is drained. Best effort: UDP proceeds on failure.
  private func openPoke(attempt: Int, done: @escaping @Sendable () -> Void) {
    guard !closed, let port = options.tcpPokePort, let bytes = options.tcpPokeBytes, !bytes.isEmpty,
      let nwPort = NWEndpoint.Port(rawValue: port)
    else { return done() }
    if let poke, case .ready = poke.state { return done() }
    poke?.cancel()
    let mode = bindModes().first ?? .wifiType
    let tcp = NWConnection(
      host: NWEndpoint.Host(options.host), port: nwPort, using: parameters(tcp: true, mode: mode))
    poke = tcp
    start(tcp, timeout: 2) { [weak self] error in
      guard let self else { return }
      if let error {
        self.log.info("datalink: TCP poke attempt \(attempt) failed: \(error.localizedDescription, privacy: .public)")
        tcp.cancel()
        self.poke = nil
        if case .localNetworkDenied? = error as? OpenError { return done() }
        guard attempt < 3 else { return done() }
        self.q.asyncAfter(deadline: .now() + .milliseconds(350)) { self.openPoke(attempt: attempt + 1, done: done) }
        return
      }
      tcp.send(content: bytes, completion: .idempotent)
      Self.drain(tcp)
      // The camera needs a moment after SetPairingPIN before the UDP handshake.
      self.q.asyncAfter(deadline: .now() + .milliseconds(400)) { done() }
    }
  }

  private static func drain(_ tcp: NWConnection) {
    tcp.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { _, _, complete, error in
      guard !complete, error == nil else { return }
      drain(tcp)
    }
  }

  private func openUDP(modes: [BindMode], lastError: Error?, done: @escaping @Sendable (Error?) -> Void) {
    guard !closed else { return done(OpenError.closed) }
    guard let mode = modes.first else { return done(lastError ?? OpenError.notReady("no bind mode")) }
    guard let port = NWEndpoint.Port(rawValue: options.port) else {
      return done(OpenError.notReady("bad port"))
    }
    let c = NWConnection(
      host: NWEndpoint.Host(options.host), port: port, using: parameters(tcp: false, mode: mode))
    start(c, timeout: 4) { [weak self] error in
      guard let self else { return }
      if let error {
        c.cancel()
        self.log.info("datalink: UDP \(mode.label, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        if case .localNetworkDenied? = error as? OpenError { return done(error) }
        if case .closed? = error as? OpenError { return done(error) }
        return self.openUDP(modes: Array(modes.dropFirst()), lastError: error, done: done)
      }
      guard !self.closed else {
        c.cancel()
        return done(OpenError.closed)
      }
      self.log.info("datalink: UDP \(mode.label, privacy: .public) ready \(String(describing: c.currentPath?.localEndpoint), privacy: .public)")
      self.conn = c
      self.connReady = true
      self.installStateWatch(c)
      self.armReceive(c)
      self.startTimers()
      done(nil)
    }
  }

  private func installStateWatch(_ c: NWConnection) {
    c.stateUpdateHandler = { [weak self, weak c] state in
      guard let self, let c, self.conn === c else { return }
      switch state {
      case .ready:
        self.connReady = true
      case .waiting(let e):
        self.connReady = false
        self.log.info("datalink: UDP waiting \(e.debugDescription, privacy: .public)")
      case .failed(let e):
        self.connReady = false
        if !self.closed { self.setState("failed", error: e.localizedDescription) }
      case .cancelled:
        self.connReady = false
      default:
        break
      }
    }
  }

  /// Re-arm BEFORE ingest (ingest-first froze the reader at the first burst), and keep re-arming
  /// after transient errors while the connection lives.
  private func armReceive(_ c: NWConnection) {
    c.receiveMessage { [weak self] data, _, _, error in
      guard let self, self.conn === c, !self.closed else { return }
      if let error {
        switch c.state {
        case .cancelled, .failed: return
        default: break
        }
        self.log.info("datalink: UDP receive error \(error.localizedDescription, privacy: .public), re-arm")
        self.q.asyncAfter(deadline: .now() + .milliseconds(40)) { [weak self] in
          guard let self, self.conn === c else { return }
          self.armReceive(c)
        }
        return
      }
      self.armReceive(c)
      if let data, !data.isEmpty { self.ingest([UInt8](data)) }
    }
  }

  // MARK: - Timers

  private func startTimers() {
    ackTimer?.cancel()
    let period = UInt64((1_000_000_000.0 / options.ackHz).rounded())
    let ack = DispatchSource.makeTimerSource(flags: .strict, queue: q)
    ack.schedule(
      deadline: .now() + .nanoseconds(Int(period)), repeating: .nanoseconds(Int(period)),
      leeway: .microseconds(500))
    ack.setEventHandler { [weak self] in self?.sendWindowAck() }
    ack.resume()
    ackTimer = ack

    statsTimer?.cancel()
    let stats = DispatchSource.makeTimerSource(queue: q)
    stats.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(50))
    stats.setEventHandler { [weak self] in self?.reportStats() }
    stats.resume()
    statsTimer = stats
  }

  /// pktType-0x04, transport seq 0, at `ackHz` (40). Silent until the handshake is admitted:
  /// nothing but the handshake may go out before the session is open.
  private func sendWindowAck() {
    guard admitted, let handshake, connReady, !closed else { return }
    let payload = windows.payload(baseSeq: handshake.baseSeq)
    let pkt =
      OpcDumlWire.transportHeader(
        pktType: OpcDumlWire.PktType.ack, payloadLen: payload.count,
        sessionId: handshake.sessionId, seq: 0) + payload
    write(pkt)
    acksWindow += 1
  }

  private func reportStats() {
    guard !closed else { return }
    let now = Self.now()
    let elapsed = max(0.001, Double(now &- windowStart) / 1e9)
    let lastRxAgeMs = Double(now &- (lastRxAt ?? openedAt)) / 1e6
    if state == "open", lastRxAgeMs > 2_000 {
      setState("stalled", error: "no datagram from the camera for \(Int(lastRxAgeMs)) ms")
    }
    let stats = Stats(
      rxPackets: rxPackets, txPackets: txPackets,
      rxBytesPerSec: Double(rxBytesWindow) / elapsed,
      videoPacketsPerSec: Double(videoWindow) / elapsed,
      ackHz: Double(acksWindow) / elapsed,
      lastRxAgeMs: lastRxAgeMs)
    rxBytesWindow = 0
    videoWindow = 0
    acksWindow = 0
    windowStart = now
    delegate?.datalinkSession(self, didReport: stats)
  }

  // MARK: - TX (called from the JS thread; hop to q)

  func sendRaw(_ bytes: Data) {
    let raw = [UInt8](bytes)
    q.async {
      guard !self.closed else { return }
      if let info = OpcDumlWire.parseOutgoingHandshake(raw) { self.noteOutgoingHandshake(info) }
      self.write(raw)
    }
  }

  /// Wraps one complete DUML frame (seq already stamped by JS) in transport + routing headers.
  func sendDuml(_ frame: Data) {
    let duml = [UInt8](frame)
    q.async {
      guard !self.closed else { return }
      guard self.admitted, let handshake = self.handshake else {
        self.droppedCommands += 1
        if self.droppedCommands == 1 || self.droppedCommands % 50 == 0 {
          self.log.info("datalink: drop DUML before handshake admission (\(self.droppedCommands))")
        }
        return
      }
      self.cmdCounter &+= 1
      let routing = OpcDumlWire.routingHeader(seq: self.udpSeq, cmdCounter: self.cmdCounter)
      let header = OpcDumlWire.transportHeader(
        pktType: OpcDumlWire.PktType.command, payloadLen: routing.count + duml.count,
        sessionId: handshake.sessionId, seq: self.udpSeq)
      self.udpSeq &+= 8
      self.write(header + routing + duml)
    }
  }

  /// A JS handshake with a new session id / baseSeq starts a new admission epoch on this socket.
  private func noteOutgoingHandshake(_ info: OpcDumlWire.HandshakeInfo) {
    let same = handshake.map { $0.sessionId == info.sessionId && $0.baseSeq == info.baseSeq } ?? false
    if same && admitted { return }
    if !same {
      handshake = info
      admission.reset()
      admitted = false
      cmdCounter = 0
      windows = OpcAckWindows()
      // Leftover GOP from the previous session must not be counted or decoded.
      videoAccepting = false
      if videoCodec != nil {
        assembler.reset()
        resetSinks()
      }
    }
    udpSeq = info.seq &+ 8
    setState("handshaking")
  }

  private func write(_ bytes: [UInt8]) {
    guard let conn, connReady else { return }
    txPackets += 1
    conn.send(
      content: Data(bytes),
      completion: .contentProcessed { [weak self] error in
        guard let error, let self else { return }
        if case .posix(let code) = error, code == .ECANCELED { return }
        self.sendErrors += 1
        if self.sendErrors == 1 || self.sendErrors % 100 == 0 {
          self.log.info("datalink: UDP write rejected #\(self.sendErrors) \(error.localizedDescription, privacy: .public)")
        }
      })
  }

  // MARK: - RX (on q)

  private func ingest(_ d: [UInt8]) {
    rxPackets += 1
    rxBytesWindow += d.count
    lastRxAt = Self.now()
    if state == "stalled" { setState("open") }
    guard d.count >= 8 else { return }
    let pkt = d[6]

    if !admitted, handshake != nil {
      admission.receive(d)
      if let initial = admission.initialCommandSequence {
        admitted = true
        udpSeq = initial
        // Arm 0x02 ingest on handshake admission, not on the enable write (Mimo: HEVC at +17 ms).
        videoAccepting = true
        assembler.reset()
        windows.note(d)
        sendWindowAck()
        setState("open")
        if pkt != OpcDumlWire.PktType.video { emitFrames(d) }
        return
      }
    }

    if pkt == OpcDumlWire.PktType.video {
      guard videoAccepting, let seq = OpcDumlWire.transportSeq(d) else { return }
      windows.noteVideo(seq: seq)
      videoWindow += 1
      guard let hint = videoCodec, let out = assembler.ingest(d, hint: hint) else { return }
      let pts = Int64(Self.now() / 1_000)
      let au = Data(out.au)
      let codec = out.codec
      let sessionId = id
      videoQ.async {
        for sink in OpcVideoSinkRegistry.shared.sinks(for: sessionId) {
          sink.receive(accessUnit: au, codec: codec, presentationTimeUs: pts)
        }
      }
      return
    }

    windows.note(d)
    emitFrames(d)
  }

  private func emitFrames(_ d: [UInt8]) {
    for frame in OpcDumlWire.scanFrames(d) {
      delegate?.datalinkSession(self, didReceiveDuml: Data(frame))
    }
  }

  // MARK: - Video routing

  func attachVideo(codec: OpcVideoCodec) {
    q.async {
      self.videoCodec = codec
      self.assembler.reset()
      self.resetSinks()
    }
  }

  func detachVideo() {
    q.async {
      guard self.videoCodec != nil else { return }
      self.videoCodec = nil
      self.assembler.reset()
      self.resetSinks()
    }
  }

  private func resetSinks() {
    let sessionId = id
    videoQ.async {
      for sink in OpcVideoSinkRegistry.shared.sinks(for: sessionId) { sink.reset() }
    }
  }

  // MARK: - Close

  func close(completion: @escaping @Sendable () -> Void) {
    q.async {
      guard !self.closed else { return completion() }
      self.closed = true
      self.ackTimer?.cancel()
      self.ackTimer = nil
      self.statsTimer?.cancel()
      self.statsTimer = nil
      self.conn?.cancel()
      self.conn = nil
      self.connReady = false
      self.poke?.cancel()
      self.poke = nil
      self.admitted = false
      self.videoAccepting = false
      if self.videoCodec != nil {
        self.videoCodec = nil
        self.assembler.reset()
        self.resetSinks()
      }
      self.forceState("closed", error: nil)
      completion()
    }
  }

  // MARK: - State

  private func setState(_ next: String, error: String? = nil) {
    guard !closed, next != state else { return }
    forceState(next, error: error)
  }

  private func forceState(_ next: String, error: String?) {
    state = next
    delegate?.datalinkSession(self, didChangeState: next, error: error)
  }
}

/// A thread-safe one-shot latch for callbacks that may fire more than once (state handler vs.
/// timeout). Avoids captured `var`s inside `@Sendable` Network / Dispatch closures.
final class OpcOnce: @unchecked Sendable {
  private let lock = NSLock()
  private var claimed = false

  /// True for the first caller only.
  func claim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if claimed { return false }
    claimed = true
    return true
  }

  var isClaimed: Bool {
    lock.lock()
    defer { lock.unlock() }
    return claimed
  }
}
