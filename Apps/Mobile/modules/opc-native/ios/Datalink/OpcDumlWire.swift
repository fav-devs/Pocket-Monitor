import Foundation

/// Pure DUML-over-UDP byte math used on the datalink queue. Ported from
/// `Sources/OpenPocketViewCore/DumlTransport.swift` / `DumlFrame.swift` (and the newer upstream
/// forward-only ACK window merge mirrored in `src/core/transport/datalink.ts`).
///
/// Per command packet the wire is `[8B transport hdr][12B routing hdr][DUML frame]`.
enum OpcDumlWire {
  enum PktType {
    static let handshake: UInt8 = 0x00
    static let telemetry: UInt8 = 0x01
    static let video: UInt8 = 0x02
    static let ackedData: UInt8 = 0x03
    static let ack: UInt8 = 0x04
    static let command: UInt8 = 0x05
  }

  @inline(__always)
  static func u16(_ b: [UInt8], _ i: Int) -> UInt16 {
    UInt16(b[i]) | (UInt16(b[i + 1]) << 8)
  }

  /// Transport sequence (bytes 4–5).
  static func transportSeq(_ datagram: [UInt8]) -> UInt16? {
    datagram.count >= 6 ? u16(datagram, 4) : nil
  }

  static func pktType(_ datagram: [UInt8]) -> UInt8? {
    datagram.count >= 8 ? datagram[6] : nil
  }

  /// `[u16le 0x8000|total][u16le session][u16le seq][u8 pktType][u8 xor]`, total = 8 + payloadLen.
  static func transportHeader(pktType: UInt8, payloadLen: Int, sessionId: UInt16, seq: UInt16) -> [UInt8] {
    let total = 8 + payloadLen
    let w0 = 0x8000 | (total & 0x3FFF)
    var b: [UInt8] = [
      UInt8(w0 & 0xFF), UInt8((w0 >> 8) & 0xFF),
      UInt8(sessionId & 0xFF), UInt8((sessionId >> 8) & 0xFF),
      UInt8(seq & 0xFF), UInt8((seq >> 8) & 0xFF),
      pktType,
    ]
    b.append(b.reduce(0, ^))
    return b
  }

  /// 12-byte routing header: `[u16le seq-8][u16le seq][00 00 00 00][u8 counter][01][00][00]`.
  /// Both seq fields are in OUR command-seq space.
  static func routingHeader(seq: UInt16, cmdCounter: UInt8) -> [UInt8] {
    let ack = seq &- 8
    return [
      UInt8(ack & 0xFF), UInt8((ack >> 8) & 0xFF),
      UInt8(seq & 0xFF), UInt8((seq >> 8) & 0xFF),
      0, 0, 0, 0, cmdCounter, 0x01, 0x00, 0x00,
    ]
  }

  /// The 26-byte pktType-0x04 ACK payload: `grp(video) + grp(ackedData) + grp(extra) + [0,0]`.
  static func ackPayload(video: UInt16, ackedData: UInt16, extra: UInt16) -> [UInt8] {
    func grp(_ v: UInt16) -> [UInt8] {
      [UInt8(v & 0xFF), UInt8(v >> 8), UInt8(v & 0xFF), UInt8(v >> 8), 0, 0, 0, 0]
    }
    return grp(video) + grp(ackedData) + grp(extra) + [0, 0]
  }

  /// What a JS-built handshake datagram (`sendRaw`) tells the native sequencer.
  struct HandshakeInfo: Equatable {
    var sessionId: UInt16
    var seq: UInt16
    var baseSeq: UInt16
  }

  /// `handshakeDatagram(sessionId:seq:baseSeq:)` is 8 + 40 bytes, pktType 0x00, payload[0..1] = baseSeq.
  static func parseOutgoingHandshake(_ d: [UInt8]) -> HandshakeInfo? {
    guard d.count >= 10, d[6] == PktType.handshake else { return nil }
    return HandshakeInfo(sessionId: u16(d, 2), seq: u16(d, 4), baseSeq: u16(d, 8))
  }

  /// 34-byte `0x01` initial window → first command seq (`MulticamCommands.controlSequence`).
  static func controlSequence(fromInitialWindow b: [UInt8]) -> UInt16? {
    guard b.count == 34, b[6] == PktType.telemetry else { return nil }
    return u16(b, 8) &+ 8
  }

  /// Forward half of the u16 ring only.
  @inline(__always)
  static func isForward(_ candidate: UInt16, _ current: UInt16) -> Bool {
    let delta = candidate &- current
    return delta != 0 && delta < 0x8000
  }

  // MARK: - DUML frames

