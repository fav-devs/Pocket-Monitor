import Foundation
import Network

/// Watcher relay wire (docs/watcher-relay.md; JS mirror and tests in src/camera/watcher/protocol.ts,
/// Kotlin twin in android/.../relay/RelayWire.kt): `[u32be payload length + 1][u8 kind][payload]`,
/// JSON control messages, frame payloads `[u32be meta length][meta JSON][Annex-B access unit]`.
enum PocketRelayWire {
  static let serviceType = "_pocket-mon._tcp"
  static let legacyServiceType = "_opc-mon._tcp"
  /// Ours first: a name advertised on both shows once, as ours.
  static let browseTypes = [serviceType, legacyServiceType]
  static let version = 1
  static let maxPayload = 8 * 1024 * 1024
  /// Watcher → host messages are tiny (hello, control, commands).
  static let maxWatcherPayload = 64 * 1024
  static let headerBytes = 5
  static let txtCamera = "c"
  static let txtWatchable = "w"
  static let hevcCodec = 1
  /// Pocket Monitor extension for a forwarded Nano (AVC) feed; upstream watchers take only 1.
  static let avcCodec = 2

  enum Kind: UInt8 {
    case hello = 0x01
    case state = 0x02
    case frame = 0x03
    case controlToken = 0x04
    case joinDenied = 0x05
    case requestControl = 0x10
    case releaseControl = 0x11
    case command = 0x12
  }

  static let versionMismatch = "Update the app on both devices to watch this feed."
  static let wrongPasscode = "Wrong passcode."
  static let fellBehind = "The shared feed fell behind live delivery."

  /// Monotonic seconds (host `encodedAt`, watcher freshness).
  static func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

