import Foundation

/// Reassembles Osmo live video into Annex-B access units.
/// Faithful port of `Sources/OpenPocketViewCore/HevcDepacketizer.swift` (sized mode with the DJI
/// 16-byte marker header + declared length, and the legacy frame-number/position fallback).
/// Not thread-safe: owned by one datalink session queue.
struct PocketVideoDepacketizer {
  private static let maxEncodedBytes = 4 * 1024 * 1024
  private var sizedMode = false
  private var expectedSize: Int?
  private var sizedBuffer: [UInt8] = []
  private var lastSizedSequence: UInt16?
  private var currentFrame: UInt8?
  private var buffer: [UInt8] = []
  private var lastPosition: Int?
  private var corrupt = false
  /// Frames dropped because a fragment was missing, reordered or oversized.
  private(set) var droppedIncomplete = 0

  /// Returns a finished access unit when its final packet arrives (or a legacy group ends).
  mutating func feed(_ payload: [UInt8]) -> [UInt8]? {
    guard payload.count > 20, payload[6] == 0x02 else { return nil }
    let body = payload[20...]
    let marker = body.starts(with: [0, 0, 1, 0xFF])
    let declared = Self.declaredSize(body)
    let nonzeroDeclaration =
      marker && body.count >= 16 && body.dropFirst(4).prefix(4).contains(where: { $0 != 0 })
    if sizedMode || nonzeroDeclaration {
      if !sizedMode {
        sizedMode = true
        buffer.removeAll(keepingCapacity: false)
      }
      return feedSized(payload, body: body, marker: marker, declared: declared)
    }
    let frameNo = payload[16]
    let position = Int(payload[18]) * 2 + Int(payload[17] >> 7)

    var completed: [UInt8]?
    if let cur = currentFrame, cur != frameNo {
      if !buffer.isEmpty {
        if corrupt {
          droppedIncomplete += 1
        } else {
          completed = PocketAnnexB.stripDjiMarker(buffer)
        }
      }
      buffer.removeAll(keepingCapacity: true)
      corrupt = false
      lastPosition = nil
    }
    currentFrame = frameNo
    if let last = lastPosition {
      if position == last { return completed }  // UDP duplicate
      if position < last {
        if !buffer.isEmpty {
          if corrupt {
            droppedIncomplete += 1
          } else {
            completed = PocketAnnexB.stripDjiMarker(buffer)
          }
        }
        buffer.removeAll(keepingCapacity: true)
        corrupt = false
      } else if position != last + 1 {
        corrupt = true
      }
    }
    lastPosition = position
    if payload.count - 20 <= Self.maxEncodedBytes + 16 - buffer.count {
      buffer.append(contentsOf: payload[20...])
    } else {
      corrupt = true
    }
    return completed
  }

  private static func declaredSize(_ body: ArraySlice<UInt8>) -> Int? {
    guard body.count >= 16, body.starts(with: [0, 0, 1, 0xFF]) else { return nil }
    var count: UInt32 = 0
    for k in 0..<4 { count |= UInt32(body[body.startIndex + 4 + k]) << (k * 8) }
    guard count > 0, count <= UInt32(maxEncodedBytes) else { return nil }
    return Int(count) + 16
  }

  private mutating func feedSized(
    _ packet: [UInt8], body: ArraySlice<UInt8>, marker: Bool, declared: Int?
  ) -> [UInt8]? {
    let sequence = UInt16(packet[4]) | (UInt16(packet[5]) << 8)
    if sequence == lastSizedSequence { return nil }
    if marker {
      if expectedSize != nil { droppedIncomplete += 1 }
      sizedBuffer.removeAll(keepingCapacity: true)
      expectedSize = declared
      lastSizedSequence = nil
    }
    guard let expectedSize else { return nil }
    if let last = lastSizedSequence, sequence != last &+ 8 {
      droppedIncomplete += 1
      self.expectedSize = nil
      sizedBuffer.removeAll(keepingCapacity: true)
      lastSizedSequence = sequence
      return nil
    }
    lastSizedSequence = sequence
    guard body.count <= expectedSize - sizedBuffer.count else {
      droppedIncomplete += 1
      self.expectedSize = nil
      sizedBuffer.removeAll(keepingCapacity: true)
      return nil
    }
    sizedBuffer.append(contentsOf: body)
    guard sizedBuffer.count == expectedSize else { return nil }
    let accessUnit = Array(sizedBuffer.dropFirst(16))
    sizedBuffer.removeAll(keepingCapacity: true)
    self.expectedSize = nil
    return accessUnit
  }

  mutating func reset() {
    sizedMode = false
    expectedSize = nil
    sizedBuffer.removeAll(keepingCapacity: false)
    lastSizedSequence = nil
    currentFrame = nil
    buffer.removeAll(keepingCapacity: true)
    lastPosition = nil
    corrupt = false
    droppedIncomplete = 0
  }
}

/// Annex-B helpers (ports of `Hevc` / `Avc` / `LiveVideo` classification in the core).
enum PocketAnnexB {
  static func hevcNalType(_ b: UInt8) -> Int { Int((b >> 1) & 0x3F) }
  static func avcNalType(_ b: UInt8) -> Int { Int(b & 0x1F) }

