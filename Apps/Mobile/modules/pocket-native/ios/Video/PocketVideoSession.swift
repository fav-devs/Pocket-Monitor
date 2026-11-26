import CoreMedia
import CoreVideo
import Foundation
import QuartzCore
import VideoToolbox

/// One decoded picture. The pixel buffer comes from VideoToolbox's pool; holding it keeps one
/// pool slot busy, so only the latest frame is retained.
final class PocketVideoFrame {
  let pixelBuffer: CVPixelBuffer
  let sequence: UInt64
  /// CACurrentMediaTime() when the decoder delivered it.
  let arrivedAt: CFTimeInterval
  let width: Int
  let height: Int

  init(pixelBuffer: CVPixelBuffer, sequence: UInt64, arrivedAt: CFTimeInterval) {
    self.pixelBuffer = pixelBuffer
    self.sequence = sequence
    self.arrivedAt = arrivedAt
    width = CVPixelBufferGetWidth(pixelBuffer)
    height = CVPixelBufferGetHeight(pixelBuffer)
  }
}

/// Sessions shared by every view of one `sessionId`, reference-counted by those views.
final class PocketVideoSessionHub {
  static let shared = PocketVideoSessionHub()
  private let lock = NSLock()
  private var sessions: [String: (session: PocketVideoSession, refs: Int)] = [:]

  func acquire(_ id: String) -> PocketVideoSession {
    lock.lock()
    defer { lock.unlock() }
    if let entry = sessions[id] {
      sessions[id] = (entry.session, entry.refs + 1)
      return entry.session
    }
    let session = PocketVideoSession(sessionId: id)
    sessions[id] = (session, 1)
    PocketVideoSinkRegistry.shared.add(session, for: id)
    return session
  }

  func release(_ session: PocketVideoSession) {
    lock.lock()
    guard let entry = sessions[session.sessionId], entry.session === session else {
      lock.unlock()
      return
    }
    if entry.refs > 1 {
      sessions[session.sessionId] = (session, entry.refs - 1)
      lock.unlock()
      return
    }
    sessions[session.sessionId] = nil
    lock.unlock()
    PocketVideoSinkRegistry.shared.remove(session, for: session.sessionId)
    session.shutdown()
  }

  func existing(_ id: String) -> PocketVideoSession? {
    lock.lock()
    defer { lock.unlock() }
    return sessions[id]?.session
  }
}

/// Per-session VideoToolbox decoder fed with Annex-B access units by the datalink.
///
/// Threading: `receive` / `reset` run on the datalink queue and only enqueue onto `decodeQueue`
/// (serial, user-interactive). All VideoToolbox state is confined to `decodeQueue`. The decoded
/// frame and counters live behind `lock` and are read by the views' render loop.
final class PocketVideoSession: PocketVideoSink {
  let sessionId: String

  /// More than this many AUs waiting means decode fell behind: shed until the next keyframe
  /// rather than let latency grow.
  private static let maxPending = 4

  private let decodeQueue: DispatchQueue
  private let lock = NSLock()

  // lock-protected
  private var latest: PocketVideoFrame?
  private var sequence: UInt64 = 0
  private var pending = 0
  private var shedding = false
  private var forceKeyframeWait = false
  private var decodedTotal: UInt64 = 0
  private var droppedTotal: UInt64 = 0
  private var effects = PocketPictureEffects()
  private var closed = false

  // decodeQueue-confined
  private var codec: PocketVideoCodec?
  private var vps: Data?
  private var sps: Data?
  private var pps: Data?
  private var format: CMVideoFormatDescription?
  private var session: VTDecompressionSession?
  private var awaitingKeyframe = true
  private var sessionAttemptFailed = false

  init(sessionId: String) {
    self.sessionId = sessionId
    decodeQueue = DispatchQueue(label: "pocket.video.decode.\(sessionId)", qos: .userInteractive)
  }

  // MARK: Reader side (any thread)

  func latestFrame() -> PocketVideoFrame? {
    lock.lock()
    defer { lock.unlock() }
    return latest
  }

  /// Total decoded and dropped (shed, waiting for a keyframe, failed) frames since creation.
  func counters() -> (decoded: UInt64, dropped: UInt64) {
    lock.lock()
    defer { lock.unlock() }
    return (decodedTotal, droppedTotal)
  }

  /// Effects of the most recently drawn picture of this session (for `snapshot(withEffects)`).
  var lastEffects: PocketPictureEffects {
    get { lock.lock(); defer { lock.unlock() }; return effects }
    set { lock.lock(); effects = newValue; lock.unlock() }
  }

  func shutdown() {
    lock.lock()
    closed = true
    latest = nil
    lock.unlock()
    decodeQueue.async { [self] in tearDownSession() }
  }

  // MARK: PocketVideoSink (datalink receive queue; must not block)

