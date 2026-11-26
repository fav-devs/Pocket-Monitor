import ExpoModulesCore
import MetalKit
import QuartzCore
import UIKit

/// `PocketScopeView` (ScopeViewProps): waveform (luma / rgb), parade, histogram (luma / rgb) and
/// vectorscope (zoom 1 / 2), computed on the GPU from the same decoded frame the picture uses.
///
/// Per update (≤ 20 Hz, only when a new frame arrived or props changed):
/// ingest → measure pass (≤ 256 px wide; signal, or graded picture when `measureAfterLut`)
/// → clear bins → `pocket_scope_accumulate` (atomics) → `pocket_scope_reduce` (peak) → draw.
public final class PocketScopeView: ExpoView, MTKViewDelegate {
  private static let binsLength = (4 * 65536 + 16) * MemoryLayout<UInt32>.stride
  private static let measureWidth = 256

  private let metal = PocketVideoMetal.shared
  private let mtkView: MTKView
  private var renderer: PocketVideoRenderer?
  private var bins: MTLBuffer?
  private var measureTarget: MTLTexture?

  private var session: PocketVideoSession?
  private var sessionId: String?
  private var demoScene: Int?
  private var kind: Int32 = 0  // 0 waveform, 1 parade, 2 histogram, 3 vectorscope
  private var rgbMode = false
  private var zoom: Float = 1
  private var brightness: Float = 0.8
  private var measureAfterLut = false
  private var effects = PocketPictureEffects()
  private var dirty = true
  private var lastSequence: UInt64 = 0
  private var lastDraw: CFTimeInterval = 0
  private var demoEpoch = CACurrentMediaTime()

  public required init(appContext: AppContext? = nil) {
    mtkView = MTKView(frame: .zero, device: PocketVideoMetal.shared?.device)
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .clear
    mtkView.colorPixelFormat = PocketVideoMetal.outputFormat
    mtkView.framebufferOnly = true
    mtkView.isOpaque = false
    mtkView.layer.isOpaque = false
    mtkView.backgroundColor = .clear
    mtkView.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
    mtkView.preferredFramesPerSecond = 30
    mtkView.enableSetNeedsDisplay = false
    mtkView.isPaused = false
    mtkView.delegate = self
    mtkView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(mtkView)
    if let metal {
      renderer = PocketVideoRenderer(metal: metal)
      bins = metal.device.makeBuffer(length: Self.binsLength, options: .storageModePrivate)
    }
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
    mtkView.isPaused = window == nil
    dirty = true
  }

  // MARK: Props

  func setSessionId(_ id: String?) {
    guard id != sessionId else { return }
    if let session { PocketVideoSessionHub.shared.release(session) }
    sessionId = id
    session = id.map { PocketVideoSessionHub.shared.acquire($0) }
    lastSequence = 0
    dirty = true
  }

  func setDemoScene(_ scene: String?) {
    demoScene = PocketVideoSource.demoScene(scene)
    dirty = true
  }

  func setKind(_ value: String?) {
    switch value {
    case "parade": kind = 1
    case "histogram": kind = 2
    case "vectorscope": kind = 3
    default: kind = 0
    }
    dirty = true
  }

  func setOptions(_ options: [String: Any]?) {
    rgbMode = (options?["mode"] as? String) == "rgb"
    if let z = options?["zoom"] as? NSNumber { zoom = max(1, min(4, z.floatValue)) } else { zoom = 1 }
    dirty = true
  }

  func setBrightness(_ value: Double?) {
    brightness = Float(max(0, min(1, value ?? 0.8)))
    dirty = true
  }

  func setMeasureAfterLut(_ value: Bool?) {
    measureAfterLut = value ?? false
    dirty = true
  }

  func setEffects(_ dict: [String: Any]?) {
    effects = PocketPictureEffects.parse(dict)
    dirty = true
  }

  // MARK: MTKViewDelegate