  /// Same socket recipe as upstream `RelayAppleNetwork.parameters`: no peer-to-peer, no cellular,
  /// interactive video, TCP no-delay with keepalive.
  static func parameters() -> NWParameters {
    let parameters = NWParameters.tcp
    parameters.includePeerToPeer = false
    parameters.prohibitedInterfaceTypes = [.cellular]
    parameters.serviceClass = .interactiveVideo
    if let tcp = parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
      tcp.noDelay = true
      tcp.enableKeepalive = true
      tcp.keepaliveIdle = 10
      tcp.keepaliveInterval = 5
      tcp.keepaliveCount = 3
    }
    return parameters
  }

  static func header(_ kind: Kind, payloadLength: Int) -> Data {
    let declared = UInt32(payloadLength + 1)
    return Data([
      UInt8(truncatingIfNeeded: declared >> 24), UInt8(truncatingIfNeeded: declared >> 16),
      UInt8(truncatingIfNeeded: declared >> 8), UInt8(truncatingIfNeeded: declared), kind.rawValue,
    ])
  }

  static func message(_ kind: Kind, _ payload: Data) -> Data {
    var out = header(kind, payloadLength: payload.count)
    out.append(payload)
    return out
  }

  static func message(_ kind: Kind, json: [String: Any]) -> Data {
    message(kind, (try? JSONSerialization.data(withJSONObject: json)) ?? Data("{}".utf8))
  }

  enum DecodeError: Error {
    case payloadTooLarge(Int)
    case unknownKind(UInt8)
  }

  /// Stream reassembly: complete messages at the front of the buffer, in order.
  struct Reader {
    private var buffer = Data()
    let maxPayload: Int

    init(maxPayload: Int) { self.maxPayload = maxPayload }

    mutating func append(_ bytes: Data) throws -> [(kind: Kind, payload: Data)] {
      buffer.append(bytes)
      var out: [(Kind, Data)] = []
      while buffer.count >= PocketRelayWire.headerBytes {
        let s = buffer.startIndex
        let declared = Int(buffer[s]) << 24 | Int(buffer[s + 1]) << 16 | Int(buffer[s + 2]) << 8 | Int(buffer[s + 3])
        guard declared >= 1, declared - 1 <= maxPayload else { throw DecodeError.payloadTooLarge(declared) }
        let total = 4 + declared
        guard buffer.count >= total else { break }
        guard let kind = Kind(rawValue: buffer[s + 4]) else { throw DecodeError.unknownKind(buffer[s + 4]) }
        out.append((kind, Data(buffer[(s + 5)..<(s + total)])))
        buffer.removeSubrange(s..<(s + total))
      }
      if buffer.isEmpty { buffer = Data() }
      return out
    }
  }

  static func hello(hostName: String, cameraName: String?) -> [String: Any] {
    var out: [String: Any] = ["version": version, "hostName": hostName]
    if let cameraName, !cameraName.isEmpty { out["cameraName"] = cameraName }
    return out
  }

  static func denied(_ reason: String, passcodeRequired: Bool) -> [String: Any] {
    ["reason": reason, "passcodeRequired": passcodeRequired]
  }

  static func token(holderName: String, recipient: Bool) -> [String: Any] {
    ["holderName": holderName, "holderIsRecipient": recipient]
  }

  /// Everything of a frame message before its access unit, so the AU is shared, not rebuilt.
  static func frameHead(
    codec: PocketVideoCodec, keyframe: Bool, parameterSets: [Data]?, recording: Bool, mirrored: Bool,
    encodedAt: TimeInterval, catchUp: Bool, accessUnitLength: Int
  ) -> Data {
    var meta: [String: Any] = [
      "codec": codec == .avc ? avcCodec : hevcCodec,
      "isKeyframe": keyframe,
      "isRecording": recording,
      "extraMirrored": mirrored,
      "encodedAt": encodedAt,
    ]
    if keyframe, let parameterSets, !parameterSets.isEmpty {
      meta["parameterSets"] = parameterSets.map { $0.base64EncodedString() }
    }
    if catchUp { meta["catchUp"] = true }
    let json = (try? JSONSerialization.data(withJSONObject: meta)) ?? Data("{}".utf8)
    var out = header(.frame, payloadLength: 4 + json.count + accessUnitLength)
    let n = UInt32(json.count)
    out.append(contentsOf: [
      UInt8(truncatingIfNeeded: n >> 24), UInt8(truncatingIfNeeded: n >> 16),
      UInt8(truncatingIfNeeded: n >> 8), UInt8(truncatingIfNeeded: n),
    ])
    out.append(json)
    return out
  }

  struct Frame {
    let codec: PocketVideoCodec
    let keyframe: Bool
    let parameterSets: [Data]
    let encodedAt: TimeInterval?
    let catchUp: Bool
    let accessUnit: Data
  }

  static func decodeFrame(_ payload: Data) -> Frame? {
    guard payload.count >= 4 else { return nil }
    let s = payload.startIndex
    let n = Int(payload[s]) << 24 | Int(payload[s + 1]) << 16 | Int(payload[s + 2]) << 8 | Int(payload[s + 3])
    guard n >= 0, 4 + n <= payload.count,
      let meta = (try? JSONSerialization.jsonObject(with: payload.subdata(in: (s + 4)..<(s + 4 + n)))) as? [String: Any],
      let rawCodec = (meta["codec"] as? NSNumber)?.intValue, meta["isKeyframe"] != nil
    else { return nil }
    let codec: PocketVideoCodec
    switch rawCodec {
    case hevcCodec: codec = .hevc
    case avcCodec: codec = .avc
    default: return nil
    }
    let sets = (meta["parameterSets"] as? [String] ?? []).compactMap { Data(base64Encoded: $0) }
    let encodedAt = (meta["encodedAt"] as? NSNumber)?.doubleValue
    return Frame(
      codec: codec, keyframe: (meta["isKeyframe"] as? Bool) ?? false, parameterSets: sets,
      encodedAt: encodedAt.flatMap { $0.isFinite ? $0 : nil }, catchUp: (meta["catchUp"] as? Bool) ?? false,
      accessUnit: payload.subdata(in: (s + 4 + n)..<payload.endIndex))
  }

  /// `sets` as Annex-B in front of `au`.
  static func prefixed(_ sets: [Data], _ au: Data) -> Data {
    var out = Data()
    for set in sets {
      out.append(contentsOf: [0, 0, 0, 1])
      out.append(set)
    }
    out.append(au)
    return out
  }

  /// Random access and the parameter sets an AU carries (HEVC VPS/SPS/PPS, AVC SPS/PPS, in order).
  static func classify(_ au: Data, codec: PocketVideoCodec) -> (keyframe: Bool, parameterSets: [Data]) {
    au.withUnsafeBytes { raw -> (Bool, [Data]) in
      var key = false
      var sets: [Data] = []
      for nal in PocketVideoAnnexB.nals(raw, codec: codec) {
        if PocketVideoAnnexB.isParameterSet(nal.type, codec: codec) {
          sets.append(Data(raw[nal.range]))
        } else if PocketVideoAnnexB.isVCL(nal.type, codec: codec), PocketVideoAnnexB.isRandomAccess(nal.type, codec: codec) {
          key = true
        }
      }
      return (key, sets)
    }
  }

  static func jsonObject(_ data: Data) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }
}

/// `WatcherRelayFrameFreshness`: growth in delivery delay without synchronized clocks.
struct PocketRelayFreshness {
  private var minimumOffset: TimeInterval?
  mutating func isFallingBehind(encodedAt: TimeInterval?, receivedAt: TimeInterval) -> Bool {
    guard let encodedAt, encodedAt.isFinite else { return false }
    let offset = receivedAt - encodedAt
    let minimum = min(minimumOffset ?? offset, offset)
    minimumOffset = minimum
    return offset - minimum > 0.75
  }
}