  func receive(accessUnit: Data, codec: PocketVideoCodec, presentationTimeUs: Int64) {
    lock.lock()
    if closed {
      lock.unlock()
      return
    }
    if pending >= Self.maxPending { shedding = true }
    if shedding {
      // Only a keyframe AU may end shedding; probe outside the lock below.
      lock.unlock()
      guard PocketVideoAnnexB.carriesKeyframe(accessUnit, codec: codec) else {
        lock.lock()
        droppedTotal += 1
        lock.unlock()
        return
      }
      lock.lock()
      shedding = false
      forceKeyframeWait = true
    }
    pending += 1
    lock.unlock()
    decodeQueue.async { [self] in
      process(accessUnit, codec: codec, pts: presentationTimeUs)
      lock.lock()
      pending -= 1
      lock.unlock()
    }
  }

  func reset() {
    decodeQueue.async { [self] in
      tearDownSession()
      vps = nil
      sps = nil
      pps = nil
      format = nil
      awaitingKeyframe = true
    }
  }

  // MARK: Decode (decodeQueue)

  private func process(_ data: Data, codec: PocketVideoCodec, pts: Int64) {
    if self.codec != codec {
      tearDownSession()
      self.codec = codec
      vps = nil
      sps = nil
      pps = nil
      format = nil
    }
    lock.lock()
    if forceKeyframeWait {
      forceKeyframeWait = false
      awaitingKeyframe = true
    }
    lock.unlock()

    var newVPS: Data?, newSPS: Data?, newPPS: Data?
    var slices: [Range<Int>] = []
    var randomAccess = false
    data.withUnsafeBytes { raw in
      for nal in PocketVideoAnnexB.nals(raw, codec: codec) {
        let t = nal.type
        if PocketVideoAnnexB.isParameterSet(t, codec: codec) {
          let bytes = Data(raw[nal.range])
          switch (codec, t) {
          case (.hevc, 32): newVPS = bytes
          case (.hevc, 33), (.avc, 7): newSPS = bytes
          default: newPPS = bytes
          }
        } else if PocketVideoAnnexB.isVCL(t, codec: codec) {
          slices.append(nal.range)
          if PocketVideoAnnexB.isRandomAccess(t, codec: codec) { randomAccess = true }
        }
        // AUD, SEI (incl. DJI metadata), DJI marker (63) and filler are not decoded.
      }
    }

    var changed = false
    if let v = newVPS, v != vps { vps = v; changed = true }
    if let s = newSPS, s != sps { sps = s; changed = true }
    if let p = newPPS, p != pps { pps = p; changed = true }
    if changed || format == nil, let built = makeFormat(codec: codec) {
      format = built
      sessionAttemptFailed = false
      if let session, !VTDecompressionSessionCanAcceptFormatDescription(session, formatDescription: built) {
        tearDownSession()
      }
    }
    guard let format, !slices.isEmpty else { return }
    if session == nil {
      guard !sessionAttemptFailed else { return }
      openSession(format: format)
      awaitingKeyframe = true
      guard session != nil else { return }
    }
    if awaitingKeyframe {
      guard randomAccess else {
        noteDropped()
        return
      }
      awaitingKeyframe = false
    }
    guard let sample = makeSample(data: data, slices: slices, format: format, pts: pts) else {
      noteDropped()
      return
    }
    decode(sample)
  }

