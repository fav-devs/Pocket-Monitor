import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox
import os

/// The relay's own picture (docs/watcher-relay.md, upstream `WatcherRelayEncoder`): the decoded camera
/// picture re-encoded as identity-size HEVC with the phone's hardware encoder. Keyframes come from
/// this session every `keyInterval` and on demand (a joiner, a watcher that skipped frames), never
/// from the camera (`0x09/0xa8` stays the watchdog's).
///
/// Settings (upstream values): HEVC Main (auto level), real time, no frame reordering, one frame of
/// delay, 25 fps expected, a keyframe at least every 50 frames / 2 s, average bitrate from the
/// 10 → 7 → 4.5 → 3 Mb/s ladder with a one-second data-rate cap. Forced keyframes are spaced at
/// least one second apart, and a repeated request does not reset that cooldown.
///
/// Threading: `queue` owns the VTCompressionSession. VideoToolbox may complete on its own thread,
/// before or after `VTCompressionSessionEncodeFrame` returns; `completion` runs exactly once.
final class PocketRelayEncoder {
  struct Output {
    /// Annex-B access unit; a keyframe carries its parameter sets in front.
    let data: Data
    let key: Bool
    /// VPS/SPS/PPS without start codes, keyframes only.
    let sets: [Data]?
  }

  static let ladder = [10_000_000, 7_000_000, 4_500_000, 3_000_000]
  static let expectedFrameRate = 25
  static let keyIntervalFrames = 50
  static let keyIntervalSeconds: Double = 2
  static let minimumForcedKeySeconds: TimeInterval = 1

  /// iOS 17 devices all have a hardware HEVC encoder; this checks that one is offered (and is the
  /// only gate for the forwarding fallback). Computed once.
  static let isAvailable: Bool = {
    var encoderID: CFString?
    var properties: CFDictionary?
    let status = VTCopySupportedPropertyDictionaryForEncoder(
      width: 1280, height: 720, codecType: kCMVideoCodecType_HEVC, encoderSpecification: nil,
      encoderIDOut: &encoderID, supportedPropertiesOut: &properties)
    return status == noErr
  }()

  private let queue = DispatchQueue(label: "pocket.relay.encode", qos: .userInitiated)
  private let log = Logger(subsystem: "com.favdevs.pocketmonitor", category: "relay")

  // queue-confined
  private var session: VTCompressionSession?
  private var width = 0
  private var height = 0
  private var bitrate = PocketRelayEncoder.ladder[0]
  private var lastForcedKey: TimeInterval = -.infinity
  private var retryAfter: TimeInterval = 0

  func setBitrate(_ bps: Int) {
    queue.async { [self] in
      guard bps != bitrate else { return }
      bitrate = bps
      applyBitrate()
    }
  }

  func invalidate() {
    queue.async { [self] in tearDown() }
  }

  /// `completion(output, failed)`; `output == nil && !failed` is a frame the encoder skipped.
  func encode(_ buffer: CVPixelBuffer, forceKey: Bool, completion: @escaping (Output?, Bool) -> Void) {
    let done = Once(completion)
    queue.async { [self] in
      let w = CVPixelBufferGetWidth(buffer)
      let h = CVPixelBufferGetHeight(buffer)
      guard w > 8, h > 8 else {
        done.finish(nil, failed: false)
        return
      }
      let now = PocketRelayWire.now()
      if session == nil || w != width || h != height {
        guard now >= retryAfter else {
          done.finish(nil, failed: true)
          return
        }
        rebuild(width: w, height: h)
      }
      guard let session else {
        retryAfter = now + 1
        done.finish(nil, failed: true)
        return
      }
      var key = false
      if forceKey, now - lastForcedKey >= Self.minimumForcedKeySeconds {
        key = true
        lastForcedKey = now
      }
      let props = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
      let pts = CMTime(value: CMTimeValue(now * 90_000), timescale: 90_000)
      var info = VTEncodeInfoFlags()
      let status = VTCompressionSessionEncodeFrame(
        session, imageBuffer: buffer, presentationTimeStamp: pts, duration: .invalid,
        frameProperties: props, infoFlagsOut: &info,
        outputHandler: { status, flags, sample in
          if status != noErr {
            done.finish(nil, failed: true)
          } else if flags.contains(.frameDropped) {
            done.finish(nil, failed: false)
          } else {
            done.finish(sample.flatMap(Self.annexB), failed: false)
          }
        })
      if status != noErr {
        // Backgrounding / media-server reset: rebuild on a later frame (bounded to once a second).
        log.error("relay encode failed \(status)")
        if status == kVTInvalidSessionErr { tearDown() }
        retryAfter = now + 1
        done.finish(nil, failed: true)
      } else if info.contains(.frameDropped) {
        done.finish(nil, failed: false)
      }
    }
  }

  // MARK: Session (queue)

