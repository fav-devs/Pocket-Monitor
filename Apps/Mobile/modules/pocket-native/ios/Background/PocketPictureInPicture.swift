import AVFoundation
import AVKit
import CoreMedia
import CoreVideo
import QuartzCore
import UIKit

/// The PiP source: a view backed by an `AVSampleBufferDisplayLayer`. It is inserted *under* the
/// MTKView of the `PocketVideoView` that shows the same session, so the inline picture the system
/// animates from is where the operator sees the live picture.
final class PocketPipLayerView: UIView {
  override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
  var displayLayer: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }
}

/// Picture in Picture monitoring of the live feed.
///
/// `AVPictureInPictureController(contentSource: .init(sampleBufferDisplayLayer:playbackDelegate:))`
/// with decoded frames from `PocketVideoSession` (frame tap) enqueued as `CMSampleBuffer`s stamped
/// with host time and `DisplayImmediately`. The playback delegate reports a live stream (infinite
/// time range, never paused, linear playback), so the window shows no scrubber or skip buttons.
/// While the window is up the app keeps running (UIBackgroundModes `audio` + an active `.playback`
/// audio session), which keeps the datalink, the 40 Hz ACK pump and the JS session alive.
/// PiP shows the camera signal without monitoring effects (no LUT / display transform / mirror).
// VERIFY: auto-start (`canStartPictureInPictureAutomaticallyFromInline`) works with the source
// layer under the opaque MTKView, and the PiP button starts it from the live screen.
// VERIFY: VideoToolbox keeps decoding while backgrounded with PiP up (else every AU fails with
// kVTInvalidSessionErr and the window freezes); the MTKView's background draws only log GPU
// "background execution not permitted" errors and do not crash.
// VERIFY: 10 min of PiP over another app keeps the datalink admitted and the ACK pump at 40 Hz.
@MainActor
final class PocketPictureInPicture: NSObject {
  static let shared = PocketPictureInPicture()

  struct State: Equatable {
    var prepared = false
    var possible = false
    var active = false
  }

  /// Every state change (prepared / possible / active).
  var onState: ((State) -> Void)?
  /// PiP closed while the app is in the background (the operator dismissed the window).
  var onStoppedInBackground: (() -> Void)?

  private let feed = PocketPipFeed()
  private var controller: AVPictureInPictureController?
  private var possibleObservation: NSKeyValueObservation?
  private var view: PocketPipLayerView?
  private var sessionId: String?
  private var autoStart = true
  private var active = false
  private var lastState = State()
  private var audioConfigured = false

  static var isSupported: Bool { AVPictureInPictureController.isPictureInPictureSupported() }

  var isActive: Bool { active }

  // MARK: JS-facing

  /// Ready PiP for `sessionId` (idempotent; call again after the session id changes). Returns false
  /// when the device has no PiP.
  func prepare(sessionId: String) -> Bool {
    guard Self.isSupported else { return false }
    if self.sessionId != sessionId {
      feed.detach()
      feed.attach(sessionId: sessionId)
      self.sessionId = sessionId
    }
    configureAudioSession()
    let view = self.view ?? makeView()
    attachToHost(view)
    if controller == nil { makeController(view) }
    controller?.canStartPictureInPictureAutomaticallyFromInline = autoStart
    publishState()
    return true
  }

  /// Tear down PiP (leaving the live screen, disconnect).
  func release() {
    if let controller, controller.isPictureInPictureActive { controller.stopPictureInPicture() }
    possibleObservation = nil
    controller = nil
    feed.detach()
    feed.setRenderer(nil)
    view?.removeFromSuperview()
    view = nil
    sessionId = nil
    active = false
    deactivateAudioSession()
    publishState()
  }

  func setAutoStart(_ enabled: Bool) {
    autoStart = enabled
    controller?.canStartPictureInPictureAutomaticallyFromInline = enabled
  }

  /// Returns false when PiP is not possible right now.
  func start() -> Bool {
    guard let controller else { return false }
    if let view, view.window == nil { attachToHost(view) }
    guard controller.isPictureInPicturePossible else { return false }
    controller.startPictureInPicture()
    return true
  }

  func stop() {
    controller?.stopPictureInPicture()
  }

  /// Re-attach the source view before the app leaves the foreground: the live picture view may have
  /// been re-created since `prepare` (orientation, navigation), and PiP only auto-starts from a layer
  /// in the window.
  func willResignActive() {
    guard let view, sessionId != nil else { return }
    attachToHost(view)
  }

  // MARK: Setup