  private func makeFormat(codec: PocketVideoCodec) -> CMVideoFormatDescription? {
    var fmt: CMFormatDescription?
    switch codec {
    case .hevc:
      guard let vps, let sps, let pps else { return nil }
      let sets = [vps, sps, pps]
      let status = withParameterSets(sets) { pointers, sizes in
        CMVideoFormatDescriptionCreateFromHEVCParameterSets(
          allocator: kCFAllocatorDefault, parameterSetCount: 3, parameterSetPointers: pointers,
          parameterSetSizes: sizes, nalUnitHeaderLength: 4, extensions: nil, formatDescriptionOut: &fmt)
      }
      return status == noErr ? fmt : nil
    case .avc:
      guard let sps, let pps else { return nil }
      let status = withParameterSets([sps, pps]) { pointers, sizes in
        CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: kCFAllocatorDefault, parameterSetCount: 2, parameterSetPointers: pointers,
          parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &fmt)
      }
      return status == noErr ? fmt : nil
    }
  }

  /// Keeps every parameter set's bytes pinned while CoreMedia reads them.
  private func withParameterSets(
    _ sets: [Data], _ body: ([UnsafePointer<UInt8>], [Int]) -> OSStatus
  ) -> OSStatus {
    let copies = sets.map { [UInt8]($0) }
    let pointers = copies.map { bytes -> UnsafeMutablePointer<UInt8> in
      let p = UnsafeMutablePointer<UInt8>.allocate(capacity: max(bytes.count, 1))
      p.initialize(from: bytes, count: bytes.count)
      return p
    }
    defer { zip(pointers, copies).forEach { $0.0.deallocate() } }
    return body(pointers.map { UnsafePointer($0) }, copies.map(\.count))
  }

  private func openSession(format: CMVideoFormatDescription) {
    // 8-bit 420v first: every consumer (Metal ingest, snapshot, scope) handles it, and it is the
    // format upstream found reliable. 10-bit and BGRA are fallbacks.
    let ladder: [OSType?] = [
      kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
      kCVPixelFormatType_32BGRA,
      nil,
    ]
    for pixelFormat in ladder {
      var attrs: [String: Any] = [
        kCVPixelBufferMetalCompatibilityKey as String: true,
        kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
      ]
      if let pixelFormat { attrs[kCVPixelBufferPixelFormatTypeKey as String] = Int(pixelFormat) }
      var created: VTDecompressionSession?
      let status = VTDecompressionSessionCreate(
        allocator: kCFAllocatorDefault, formatDescription: format, decoderSpecification: nil,
        imageBufferAttributes: attrs as CFDictionary, outputCallback: nil,
        decompressionSessionOut: &created)
      if status == noErr, let created {
        VTSessionSetProperty(created, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        session = created
        return
      }
      NSLog("[PocketVideo] VTDecompressionSessionCreate(\(pixelFormat.map { "\($0)" } ?? "native")) failed \(status)")
    }
    sessionAttemptFailed = true
  }

  private func tearDownSession() {
    if let session {
      VTDecompressionSessionWaitForAsynchronousFrames(session)
      VTDecompressionSessionInvalidate(session)
    }
    session = nil
    awaitingKeyframe = true
  }

  private func makeSample(data: Data, slices: [Range<Int>], format: CMVideoFormatDescription, pts: Int64)
    -> CMSampleBuffer?
  {
    // AVCC: 4-byte big-endian length before each slice NAL.
    let total = slices.reduce(0) { $0 + 4 + $1.count }
    var block: CMBlockBuffer?
    guard
      CMBlockBufferCreateWithMemoryBlock(
        allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: total,
        blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
        dataLength: total, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == kCMBlockBufferNoErr,
      let block
    else { return nil }
    var dataPointer: UnsafeMutablePointer<CChar>?
    guard
      CMBlockBufferGetDataPointer(
        block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: nil, dataPointerOut: &dataPointer)
        == kCMBlockBufferNoErr, let dataPointer
    else { return nil }
    let dst = UnsafeMutableRawPointer(dataPointer)
    data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      var o = 0
      for r in slices {
        let n = UInt32(r.count).bigEndian
        withUnsafeBytes(of: n) { dst.advanced(by: o).copyMemory(from: $0.baseAddress!, byteCount: 4) }
        dst.advanced(by: o + 4).copyMemory(from: base.advanced(by: r.lowerBound), byteCount: r.count)
        o += 4 + r.count
      }
    }
    var timing = CMSampleTimingInfo(
      duration: .invalid,
      presentationTimeStamp: CMTime(value: pts, timescale: 1_000_000),
      decodeTimeStamp: .invalid)
    var size = total
    var sample: CMSampleBuffer?
    guard
      CMSampleBufferCreateReady(
        allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format, sampleCount: 1,
        sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 1,
        sampleSizeArray: &size, sampleBufferOut: &sample) == noErr
    else { return nil }
    return sample
  }

  private func decode(_ sample: CMSampleBuffer) {
    guard let session else { return }
    var info = VTDecodeInfoFlags()
    // Synchronous decode (no async flag) on our serial queue: lowest latency, natural back-pressure.
    let status = VTDecompressionSessionDecodeFrame(
      session, sampleBuffer: sample, flags: [._1xRealTimePlayback], infoFlagsOut: &info
    ) { [weak self] status, flags, imageBuffer, _, _ in
      guard let self else { return }
      if status != noErr || flags.contains(.frameDropped) {
        self.handleDecodeError(status)
        return
      }
      guard let imageBuffer, CVPixelBufferGetWidth(imageBuffer) > 1, CVPixelBufferGetHeight(imageBuffer) > 1 else {
        self.noteDropped()
        return
      }
      self.publish(imageBuffer)
    }
    if status != noErr { handleDecodeError(status) }
  }

  /// May run on a VideoToolbox thread.
  private func handleDecodeError(_ status: OSStatus) {
    noteDropped()
    switch status {
    case kVTInvalidSessionErr:
      // Backgrounding or a media-server reset killed the session: rebuild, wait for an IRAP.
      decodeQueue.async { [self] in tearDownSession() }
    case kVTVideoDecoderBadDataErr, kVTVideoDecoderMalfunctionErr:
      decodeQueue.async { [self] in awaitingKeyframe = true }
    default:
      break
    }
  }

  private func publish(_ buffer: CVPixelBuffer) {
    lock.lock()
    defer { lock.unlock() }
    guard !closed else { return }
    sequence += 1
    decodedTotal += 1
    latest = PocketVideoFrame(pixelBuffer: buffer, sequence: sequence, arrivedAt: CACurrentMediaTime())
  }

  private func noteDropped() {
    lock.lock()
    droppedTotal += 1
    lock.unlock()
  }
}
