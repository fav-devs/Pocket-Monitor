import ExpoModulesCore
import MetalKit
import QuartzCore
import UIKit

/// `PocketVideoView` (VideoViewProps): the decoded live picture with every PictureEffects field
/// applied on the GPU, or a procedural demo scene when `sessionId` is null.
///
/// Present policy: an MTKView display link (main thread, up to 60 Hz) draws only when the
/// session holds a newer frame than the one on screen — latest wins, intermediate frames are
/// counted as dropped — or when props changed. Demo scenes animate at 30 Hz.
public final class PocketVideoView: ExpoView, MTKViewDelegate {
  let onFrameStats = EventDispatcher()

  private let metal = PocketVideoMetal.shared
  private let mtkView: MTKView
  private var renderer: PocketVideoRenderer?

  private var session: PocketVideoSession?
  private(set) var sessionId: String?
  private var demoScene: Int?
  private var effects = PocketPictureEffects()
  private var fill = false
  private var dirty = true

  private var lastSequence: UInt64 = 0
  private var lastDemoDraw: CFTimeInterval = 0
  private var demoEpoch = CACurrentMediaTime()
  private var lastSize = (width: 0, height: 0)

  // ~1 Hz stats window
  private var windowStart = CACurrentMediaTime()
  private var presentedInWindow = 0
  private var decodedAtWindowStart: UInt64 = 0
  private var superseded: UInt64 = 0

  public required init(appContext: AppContext? = nil) {
    mtkView = MTKView(frame: .zero, device: PocketVideoMetal.shared?.device)
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    mtkView.colorPixelFormat = PocketVideoMetal.outputFormat
    mtkView.framebufferOnly = true
    mtkView.isOpaque = true
    mtkView.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
    mtkView.preferredFramesPerSecond = 60
    mtkView.enableSetNeedsDisplay = false
    mtkView.isPaused = false
    mtkView.autoResizeDrawable = true
    mtkView.delegate = self
    mtkView.frame = bounds
    mtkView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(mtkView)
    if let metal { renderer = PocketVideoRenderer(metal: metal) }
  }

  deinit {
    if let session { PocketVideoSessionHub.shared.release(session) }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    mtkView.frame = bounds
    dirty = true
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    // Stop the display link while off screen; resume (and redraw) when back.
    mtkView.isPaused = window == nil
    dirty = true
  }

  // MARK: Props (main thread)

  func setSessionId(_ id: String?) {
    guard id != sessionId else { return }
    if let session { PocketVideoSessionHub.shared.release(session) }
    sessionId = id
    session = id.map { PocketVideoSessionHub.shared.acquire($0) }
    lastSequence = 0
    superseded = 0
    decodedAtWindowStart = session?.counters().decoded ?? 0
    dirty = true
  }

  func setDemoScene(_ scene: String?) {
    demoScene = PocketVideoSource.demoScene(scene)
    demoEpoch = CACurrentMediaTime()
    dirty = true
  }

  func setEffects(_ dict: [String: Any]?) {
    let parsed = PocketPictureEffects.parse(dict)
    if parsed != effects {
      effects = parsed
      dirty = true
    }
  }

  func setResizeMode(_ mode: String?) {
    let next = mode == "fill"
    if next != fill {
      fill = next
      dirty = true
    }
  }

  // MARK: MTKViewDelegate

  public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
    dirty = true
  }

  public func draw(in view: MTKView) {
    let now = CACurrentMediaTime()
    defer { emitStatsIfDue(now) }
    guard let metal, let renderer else { return }

    let source: PocketVideoSource?
    if let session {
      if let frame = session.latestFrame() {
        if frame.sequence == lastSequence && !dirty { return }
        if lastSequence > 0, frame.sequence > lastSequence + 1 { superseded += frame.sequence - lastSequence - 1 }
        lastSequence = frame.sequence
        source = .frame(frame)
      } else {
        source = nil
      }
    } else if let demoScene {
      if !dirty && now - lastDemoDraw < 1.0 / 30.0 { return }
      lastDemoDraw = now
      source = .demo(scene: demoScene, time: now - demoEpoch, transfer: effects.sourceColor)
    } else {
      source = nil
    }
    if source == nil && !dirty { return }
    dirty = false

    guard let drawable = view.currentDrawable, let pass = view.currentRenderPassDescriptor,
      let cb = metal.queue.makeCommandBuffer()
    else { return }
    cb.label = "pocket.video.view"
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
    var keep: [AnyObject] = []
    if let source, let signal = renderer.encodeIngest(cb, source: source, keepAlive: &keep) {
      let (sw, sh) = source.size
      lastSize = (sw, sh)
      let lut = PocketVideoLutRegistry.shared.lut(effects.lutId)
      let drawableSize = view.drawableSize
      let uniforms = PocketVideoFxUniforms.make(
        effects: effects, lut: lut, sourceWidth: sw, sourceHeight: sh,
        viewWidth: Double(drawableSize.width), viewHeight: Double(drawableSize.height),
        contentScale: Double(view.contentScaleFactor), fill: fill)
      renderer.encodePicture(cb, pass: pass, signal: signal, effects: effects, lut: lut, uniforms: uniforms)
      session?.lastEffects = effects
      presentedInWindow += 1
    } else if let enc = cb.makeRenderCommandEncoder(descriptor: pass) {
      enc.endEncoding()  // clear to black
    }
    cb.present(drawable)
    cb.addCompletedHandler { _ in _ = keep }
    cb.commit()
  }

  private func emitStatsIfDue(_ now: CFTimeInterval) {
    let elapsed = now - windowStart
    guard elapsed >= 1 else { return }
    let counters = session?.counters() ?? (decoded: 0, dropped: 0)
    let decodedFps = Double(counters.decoded &- decodedAtWindowStart) / elapsed
    let presentedFps = Double(presentedInWindow) / elapsed
    var age = -1.0
    if let frame = session?.latestFrame() { age = (now - frame.arrivedAt) * 1000 }
    windowStart = now
    presentedInWindow = 0
    decodedAtWindowStart = counters.decoded
    onFrameStats([
      "width": lastSize.width,
      "height": lastSize.height,
      "presentedFps": (presentedFps * 10).rounded() / 10,
      "decodedFps": session == nil ? 0 : (decodedFps * 10).rounded() / 10,
      "droppedFrames": Double(counters.dropped + superseded),
      "lastFrameAgeMs": age < 0 ? -1 : age.rounded(),
    ])
  }
}