  private func rebuild(width: Int, height: Int) {
    tearDown()
    self.width = width
    self.height = height
    var created: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_HEVC,
      encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
      outputCallback: nil, refcon: nil, compressionSessionOut: &created)
    guard status == noErr, let created else {
      log.error("relay encoder create failed \(status)")
      return
    }
    VTSessionSetProperty(created, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_HEVC_Main_AutoLevel)
    VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: Self.expectedFrameRate as CFNumber)
    VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: Self.keyIntervalFrames as CFNumber)
    VTSessionSetProperty(
      created, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: Self.keyIntervalSeconds as CFNumber)
    VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    // The admission window is two frames: VT must emit before it needs a third.
    VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: 1 as CFNumber)
    // Lower encoder power for a monitoring feed (VERIFY on device: picture stays clean at 3 Mb/s).
    VTSessionSetProperty(created, key: kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, value: kCFBooleanTrue)
    session = created
    applyBitrate()
    VTCompressionSessionPrepareToEncodeFrames(created)
    // A new session starts with a keyframe anyway; do not force a second one right behind it.
    lastForcedKey = PocketRelayWire.now()
    log.info("relay encoder \(width)x\(height) HEVC \(self.bitrate) b/s")
  }

  private func applyBitrate() {
    guard let session else { return }
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
    VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_DataRateLimits, value: [Int64(bitrate / 8) as CFNumber, 1 as CFNumber] as CFArray)
  }

  private func tearDown() {
    if let session {
      VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
      VTCompressionSessionInvalidate(session)
    }
    session = nil
    width = 0
    height = 0
  }

  /// One-shot completion: VT can call back before `EncodeFrame` returns and report a drop twice.
  private final class Once {
    private let lock = NSLock()
    private var completion: ((Output?, Bool) -> Void)?
    init(_ completion: @escaping (Output?, Bool) -> Void) { self.completion = completion }
    func finish(_ value: Output?, failed: Bool) {
      lock.lock()
      let callback = completion
      completion = nil
      lock.unlock()
      callback?(value, failed)
    }
  }

  /// AVCC sample → Annex-B, keyframes with their parameter sets in front (upstream `annexB`).
  private static func annexB(_ sample: CMSampleBuffer) -> Output? {
    guard let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
    var length = 0
    var pointer: UnsafeMutablePointer<Int8>?
    guard
      CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer)
        == kCMBlockBufferNoErr, let pointer, length > 4
    else { return nil }
    // VERIFY: VT hands back one contiguous block buffer for a 720p frame (as upstream assumes).
    let bytes = UnsafeRawPointer(pointer).assumingMemoryBound(to: UInt8.self)
    var body = Data(capacity: length + 16)
    var offset = 0
    while offset + 4 <= length {
      let n = Int(bytes[offset]) << 24 | Int(bytes[offset + 1]) << 16 | Int(bytes[offset + 2]) << 8 | Int(bytes[offset + 3])
      offset += 4
      guard n > 0, offset + n <= length else { break }
      body.append(contentsOf: [0, 0, 0, 1])
      body.append(bytes + offset, count: n)
      offset += n
    }
    var key = true
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [Any],
      let first = attachments.first as? [NSString: Any]
    {
      key = (first[kCMSampleAttachmentKey_NotSync] as? Bool) != true
    }
    guard key else { return Output(data: body, key: false, sets: nil) }
    var sets: [Data] = []
    if let format = CMSampleBufferGetFormatDescription(sample) {
      var count = 0
      CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
        format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
        parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
      for i in 0..<count {
        var p: UnsafePointer<UInt8>?
        var size = 0
        CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
          format, parameterSetIndex: i, parameterSetPointerOut: &p, parameterSetSizeOut: &size,
          parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
        if let p, size > 0 { sets.append(Data(bytes: p, count: size)) }
      }
    }
    return Output(data: sets.isEmpty ? body : PocketRelayWire.prefixed(sets, body), key: true, sets: sets.isEmpty ? nil : sets)
  }
}

/// Upstream `WatcherRelayBitrate` / `RelayBitratePolicy`: a 5 s window of 5 Hz ticks. More than 30 %
/// consecutive-saturated ticks (every watcher's send window full, or the camera delivering below 80 %
/// of the best rate seen this sharing session) steps one rung down; 30 clean seconds step one rung
/// back up, never above the operator ceiling.
struct PocketRelayBitrate {
  static let windowSeconds: TimeInterval = 5
  static let stepDownSaturation = 0.3
  static let stepUpSaturation = 0.05
  static let stepUpAfterCleanSeconds: TimeInterval = 30
  static let starvationFraction = 0.8

  var ceilingIndex = 0
  private(set) var rungIndex = 0
  private var windowStartedAt: TimeInterval
  private var ticks = 0
  private var saturatedTicks = 0
  private var previousFull = false
  private var cleanSince: TimeInterval

  init(now: TimeInterval) {
    windowStartedAt = now
    cleanSince = now
  }

  var bitsPerSecond: Int {
    let ladder = PocketRelayEncoder.ladder
    return ladder[min(max(max(rungIndex, ceilingIndex), 0), ladder.count - 1)]
  }

  /// The new bitrate when it changes.
  mutating func tick(saturated: Bool, cameraStarving: Bool, now: TimeInterval) -> Int? {
    let full = saturated || cameraStarving
    ticks += 1
    if full && previousFull { saturatedTicks += 1 }
    previousFull = full
    guard now - windowStartedAt >= Self.windowSeconds, ticks > 0 else { return nil }
    let saturation = Double(saturatedTicks) / Double(ticks)
    ticks = 0
    saturatedTicks = 0
    windowStartedAt = now
    if saturation > Self.stepDownSaturation {
      cleanSince = now
      guard rungIndex < PocketRelayEncoder.ladder.count - 1 else { return nil }
      rungIndex += 1
      return bitsPerSecond
    }
    if saturation > Self.stepUpSaturation {
      cleanSince = now
      return nil
    }
    if rungIndex > ceilingIndex, now - cleanSince >= Self.stepUpAfterCleanSeconds {
      rungIndex -= 1
      cleanSince = now
      return bitsPerSecond
    }
    return nil
  }
}
