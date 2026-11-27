import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import QuartzCore
import VideoToolbox
import Vision

/// Reads hands (and faces when asked) with Apple Vision.
///
/// Sources:
/// - `cameraFeed`: a timer on this reader's own queue takes the decoder's latest picture
///   (`PocketVideoSession.latestFrame()`) at `rate`, skips one already read, scales it to `width`
///   across into a BGRA buffer of its own (`VTPixelTransferSession`, so the decoder's pool buffer
///   is let go at once), and runs `VNDetectHumanHandPoseRequest`. Nothing here touches the views'
///   render loop or the decoder queue; a timer tick that comes while Vision is busy is merged by
///   the dispatch source, so a busy reader drops frames instead of queueing them.
/// - `frontCamera`: an `AVCaptureSession` on the front camera (640×480, 15 fps where the format
///   allows, late frames discarded), upright through `AVCaptureDevice.RotationCoordinator`, never
///   mirrored, delivering on the same queue.
///
/// Landmarks come out in MediaPipe's order and picture fractions (origin top-left), so the
/// TypeScript port of the desktop's rules reads them unchanged. Handedness: Vision's `chirality`
/// is the hand's own side; MediaPipe's label (which the desktop and Android use) assumes a mirrored
/// picture, so on these unmirrored pictures `right` is Vision's `.left`. VERIFY on a device: raise
/// the right hand and compare the hand view's role with Android / the desktop (Stick hand swaps it).
final class PocketHandsReader: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
  var onSeen: ((PocketHandsSeenEvent) -> Void)?
  var onStatus: ((PocketHandsStatusEvent) -> Void)?

  /// Faces are looked for at most this often while wanted.
  private static let faceInterval: CFTimeInterval = 0.25
  /// MediaPipe's landmark order.
  private static let joints: [VNHumanHandPoseObservation.JointName] = [
    .wrist,
    .thumbCMC, .thumbMP, .thumbIP, .thumbTip,
    .indexMCP, .indexPIP, .indexDIP, .indexTip,
    .middleMCP, .middlePIP, .middleDIP, .middleTip,
    .ringMCP, .ringPIP, .ringDIP, .ringTip,
    .littleMCP, .littlePIP, .littleDIP, .littleTip,
  ]
  private static let rightFromChirality: VNChirality = .left

  private let queue = DispatchQueue(label: "pocket.hands", qos: .userInitiated)

  // ---- queue-confined ----
  private var running = false
  private var source = "cameraFeed"
  private var sessionId: String?
  private var interval: CFTimeInterval = 1.0 / 15.0
  private var width = 480
  private var timer: DispatchSourceTimer?
  private var lastSequence: UInt64 = 0
  private var lastOffer: CFTimeInterval = 0
  private var wantsFaces = false
  private var lastFaceAsk: CFTimeInterval = 0
  private var transfer: VTPixelTransferSession?
  private var pool: CVPixelBufferPool?
  private var poolSize = (0, 0)
  private var capture: AVCaptureSession?
  private var rotation: AVCaptureDevice.RotationCoordinator?
  private var rotationObservation: NSKeyValueObservation?
  private var captureConnection: AVCaptureConnection?
  private lazy var handRequest: VNDetectHumanHandPoseRequest = {
    let request = VNDetectHumanHandPoseRequest()
    request.maximumHandCount = 2
    return request
  }()
  private lazy var faceRequest = VNDetectFaceRectanglesRequest()

  /// Starts (or switches) the source. Returns why not, or nil once running.
  func start(_ options: PocketHandsStartOptions) async -> String? {
    let front = options.source == "frontCamera"
    if front {
      switch AVCaptureDevice.authorizationStatus(for: .video) {
      case .authorized: break
      case .notDetermined:
        if !(await AVCaptureDevice.requestAccess(for: .video)) { return "camera access is off" }
      default: return "camera access is off"
      }
    } else if options.sessionId == nil {
      return "no picture to read"
    }
    return await withCheckedContinuation { continuation in
      queue.async { [self] in
        teardown()
        running = true
        source = front ? "frontCamera" : "cameraFeed"
        sessionId = options.sessionId
        interval = 1.0 / max(1, min(20, options.rate))
        width = max(160, min(960, options.width))
        lastSequence = 0
        lastOffer = 0
        lastFaceAsk = 0
        emitStatus("starting", provider: nil, error: nil)
        let error = front ? startFrontCamera() : startFeedTimer()
        if let error {
          teardown()
          emitStatus("failed", provider: nil, error: error)
        } else {
          emitStatus("ready", provider: "Vision", error: nil)
        }
        continuation.resume(returning: error)
      }
    }
  }

  func stop() {
    queue.async { [self] in
      let was = running
      teardown()
      if was { emitStatus("stopped", provider: nil, error: nil) }
    }
  }

  func setWantsFaces(_ on: Bool) {
    queue.async { [self] in wantsFaces = on }
  }

  // MARK: - Sources (queue)

  private func startFeedTimer() -> String? {
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now(), repeating: interval, leeway: .milliseconds(5))
    t.setEventHandler { [weak self] in self?.offerFeedFrame() }
    t.resume()
    timer = t
    return nil
  }

  private func offerFeedFrame() {
    guard running, source == "cameraFeed", let id = sessionId else { return }
    // Hold the decoder's buffer only while copying it small.
    let small = autoreleasepool { () -> CVPixelBuffer? in
      guard let session = PocketVideoSessionHub.shared.existing(id), let frame = session.latestFrame(), frame.sequence != lastSequence else {
        return nil
      }
      lastSequence = frame.sequence
      return scaled(frame.pixelBuffer)
    }
    guard let small else { return }
    analyse(small)
  }

  private func startFrontCamera() -> String? {
    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else {
      return "this phone has no front camera"
    }
    let session = AVCaptureSession()
    session.beginConfiguration()
    if session.canSetSessionPreset(.vga640x480) { session.sessionPreset = .vga640x480 }
    guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
      session.commitConfiguration()
      return "the front camera is busy"
    }
    session.addInput(input)
    let output = AVCaptureVideoDataOutput()
    output.alwaysDiscardsLateVideoFrames = true
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
    output.setSampleBufferDelegate(self, queue: queue)
    guard session.canAddOutput(output) else {
      session.commitConfiguration()
      return "the front camera is busy"
    }
    session.addOutput(output)
    let connection = output.connection(with: .video)
    if let connection, connection.isVideoMirroringSupported {
      connection.automaticallyAdjustsVideoMirroring = false
      connection.isVideoMirrored = false
    }
    session.commitConfiguration()
    // 15 pictures a second is all the reader takes; ask the sensor for no more.
    if (try? device.lockForConfiguration()) != nil {
      let fifteen = device.activeFormat.videoSupportedFrameRateRanges.contains { $0.minFrameRate <= 15 && 15 <= $0.maxFrameRate }
      if fifteen {
        device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 15)
      }
      device.unlockForConfiguration()
    }
    // Keep the picture upright as the phone turns on its stand.
    let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: nil)
    captureConnection = connection
    applyRotation(coordinator.videoRotationAngleForHorizonLevelCapture)
    rotationObservation = coordinator.observe(\.videoRotationAngleForHorizonLevelCapture, options: [.new]) { [weak self] coordinator, _ in
      let angle = coordinator.videoRotationAngleForHorizonLevelCapture
      self?.queue.async { self?.applyRotation(angle) }
    }
    rotation = coordinator
    capture = session
    session.startRunning()
    return session.isRunning ? nil : "the front camera did not start"
  }

  private func applyRotation(_ angle: CGFloat) {
    guard let connection = captureConnection, connection.isVideoRotationAngleSupported(angle) else { return }
    connection.videoRotationAngle = angle
  }

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    guard running, source == "frontCamera" else { return }
    let now = CACurrentMediaTime()
    guard now - lastOffer >= interval * 0.9, let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    lastOffer = now
    analyse(buffer)
  }

  private func teardown() {
    running = false
    timer?.cancel()
    timer = nil
    rotationObservation?.invalidate()
    rotationObservation = nil
    rotation = nil
    captureConnection = nil
    if let capture {
      capture.stopRunning()
      for output in capture.outputs { (output as? AVCaptureVideoDataOutput)?.setSampleBufferDelegate(nil, queue: nil) }
    }
    capture = nil
    if let transfer { VTPixelTransferSessionInvalidate(transfer) }
    transfer = nil
    pool = nil
    poolSize = (0, 0)
  }

  // MARK: - Reading (queue)

  /// The decoder's picture, `width` across in proportion, as BGRA in a buffer of our own.
  private func scaled(_ source: CVPixelBuffer) -> CVPixelBuffer? {
    let sw = CVPixelBufferGetWidth(source)
    let sh = CVPixelBufferGetHeight(source)
    guard sw > 8, sh > 8 else { return nil }
    let w = min(width, sw) & ~1
    let h = max(2, Int((Double(sh) * Double(w) / Double(sw)).rounded()) & ~1)
    if pool == nil || poolSize != (w, h) {
      let attributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: w,
        kCVPixelBufferHeightKey as String: h,
        kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
      ]
      var created: CVPixelBufferPool?
      CVPixelBufferPoolCreate(nil, [kCVPixelBufferPoolMinimumBufferCountKey as String: 2] as CFDictionary, attributes as CFDictionary, &created)
      pool = created
      poolSize = (w, h)
    }
    if transfer == nil {
      var session: VTPixelTransferSession?
      VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &session)
      transfer = session
    }
    guard let pool, let transfer else { return nil }
    var out: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out) == kCVReturnSuccess, let out else { return nil }
    return VTPixelTransferSessionTransferImage(transfer, from: source, to: out) == noErr ? out : nil
  }

  private func analyse(_ buffer: CVPixelBuffer) {
    let started = CACurrentMediaTime()
    let askFaces = wantsFaces && started - lastFaceAsk >= Self.faceInterval
    var requests: [VNRequest] = [handRequest]
    if askFaces {
      requests.append(faceRequest)
      lastFaceAsk = started
    }
    let handler = VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .up, options: [:])
    do {
      try handler.perform(requests)
    } catch {
      return
    }
    let ms = (CACurrentMediaTime() - started) * 1000
    let w = Double(CVPixelBufferGetWidth(buffer))
    let h = Double(CVPixelBufferGetHeight(buffer))
    let hands = (handRequest.results ?? []).prefix(2).compactMap(Self.landmarks)
    var faces: [PocketHandsFace]?
    if askFaces {
      faces = (faceRequest.results ?? [])
        .sorted { $0.boundingBox.width * $0.boundingBox.height > $1.boundingBox.width * $1.boundingBox.height }
        .map { face in
          let box = face.boundingBox
          return PocketHandsFace(
            x: Double(box.minX), y: Double(1 - box.maxY), width: Double(box.width), height: Double(box.height),
            score: Double(face.confidence))
        }
    }
    onSeen?(PocketHandsSeenEvent(source: source, hands: hands, faces: faces, aspect: h > 0 ? w / h : 16.0 / 9.0, ms: ms))
  }

  /// One observation in MediaPipe's order; a hand with most joints unseen is dropped.
  private static func landmarks(_ observation: VNHumanHandPoseObservation) -> PocketHandsLandmarks? {
    guard let points = try? observation.recognizedPoints(.all) else { return nil }
    var flat: [Double] = []
    flat.reserveCapacity(joints.count * 2)
    var unsure = 0
    for joint in joints {
      guard let point = points[joint] else { return nil }
      if point.confidence < 0.1 { unsure += 1 }
      flat.append(Double(point.location.x))
      flat.append(Double(1 - point.location.y))
    }
    if unsure > 5 { return nil }
    return PocketHandsLandmarks(points: flat, score: Double(observation.confidence), right: observation.chirality == rightFromChirality)
  }

  private func emitStatus(_ state: String, provider: String?, error: String?) {
    onStatus?(PocketHandsStatusEvent(state: state, provider: provider, error: error))
  }
}