  private func makeView() -> PocketPipLayerView {
    let v = PocketPipLayerView(frame: .zero)
    v.isUserInteractionEnabled = false
    v.backgroundColor = .black
    v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    let layer = v.displayLayer
    layer.videoGravity = .resizeAspect
    layer.preventsDisplaySleepDuringVideoPlayback = false
    // Host-clock timebase at rate 1: samples are stamped with host time, so "now" is always current.
    var timebase: CMTimebase?
    if CMTimebaseCreateWithSourceClock(allocator: kCFAllocatorDefault, sourceClock: CMClockGetHostTimeClock(), timebaseOut: &timebase) == noErr,
      let timebase
    {
      CMTimebaseSetTime(timebase, time: CMClockGetTime(CMClockGetHostTimeClock()))
      CMTimebaseSetRate(timebase, rate: 1)
      layer.controlTimebase = timebase
    }
    feed.setRenderer(layer.sampleBufferRenderer)
    view = v
    return v
  }

  private func makeController(_ view: PocketPipLayerView) {
    let source = AVPictureInPictureController.ContentSource(sampleBufferDisplayLayer: view.displayLayer, playbackDelegate: self)
    let c = AVPictureInPictureController(contentSource: source)
    c.delegate = self
    c.requiresLinearPlayback = true
    c.canStartPictureInPictureAutomaticallyFromInline = autoStart
    possibleObservation = c.observe(\.isPictureInPicturePossible, options: [.new]) { [weak self] _, _ in
      Task { @MainActor in self?.publishState() }
    }
    controller = c
  }

  private func attachToHost(_ view: PocketPipLayerView) {
    if let id = sessionId, let host = Self.findVideoView(sessionId: id) {
      if view.superview !== host { host.insertSubview(view, at: 0) }
      view.frame = host.bounds
      return
    }
    // VERIFY: fallback when no PocketVideoView shows this session (e.g. a sheet covers the live
    // screen's window): a 2 pt layer at the bottom of the key window. PiP may refuse to start from it.
    guard let window = Self.keyWindow() else { return }
    if view.superview !== window { window.insertSubview(view, at: 0) }
    view.frame = CGRect(x: 0, y: 0, width: 2, height: 2)
  }

  private static func keyWindow() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
  }

  private static func findVideoView(sessionId: String) -> PocketVideoView? {
    for scene in UIApplication.shared.connectedScenes {
      guard let windowScene = scene as? UIWindowScene else { continue }
      for window in windowScene.windows {
        if let found = search(window, sessionId) { return found }
      }
    }
    return nil
  }

  private static func search(_ view: UIView, _ sessionId: String) -> PocketVideoView? {
    if let video = view as? PocketVideoView, video.sessionId == sessionId, video.window != nil { return video }
    for sub in view.subviews {
      if let found = search(sub, sessionId) { return found }
    }
    return nil
  }

  // VERIFY: `.playback` + `.mixWithOthers` is enough for PiP to start and for the app to keep
  // running while the window is up (the feed has no audio track; nothing is played).
  private func configureAudioSession() {
    guard !audioConfigured else { return }
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .moviePlayback, options: [.mixWithOthers])
      try session.setActive(true)
      audioConfigured = true
    } catch {
      NSLog("[PocketBackground] audio session for PiP failed: \(error)")
    }
  }

  private func deactivateAudioSession() {
    guard audioConfigured else { return }
    audioConfigured = false
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
  }

  private func publishState() {
    let next = State(
      prepared: controller != nil,
      possible: controller?.isPictureInPicturePossible ?? false,
      active: active)
    guard next != lastState else { return }
    lastState = next
    onState?(next)
  }
}

// MARK: - AVPictureInPictureControllerDelegate

extension PocketPictureInPicture: AVPictureInPictureControllerDelegate {
  nonisolated func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
    Task { @MainActor in
      self.active = true
      self.feed.setFullRate(true)
      self.publishState()
      PocketBackgroundGrace.shared.pictureInPictureStarted()
    }
  }

  nonisolated func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
    Task { @MainActor in
      self.active = false
      self.feed.setFullRate(false)
      self.publishState()
      if UIApplication.shared.applicationState == .background { self.onStoppedInBackground?() }
    }
  }

  nonisolated func pictureInPictureController(
    _ pictureInPictureController: AVPictureInPictureController,
    failedToStartPictureInPictureWithError error: Error
  ) {
    NSLog("[PocketBackground] PiP failed to start: \(error)")
    Task { @MainActor in
      self.active = false
      self.publishState()
    }
  }

  nonisolated func pictureInPictureController(
    _ pictureInPictureController: AVPictureInPictureController,
    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
  ) {
    // The live screen is still mounted underneath; nothing to restore.
    completionHandler(true)
  }
}

