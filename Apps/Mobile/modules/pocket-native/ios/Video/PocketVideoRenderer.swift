import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import Metal
import QuartzCore
import UniformTypeIdentifiers

/// What a pass reads: a decoded frame or a procedural demo scene.
enum PocketVideoSource {
  case frame(PocketVideoFrame)
  /// scene: 0 studio, 1 bars, 2 skin, 3 night.
  case demo(scene: Int, time: Double, transfer: PocketVideoTransfer)

  static let demoWidth = 1280
  static let demoHeight = 720

  var size: (width: Int, height: Int) {
    switch self {
    case .frame(let f): return (f.width, f.height)
    case .demo: return (Self.demoWidth, Self.demoHeight)
    }
  }

  static func demoScene(_ js: String?) -> Int? {
    switch js {
    case "studio": return 0
    case "bars": return 1
    case "skin": return 2
    case "night": return 3
    default: return nil
    }
  }
}

/// Encodes the picture pipeline. One instance per view (it caches source-sized intermediates);
/// every method must be called from one thread at a time (the owning view's render thread).
final class PocketVideoRenderer {
  let metal: PocketVideoMetal
  private var signal: MTLTexture?
  private var blur: MTLTexture?
  private var mask: MTLTexture?

  init(metal: PocketVideoMetal) {
    self.metal = metal
  }

  /// Source → RGBA signal texture at source size. CoreVideo textures that must outlive the
  /// command buffer are appended to `keepAlive`.
  func encodeIngest(_ cb: MTLCommandBuffer, source: PocketVideoSource, keepAlive: inout [AnyObject]) -> MTLTexture? {
    let (w, h) = source.size
    if signal?.width != w || signal?.height != h {
      signal = metal.makeTarget(width: w, height: h, format: PocketVideoMetal.signalFormat)
      blur = nil
      mask = nil
    }
    guard let signal else { return nil }
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = signal
    pass.colorAttachments[0].loadAction = .dontCare
    pass.colorAttachments[0].storeAction = .store
    guard let enc = cb.makeRenderCommandEncoder(descriptor: pass) else { return nil }
    enc.label = "pocket.ingest"
    defer { enc.endEncoding() }
    enc.setFragmentSamplerState(metal.linearSampler, index: 0)
    enc.setFragmentSamplerState(metal.nearestSampler, index: 1)

    switch source {
    case .demo(let scene, let time, let transfer):
      var cfg = SIMD4<Float>(Float(scene), Float(time.truncatingRemainder(dividingBy: 3600)), Float(transfer.rawValue), Float(w) / Float(h))
      enc.setRenderPipelineState(metal.ingestDemo)
      enc.setFragmentBytes(&cfg, length: MemoryLayout<SIMD4<Float>>.stride, index: 0)
    case .frame(let frame):
      let buffer = frame.pixelBuffer
      let fourCC = CVPixelBufferGetPixelFormatType(buffer)
      switch fourCC {
      case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
        kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange, kCVPixelFormatType_420YpCbCr10BiPlanarFullRange:
        let tenBit = fourCC == kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange
          || fourCC == kCVPixelFormatType_420YpCbCr10BiPlanarFullRange
        let full = fourCC == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
          || fourCC == kCVPixelFormatType_420YpCbCr10BiPlanarFullRange
        guard let y = metal.texture(for: buffer, plane: 0, format: tenBit ? .r16Unorm : .r8Unorm),
          let c = metal.texture(for: buffer, plane: 1, format: tenBit ? .rg16Unorm : .rg8Unorm)
        else { return nil }
        keepAlive.append(y.1)
        keepAlive.append(c.1)
        var cfg = SIMD4<Float>(full ? 1 : 0, 0, 0, 0)
        enc.setRenderPipelineState(metal.ingestYUV)
        enc.setFragmentBytes(&cfg, length: MemoryLayout<SIMD4<Float>>.stride, index: 0)
        enc.setFragmentTexture(y.0, index: 0)
        enc.setFragmentTexture(c.0, index: 1)
      case kCVPixelFormatType_32BGRA:
        guard let t = metal.texture(for: buffer, plane: 0, format: .bgra8Unorm) else { return nil }
        keepAlive.append(t.1)
        enc.setRenderPipelineState(metal.ingestRGB)
        enc.setFragmentTexture(t.0, index: 0)
      default:
        // VERIFY: a "native" VT output we cannot sample (e.g. 4:2:2 or 4:4:4) shows black.
        return nil
      }
    }
    enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    return signal
  }

  /// Peaking edge mask at source size (stroke in R, hairline in G).
  func encodePeaking(_ cb: MTLCommandBuffer, signal: MTLTexture, uniforms: PocketVideoFxUniforms) -> MTLTexture? {
    let w = signal.width, h = signal.height
    if blur?.width != w || blur?.height != h {
      blur = metal.makeTarget(width: w, height: h, format: .rgba8Unorm)
      mask = metal.makeTarget(width: w, height: h, format: .rgba8Unorm)
    }
    guard let blur, let mask else { return nil }
    for (target, pipeline) in [(blur, metal.peakBlur), (mask, metal.peakMask)] {
      let pass = MTLRenderPassDescriptor()
      pass.colorAttachments[0].texture = target
      pass.colorAttachments[0].loadAction = .dontCare
      pass.colorAttachments[0].storeAction = .store
      guard let enc = cb.makeRenderCommandEncoder(descriptor: pass) else { return nil }
      enc.label = pipeline === metal.peakBlur ? "pocket.peak.blur" : "pocket.peak.mask"
      enc.setRenderPipelineState(pipeline)
      uniforms.v.withUnsafeBytes { enc.setFragmentBytes($0.baseAddress!, length: $0.count, index: 0) }
      enc.setFragmentTexture(signal, index: 0)
      // Only the mask pass reads the blur; never bind a pass's own attachment.
      if target === mask { enc.setFragmentTexture(blur, index: 1) }
      enc.setFragmentSamplerState(metal.linearSampler, index: 0)
      enc.setFragmentSamplerState(metal.nearestSampler, index: 1)
      enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
      enc.endEncoding()
    }
    return mask
  }

