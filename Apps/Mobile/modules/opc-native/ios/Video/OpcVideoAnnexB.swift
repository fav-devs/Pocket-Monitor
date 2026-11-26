import Foundation

/// Annex-B splitting and NAL classification for the live access units the datalink hands over.
/// Mirrors Sources/OpenPocketViewCore/Hevc.swift + Avc.swift (same DJI marker and Nano SEI rules).
enum OpcVideoAnnexB {
  struct Nal {
    /// Byte range of the NAL payload (start code excluded) inside the access unit.
    let range: Range<Int>
    let type: Int
  }

  /// Splits an Annex-B buffer into NAL ranges. 3- and 4-byte start codes; trailing zero bytes
  /// that belong to the next start code are trimmed. Nano's private SEI (payload 0xF0, 25 raw
  /// bytes without emulation prevention) is skipped by length so its bytes never fake a NAL.
  static func nals(_ data: UnsafeRawBufferPointer, codec: OpcVideoCodec) -> [Nal] {
    let b = data.bindMemory(to: UInt8.self)
    let n = b.count
    var starts: [Int] = []
    var skipped: Set<Int> = []
    var i = 0
    while i + 3 <= n {
      if b[i] == 0, b[i + 1] == 0, b[i + 2] == 1 {
        starts.append(i + 3)
        if i + 32 <= n, b[i + 3] == 6, b[i + 4] == 0xF0, b[i + 5] == 25, b[i + 31] == 0x80 {
          skipped.insert(i + 3)
          i += 32
        } else {
          i += 3
        }
      } else {
        i += 1
      }
    }
    var out: [Nal] = []
    out.reserveCapacity(starts.count)
    for (k, s) in starts.enumerated() {
      if skipped.contains(s) { continue }
      var e = k + 1 < starts.count ? starts[k + 1] - 3 : n
      while e > s, b[e - 1] == 0 { e -= 1 }
      guard e > s else { continue }
      out.append(Nal(range: s..<e, type: nalType(b[s], codec: codec)))
    }
    return out
  }

  static func nalType(_ first: UInt8, codec: OpcVideoCodec) -> Int {
    switch codec {
    case .hevc: return Int((first >> 1) & 0x3f)
    case .avc: return Int(first & 0x1f)
    }
  }

  // HEVC: VPS 32, SPS 33, PPS 34, IRAP 16…21, VCL 0…31, DJI marker 63.
  // AVC: SPS 7, PPS 8, IDR 5, VCL 1…5.

  static func isParameterSet(_ t: Int, codec: OpcVideoCodec) -> Bool {
    codec == .hevc ? (32...34).contains(t) : (t == 7 || t == 8)
  }

  static func isVCL(_ t: Int, codec: OpcVideoCodec) -> Bool {
    codec == .hevc ? t <= 31 : (1...5).contains(t)
  }

  static func isRandomAccess(_ t: Int, codec: OpcVideoCodec) -> Bool {
    codec == .hevc ? (16...21).contains(t) : t == 5
  }

  /// Cheap keyframe probe for backlog shedding: an IRAP/IDR slice or a parameter set.
  static func carriesKeyframe(_ data: Data, codec: OpcVideoCodec) -> Bool {
    data.withUnsafeBytes { raw in
      nals(raw, codec: codec).contains { isRandomAccess($0.type, codec: codec) || isParameterSet($0.type, codec: codec) }
    }
  }
}