  public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
    dirty = true
  }

  public func draw(in view: MTKView) {
    guard let metal, let renderer, let bins else { return }
    let now = CACurrentMediaTime()
    if now - lastDraw < 1.0 / 20.0 && !dirty { return }

    let source: PocketVideoSource
    if let session {
      guard let frame = session.latestFrame(), frame.sequence != lastSequence || dirty else { return }
      lastSequence = frame.sequence
      source = .frame(frame)
    } else if let demoScene {
      source = .demo(scene: demoScene, time: now - demoEpoch, transfer: effects.sourceColor)
    } else {
      if dirty, let drawable = view.currentDrawable, let pass = view.currentRenderPassDescriptor,
        let cb = metal.queue.makeCommandBuffer(), let enc = cb.makeRenderCommandEncoder(descriptor: pass)
      {
        enc.endEncoding()
        cb.present(drawable)
        cb.commit()
      }
      dirty = false
      return
    }
    dirty = false
    lastDraw = now

    guard let drawable = view.currentDrawable, let pass = view.currentRenderPassDescriptor,
      let cb = metal.queue.makeCommandBuffer()
    else { return }
    cb.label = "pocket.scope"
    var keep: [AnyObject] = []
    guard let signal = renderer.encodeIngest(cb, source: source, keepAlive: &keep) else { return }
    let (sw, sh) = source.size
    let mw = Self.measureWidth
    let mh = max(16, min(256, Int((Double(mw) * Double(sh) / Double(max(sw, 1))).rounded())))
    if measureTarget?.width != mw || measureTarget?.height != mh {
      measureTarget = metal.makeTarget(width: mw, height: mh, format: PocketVideoMetal.signalFormat)
    }
    guard let measureTarget else { return }
    let lut = PocketVideoLutRegistry.shared.lut(effects.lutId)
    let uniforms = PocketVideoFxUniforms.whole(effects: effects, lut: lut, sourceWidth: sw, sourceHeight: sh)
    renderer.encodeMeasure(cb, signal: signal, target: measureTarget, afterLut: measureAfterLut, lut: lut, uniforms: uniforms)

    // Axis: the signal's own transfer, or Rec.709 once graded.
    let axis: PocketVideoTransfer = measureAfterLut ? .rec709 : effects.sourceColor
    let weights = measureAfterLut ? PocketVideoTransfer.rec709.lumaWeights : axis.lumaWeights
    let drawableSize = view.drawableSize
    var params = [
      axis.anchors.vector,
      SIMD4<Float>(weights, 0),
      SIMD4<Float>(Float(kind), rgbMode ? 1 : 0, zoom, Float(mw)),
      SIMD4<Float>(brightness, Float(drawableSize.width), Float(drawableSize.height), 0),
    ]
    let paramsLength = params.count * MemoryLayout<SIMD4<Float>>.stride

    guard let blit = cb.makeBlitCommandEncoder() else { return }
    blit.fill(buffer: bins, range: 0..<Self.binsLength, value: 0)
    blit.endEncoding()

    guard let compute = cb.makeComputeCommandEncoder() else { return }
    compute.setComputePipelineState(metal.scopeAccumulate)
    compute.setTexture(measureTarget, index: 0)
    compute.setBuffer(bins, offset: 0, index: 0)
    params.withUnsafeMutableBytes { compute.setBytes($0.baseAddress!, length: paramsLength, index: 1) }
    let tg = MTLSize(width: 16, height: 16, depth: 1)
    let groups = MTLSize(width: (mw + 15) / 16, height: (mh + 15) / 16, depth: 1)
    compute.dispatchThreadgroups(groups, threadsPerThreadgroup: tg)
    var range = reduceRange(width: mw)
    compute.setComputePipelineState(metal.scopeReduce)
    compute.setBuffer(bins, offset: 0, index: 0)
    compute.setBytes(&range, length: MemoryLayout<SIMD4<UInt32>>.stride, index: 1)
    compute.dispatchThreadgroups(MTLSize(width: 1, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
    compute.endEncoding()

    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
    guard let enc = cb.makeRenderCommandEncoder(descriptor: pass) else { return }
    enc.setRenderPipelineState(metal.scopeDraw)
    enc.setFragmentBuffer(bins, offset: 0, index: 0)
    params.withUnsafeMutableBytes { enc.setFragmentBytes($0.baseAddress!, length: paramsLength, index: 1) }
    enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    enc.endEncoding()
    cb.present(drawable)
    cb.addCompletedHandler { _ in _ = keep }
    cb.commit()
  }

  /// (start, count, plane stride, planes) of the bins the peak is taken over.
  private func reduceRange(width: Int) -> SIMD4<UInt32> {
    let w = UInt32(width)
    switch kind {
    case 0: return rgbMode ? SIMD4(0, w * 256, 65536, 3) : SIMD4(0, w * 256, 65536, 1)
    case 1: return SIMD4(0, w * 256, 65536, 3)
    case 2: return rgbMode ? SIMD4(256, 256, 256, 3) : SIMD4(0, 256, 256, 1)
    default: return SIMD4(0, 16384, 0, 1)
    }
  }
}