  /// The monitoring picture into `pass` (drawable or offscreen target).
  func encodePicture(
    _ cb: MTLCommandBuffer, pass: MTLRenderPassDescriptor, signal: MTLTexture, effects: PocketPictureEffects,
    lut: PocketVideoLut?, uniforms: PocketVideoFxUniforms
  ) {
    let mask = effects.peakingOn ? (encodePeaking(cb, signal: signal, uniforms: uniforms) ?? metal.emptyMask) : metal.emptyMask
    guard let enc = cb.makeRenderCommandEncoder(descriptor: pass) else { return }
    enc.label = "pocket.picture"
    enc.setRenderPipelineState(metal.picture)
    uniforms.v.withUnsafeBytes { enc.setFragmentBytes($0.baseAddress!, length: $0.count, index: 0) }
    enc.setFragmentTexture(signal, index: 0)
    enc.setFragmentTexture(lut?.texture ?? metal.identityLut, index: 1)
    enc.setFragmentTexture(mask, index: 2)
    enc.setFragmentSamplerState(metal.linearSampler, index: 0)
    enc.setFragmentSamplerState(metal.nearestSampler, index: 1)
    enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    enc.endEncoding()
  }

  /// Signal (or graded picture) downsampled into `target` for the scopes.
  func encodeMeasure(
    _ cb: MTLCommandBuffer, signal: MTLTexture, target: MTLTexture, afterLut: Bool, lut: PocketVideoLut?,
    uniforms: PocketVideoFxUniforms
  ) {
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = target
    pass.colorAttachments[0].loadAction = .dontCare
    pass.colorAttachments[0].storeAction = .store
    guard let enc = cb.makeRenderCommandEncoder(descriptor: pass) else { return }
    enc.label = "pocket.measure"
    enc.setRenderPipelineState(metal.measure)
    uniforms.v.withUnsafeBytes { enc.setFragmentBytes($0.baseAddress!, length: $0.count, index: 0) }
    var cfg = SIMD4<Float>(afterLut ? 1 : 0, 0, 0, 0)
    enc.setFragmentBytes(&cfg, length: MemoryLayout<SIMD4<Float>>.stride, index: 1)
    enc.setFragmentTexture(signal, index: 0)
    enc.setFragmentTexture(lut?.texture ?? metal.identityLut, index: 1)
    enc.setFragmentSamplerState(metal.linearSampler, index: 0)
    enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    enc.endEncoding()
  }

  // MARK: Offscreen (snapshot / sampleFrame)

  /// Renders `source` into a shared BGRA texture of `width`×`height` and returns RGBA bytes.
  /// - Parameter stretch: map the whole source onto the target (meters) instead of fitting it.
  func renderOffscreen(
    source: PocketVideoSource, effects: PocketPictureEffects, width: Int, height: Int, stretch: Bool
  ) async -> [UInt8]? {
    guard let target = metal.makeTarget(width: width, height: height, format: PocketVideoMetal.outputFormat, shared: true),
      let cb = metal.queue.makeCommandBuffer()
    else { return nil }
    var keep: [AnyObject] = []
    guard let signal = encodeIngest(cb, source: source, keepAlive: &keep) else { return nil }
    let lut = PocketVideoLutRegistry.shared.lut(effects.lutId)
    let (sw, sh) = source.size
    var uniforms = PocketVideoFxUniforms.make(
      effects: effects, lut: lut, sourceWidth: sw, sourceHeight: sh, viewWidth: Double(width),
      viewHeight: Double(height), contentScale: 2, fill: false)
    if stretch { uniforms.v[PocketVideoFxUniforms.map] = SIMD4(1, 1, 0, 0) }
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = target
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
    pass.colorAttachments[0].storeAction = .store
    encodePicture(cb, pass: pass, signal: signal, effects: effects, lut: lut, uniforms: uniforms)
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
      cb.addCompletedHandler { _ in
        _ = keep
        done.resume()
      }
      cb.commit()
    }
    guard cb.status == .completed else { return nil }
    var bgra = [UInt8](repeating: 0, count: width * height * 4)
    bgra.withUnsafeMutableBytes { raw in
      target.getBytes(raw.baseAddress!, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
    }
    // BGRA → RGBA in place.
    var i = 0
    while i < bgra.count {
      let b = bgra[i]
      bgra[i] = bgra[i + 2]
      bgra[i + 2] = b
      i += 4
    }
    return bgra
  }

  /// RGBA8 → JPEG file in Caches/pocket-snapshots; returns its file URL.
  static func writeJPEG(rgba: [UInt8], width: Int, height: Int) -> URL? {
    let data = Data(rgba) as CFData
    guard let provider = CGDataProvider(data: data),
      let image = CGImage(
        width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider,
        decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else { return nil }
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("pocket-snapshots", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("snapshot-\(UUID().uuidString).jpg")
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
      return nil
    }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
    return CGImageDestinationFinalize(dest) ? url : nil
  }
}