  // Reflected CRC-8, init 0x77, poly 0x8C.
  static func crc8(_ data: [UInt8], _ from: Int, _ to: Int) -> UInt8 {
    var c: UInt8 = 0x77
    var i = from
    while i < to {
      c ^= data[i]
      for _ in 0..<8 { c = (c & 1) != 0 ? (c >> 1) ^ 0x8C : c >> 1 }
      i += 1
    }
    return c
  }

  // Reflected CRC-16, init 0x3692, poly 0x8408.
  static func crc16(_ data: [UInt8], _ from: Int, _ to: Int) -> UInt16 {
    var c: UInt16 = 0x3692
    var i = from
    while i < to {
      c ^= UInt16(data[i])
      for _ in 0..<8 { c = (c & 1) != 0 ? (c >> 1) ^ 0x8408 : c >> 1 }
      i += 1
    }
    return c
  }

  /// Every CRC-valid DUML frame in `raw` (byte-at-a-time scan, both CRCs validated), as raw bytes.
  /// Port of `DumlTransport.scanFrames`.
  static func scanFrames(_ raw: [UInt8]) -> [[UInt8]] {
    var out: [[UInt8]] = []
    let n = raw.count
    var i = 0
    while i + 13 <= n {
      guard raw[i] == 0x55 else {
        i += 1
        continue
      }
      let total = Int(raw[i + 1]) | ((Int(raw[i + 2]) & 0x03) << 8)
      guard raw[i + 2] >> 2 == 1, total >= 13, i + total <= n else {
        i += 1
        continue
      }
      guard crc8(raw, i, i + 3) == raw[i + 3] else {
        i += 1
        continue
      }
      let end = i + total
      let got = UInt16(raw[end - 2]) | (UInt16(raw[end - 1]) << 8)
      guard crc16(raw, i, end - 2) == got else {
        i += 1
        continue
      }
      out.append(Array(raw[i..<end]))
      i += 1
    }
    return out
  }
}

/// Three independent camera send windows echoed in every pktType-0x04 ACK (CONTEXT.md "ACK window").
/// Group 0: latest video `0x02` seq (telemetry seeds it only before the first `0x02`).
/// Group 1: ackedData `0x03` seq (command replies incl. Flip GET), merged forward-only with telemetry.
/// Group 2: extra cursor from 34-byte `0x01` telemetry.
/// Seq `0` is a valid 8-aligned cursor once seen; unseen groups 1/2 fall back to handshake `baseSeq`.
struct OpcAckWindows {
  var video: UInt16 = 0
  var hasVideoSeq = false
  /// Group 0 seeded from telemetry or advanced by video.
  var hasGroup0 = false
  var ackedData: UInt16 = 0
  var hasAckedData = false
  var extra: UInt16 = 0
  var hasExtra = false

  private mutating func advanceAckedData(_ candidate: UInt16) {
    if !hasAckedData || candidate == ackedData || OpcDumlWire.isForward(candidate, ackedData) {
      ackedData = candidate
      hasAckedData = true
    }
  }

  /// Every inbound non-video datagram passes through here.
  mutating func note(_ d: [UInt8]) {
    guard d.count >= 8 else { return }
    switch d[6] {
    case OpcDumlWire.PktType.telemetry where d.count >= 34:
      // Group 0 only before the first 0x02 (a rewind closed HEVC while HUD stayed live).
      if d.count == 34, !hasVideoSeq {
        video = OpcDumlWire.u16(d, 10)
        hasGroup0 = true
      }
      advanceAckedData(OpcDumlWire.u16(d, 18))
      extra = OpcDumlWire.u16(d, 26)
      hasExtra = true
    case OpcDumlWire.PktType.ackedData:
      if let seq = OpcDumlWire.transportSeq(d) { advanceAckedData(seq) }
    default:
      break
    }
  }

  mutating func noteVideo(seq: UInt16) {
    video = seq
    hasVideoSeq = true
    hasGroup0 = true
  }

  func payload(baseSeq: UInt16) -> [UInt8] {
    OpcDumlWire.ackPayload(
      video: hasGroup0 ? video : 0,
      ackedData: hasAckedData ? ackedData : baseSeq,
      extra: hasExtra ? extra : baseSeq)
  }
}

/// `DatalinkHandshakeAdmission`: the 0x00 ACK plus the 34-byte 0x01 initial command window.
struct OpcHandshakeAdmission {
  private(set) var acknowledged = false
  private(set) var window: UInt16?

  mutating func reset() {
    acknowledged = false
    window = nil
  }

  mutating func receive(_ d: [UInt8]) {
    if d.count >= 8, d[6] == OpcDumlWire.PktType.handshake { acknowledged = true }
    if window == nil { window = OpcDumlWire.controlSequence(fromInitialWindow: d) }
  }

  var initialCommandSequence: UInt16? { acknowledged ? window : nil }
}