// MARK: - AVPictureInPictureSampleBufferPlaybackDelegate (a live stream)

extension PocketPictureInPicture: AVPictureInPictureSampleBufferPlaybackDelegate {
  nonisolated func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, setPlaying playing: Bool) {
    // Live monitoring cannot pause; the play/pause control is hidden by requiresLinearPlayback.
  }

  nonisolated func pictureInPictureControllerTimeRangeForPlayback(_ pictureInPictureController: AVPictureInPictureController) -> CMTimeRange {
    CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity)
  }

  nonisolated func pictureInPictureControllerIsPlaybackPaused(_ pictureInPictureController: AVPictureInPictureController) -> Bool {
    false
  }

  nonisolated func pictureInPictureController(
    _ pictureInPictureController: AVPictureInPictureController,
    didTransitionToRenderSize newRenderSize: CMVideoDimensions
  ) {}

  nonisolated func pictureInPictureController(
    _ pictureInPictureController: AVPictureInPictureController,
    skipByInterval skipInterval: CMTime,
    completion completionHandler: @escaping () -> Void
  ) {
    completionHandler()
  }
}

// MARK: - Frame feed (decoder thread → feed queue → display layer)

/// Takes decoded frames from the `PocketVideoSession` frame tap and enqueues them on the display
/// layer's renderer. Inline (PiP not showing) it feeds ≤15 Hz: the layer only has to be current when
/// PiP starts, and the MTKView above it is what the operator sees. In PiP it feeds every frame.
final class PocketPipFeed: @unchecked Sendable {
  private let lock = NSLock()
  private let queue = DispatchQueue(label: "pocket.background.pip", qos: .userInteractive)

  // lock-protected
  private var session: PocketVideoSession?
  private var tapId: UUID?
  private var renderer: AVSampleBufferVideoRenderer?
  private var fullRate = false
  private var lastEnqueue: CFTimeInterval = 0
  private var inFlight = 0

  // queue-confined
  private var format: CMVideoFormatDescription?

  func attach(sessionId: String) {
    let session = PocketVideoSessionHub.shared.acquire(sessionId)
    let id = session.addFrameTap { [weak self] buffer in self?.receive(buffer) }
    lock.lock()
    self.session = session
    tapId = id
    lock.unlock()
  }

  func detach() {
    lock.lock()
    let session = self.session
    let id = tapId
    self.session = nil
    tapId = nil
    let renderer = self.renderer
    lock.unlock()
    guard let session else { return }
    if let id { session.removeFrameTap(id) }
    PocketVideoSessionHub.shared.release(session)
    queue.async { renderer?.flush() }
  }

  func setRenderer(_ renderer: AVSampleBufferVideoRenderer?) {
    lock.lock()
    self.renderer = renderer
    lock.unlock()
  }

  func setFullRate(_ on: Bool) {
    lock.lock()
    fullRate = on
    lock.unlock()
  }

  /// Decoder thread. Never blocks: at most two frames in flight, the rest are skipped.
  private func receive(_ buffer: CVPixelBuffer) {
    let now = CACurrentMediaTime()
    lock.lock()
    guard let renderer, inFlight < 2, fullRate || now - lastEnqueue >= 1.0 / 15.0 else {
      lock.unlock()
      return
    }
    inFlight += 1
    lastEnqueue = now
    lock.unlock()
    queue.async { [self] in
      enqueue(buffer, on: renderer)
      lock.lock()
      inFlight -= 1
      lock.unlock()
    }
  }

  private func enqueue(_ buffer: CVPixelBuffer, on renderer: AVSampleBufferVideoRenderer) {
    // VERIFY: after background/foreground the renderer reports `requiresFlushToResumeDecoding`;
    // a flush here brings the PiP picture back without a black frame.
    if renderer.status == .failed || renderer.requiresFlushToResumeDecoding { renderer.flush() }
    if format.map({ !CMVideoFormatDescriptionMatchesImageBuffer($0, imageBuffer: buffer) }) ?? true {
      var created: CMVideoFormatDescription?
      guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescriptionOut: &created) == noErr,
        let created
      else { return }
      format = created
    }
    guard let format else { return }
    var timing = CMSampleTimingInfo(
      duration: .invalid,
      presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
      decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    guard
      CMSampleBufferCreateReadyWithImageBuffer(
        allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescription: format,
        sampleTiming: &timing, sampleBufferOut: &sample) == noErr,
      let sample
    else { return }
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true), CFArrayGetCount(attachments) > 0 {
      let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
      CFDictionarySetValue(
        dict,
        Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
        Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
    }
    guard renderer.isReadyForMoreMediaData else { return }
    renderer.enqueue(sample)
  }
}