  /// Drop DJI's `00 00 01 ff …` marker (HEVC NAL type 63): return from the first standard NAL.
  static func stripDjiMarker(_ annexB: [UInt8]) -> [UInt8] {
    var i = 0
    while i + 4 <= annexB.count {
      if annexB[i] == 0, annexB[i + 1] == 0, annexB[i + 2] == 1 {
        if hevcNalType(annexB[i + 3]) != 63 { return Array(annexB[i...]) }
        i += 3
      } else {
        i += 1
      }
    }
    return annexB
  }

  /// Nano private AVC SEI: `06 F0 19` + 25 raw (non-emulation-prevented) bytes + `80`.
  @inline(__always)
  private static func isNanoPrivateSEI(_ b: [UInt8], startCodeAt i: Int) -> Bool {
    i + 32 <= b.count && b[i + 3] == 6 && b[i + 4] == 0xF0 && b[i + 5] == 25 && b[i + 31] == 0x80
  }

  /// First byte of every NAL (skipping the Nano private SEI contents by length).
  static func nalHeaders(_ b: [UInt8]) -> [UInt8] {
    var out: [UInt8] = []
    var i = 0
    while i + 3 < b.count {
      if b[i] == 0, b[i + 1] == 0, b[i + 2] == 1 {
        if isNanoPrivateSEI(b, startCodeAt: i) {
          i += 32
          continue
        }
        out.append(b[i + 3])
        i += 3
      } else {
        i += 1
      }
    }
    return out
  }

  /// Removes the Nano private SEI NAL (start code included). Its raw payload can contain
  /// `00 00 01`, which a decoder would split into fake slices (docs/live-session.md, Nano).
  static func removeNanoPrivateSEI(_ b: [UInt8]) -> [UInt8] {
    var ranges: [Range<Int>] = []
    var i = 0
    while i + 3 < b.count {
      if b[i] == 0, b[i + 1] == 0, b[i + 2] == 1 {
        if isNanoPrivateSEI(b, startCodeAt: i) {
          let start = (i > 0 && b[i - 1] == 0) ? i - 1 : i  // 4-byte start code
          ranges.append(start..<(i + 32))
          i += 32
          continue
        }
        i += 3
      } else {
        i += 1
      }
    }
    guard !ranges.isEmpty else { return b }
    var out: [UInt8] = []
    out.reserveCapacity(b.count)
    var cursor = 0
    for r in ranges {
      out.append(contentsOf: b[cursor..<r.lowerBound])
      cursor = r.upperBound
    }
    out.append(contentsOf: b[cursor...])
    return out
  }

  /// Parameter sets are unambiguous: HEVC 0x40/0x42/0x44, AVC 0x67/0x68 (never `b & 0x1f`).
  static func detectCodec(_ headers: [UInt8]) -> PocketVideoCodec? {
    for h in headers {
      switch h {
      case 0x40, 0x42, 0x44: return .hevc
      case 0x67, 0x68: return .avc
      default: continue
      }
    }
    return nil
  }

  /// IRAP (HEVC 16…21) or AVC IDR.
  static func hasRandomAccess(_ headers: [UInt8], codec: PocketVideoCodec) -> Bool {
    headers.contains { h in
      codec == .avc ? avcNalType(h) == 5 : (16...21).contains(hevcNalType(h))
    }
  }

  /// Parameter set or random-access slice: never dropped while waiting for random access.
  static func carriesKeyframe(_ headers: [UInt8], codec: PocketVideoCodec) -> Bool {
    headers.contains { h in
      if codec == .avc {
        let t = avcNalType(h)
        return t == 7 || t == 8 || t == 5
      }
      let t = hevcNalType(h)
      return t == 32 || t == 33 || t == 34 || (16...21).contains(t)
    }
  }
}

/// Depacketizer + the random-access gate of upstream `SoftAPVideoAssembler`: after a lost
/// fragment, dependants are dropped until an AU that carries a keyframe NAL, so the decoder never
/// sees P-frames whose references are missing. Codec latches from observed parameter sets.
struct PocketVideoAssembler {
  private var depacketizer = PocketVideoDepacketizer()
  private var incompleteSeen = 0
  private var awaitingRandomAccess = false
  private(set) var codec: PocketVideoCodec?
  private(set) var accessUnits = 0
  private(set) var droppedAccessUnits = 0
  var droppedIncomplete: Int { depacketizer.droppedIncomplete }

  /// Feeds one pktType-0x02 datagram. Returns a decodable Annex-B AU, if one completed.
  mutating func ingest(_ datagram: [UInt8], hint: PocketVideoCodec) -> (au: [UInt8], codec: PocketVideoCodec)? {
    let completed = depacketizer.feed(datagram)
    if depacketizer.droppedIncomplete > incompleteSeen {
      incompleteSeen = depacketizer.droppedIncomplete
      awaitingRandomAccess = true
    }
    guard let raw = completed, !raw.isEmpty else { return nil }
    let au = PocketAnnexB.removeNanoPrivateSEI(raw)
    let headers = PocketAnnexB.nalHeaders(au)
    if codec == nil { codec = PocketAnnexB.detectCodec(headers) }
    let c = codec ?? hint
    if PocketAnnexB.hasRandomAccess(headers, codec: c) { awaitingRandomAccess = false }
    guard !awaitingRandomAccess || PocketAnnexB.carriesKeyframe(headers, codec: c) else {
      droppedAccessUnits += 1
      return nil
    }
    accessUnits += 1
    return (au, c)
  }

  mutating func reset() {
    depacketizer.reset()
    incompleteSeen = 0
    awaitingRandomAccess = false
    codec = nil
  }
}
