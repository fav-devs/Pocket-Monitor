import CoreVideo
import Foundation
import Metal

/// Process-wide Metal state: one device, one queue, the runtime-compiled library and every
/// pipeline the picture and scope views use. Created lazily; nil when Metal is unavailable.
final class OpcVideoMetal {
  static let shared: OpcVideoMetal? = {
    do {
      return try OpcVideoMetal()
    } catch {
      NSLog("[OpcVideo] Metal unavailable: \(error)")
      return nil
    }
  }()

  /// Format of the RGBA signal textures every pass reads.
  static let signalFormat: MTLPixelFormat = .rgba8Unorm
  /// Drawable / snapshot format.
  static let outputFormat: MTLPixelFormat = .bgra8Unorm

  let device: MTLDevice
  let queue: MTLCommandQueue
  let library: MTLLibrary
  let textureCache: CVMetalTextureCache

  let ingestYUV: MTLRenderPipelineState
  let ingestRGB: MTLRenderPipelineState
  let ingestDemo: MTLRenderPipelineState
  let peakBlur: MTLRenderPipelineState
  let peakMask: MTLRenderPipelineState
  let picture: MTLRenderPipelineState
  let measure: MTLRenderPipelineState
  let scopeDraw: MTLRenderPipelineState
  let scopeAccumulate: MTLComputePipelineState
  let scopeReduce: MTLComputePipelineState

  let linearSampler: MTLSamplerState
  let nearestSampler: MTLSamplerState
  /// 2×2×2 identity cube bound when no LUT is active.
  let identityLut: MTLTexture
  /// 1×1 black mask bound when peaking is off.
  let emptyMask: MTLTexture

  enum Failure: Error { case noDevice, noQueue, noCache, function(String), texture }

  private init() throws {
    guard let device = MTLCreateSystemDefaultDevice() else { throw Failure.noDevice }
    guard let queue = device.makeCommandQueue() else { throw Failure.noQueue }
    self.device = device
    self.queue = queue
    queue.label = "opc.video"
    let options = MTLCompileOptions()
    // VERIFY: fastMathEnabled is deprecated on newer SDKs in favour of mathMode; both default on.
    library = try device.makeLibrary(source: opcVideoShaderSource, options: options)

    var cache: CVMetalTextureCache?
    guard CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &cache) == kCVReturnSuccess,
      let cache
    else { throw Failure.noCache }
    textureCache = cache

    func fn(_ name: String) throws -> MTLFunction {
      guard let f = library.makeFunction(name: name) else { throw Failure.function(name) }
      return f
    }
    let vertex = try fn("opc_fullscreen_vertex")
    func render(_ fragment: String, _ format: MTLPixelFormat) throws -> MTLRenderPipelineState {
      let d = MTLRenderPipelineDescriptor()
      d.label = fragment
      d.vertexFunction = vertex
      d.fragmentFunction = try fn(fragment)
      d.colorAttachments[0].pixelFormat = format
      return try device.makeRenderPipelineState(descriptor: d)
    }
    ingestYUV = try render("opc_ingest_yuv_fragment", Self.signalFormat)
    ingestRGB = try render("opc_ingest_rgb_fragment", Self.signalFormat)
    ingestDemo = try render("opc_ingest_demo_fragment", Self.signalFormat)
    peakBlur = try render("opc_peak_blur_fragment", .rgba8Unorm)
    peakMask = try render("opc_peak_mask_fragment", .rgba8Unorm)
    picture = try render("opc_picture_fragment", Self.outputFormat)
    measure = try render("opc_measure_fragment", Self.signalFormat)
    scopeDraw = try render("opc_scope_draw_fragment", Self.outputFormat)
    scopeAccumulate = try device.makeComputePipelineState(function: try fn("opc_scope_accumulate"))
    scopeReduce = try device.makeComputePipelineState(function: try fn("opc_scope_reduce"))

    let ls = MTLSamplerDescriptor()
    ls.minFilter = .linear
    ls.magFilter = .linear
    ls.sAddressMode = .clampToEdge
    ls.tAddressMode = .clampToEdge
    ls.rAddressMode = .clampToEdge
    let ns = MTLSamplerDescriptor()
    ns.minFilter = .nearest
    ns.magFilter = .nearest
    ns.sAddressMode = .clampToEdge
    ns.tAddressMode = .clampToEdge
    guard let linear = device.makeSamplerState(descriptor: ls),
      let nearest = device.makeSamplerState(descriptor: ns)
    else { throw Failure.texture }
    linearSampler = linear
    nearestSampler = nearest

    let cube = MTLTextureDescriptor()
    cube.textureType = .type3D
    cube.pixelFormat = .rgba8Unorm
    cube.width = 2
    cube.height = 2
    cube.depth = 2
    cube.usage = .shaderRead
    guard let identity = device.makeTexture(descriptor: cube) else { throw Failure.texture }
    var cubeBytes = [UInt8]()
    for b in 0..<2 { for g in 0..<2 { for r in 0..<2 { cubeBytes += [UInt8(r * 255), UInt8(g * 255), UInt8(b * 255), 255] } } }
    identity.replace(
      region: MTLRegionMake3D(0, 0, 0, 2, 2, 2), mipmapLevel: 0, slice: 0,
      withBytes: cubeBytes, bytesPerRow: 8, bytesPerImage: 16)
    identityLut = identity

    let maskDescriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .rgba8Unorm, width: 1, height: 1, mipmapped: false)
    maskDescriptor.usage = .shaderRead
    guard let mask = device.makeTexture(descriptor: maskDescriptor) else { throw Failure.texture }
    mask.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: [UInt8](repeating: 0, count: 4), bytesPerRow: 4)
    emptyMask = mask
  }

  func makeTarget(width: Int, height: Int, format: MTLPixelFormat, shared: Bool = false) -> MTLTexture? {
    let d = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: format, width: max(width, 1), height: max(height, 1), mipmapped: false)
    d.usage = [.renderTarget, .shaderRead]
    d.storageMode = shared ? .shared : .private
    return device.makeTexture(descriptor: d)
  }

  /// Wraps one plane of a decoded pixel buffer. The returned CVMetalTexture must stay alive until
  /// the command buffer that samples it completes.
  func texture(for buffer: CVPixelBuffer, plane: Int, format: MTLPixelFormat) -> (MTLTexture, CVMetalTexture)? {
    let planar = CVPixelBufferIsPlanar(buffer)
    let width = planar ? CVPixelBufferGetWidthOfPlane(buffer, plane) : CVPixelBufferGetWidth(buffer)
    let height = planar ? CVPixelBufferGetHeightOfPlane(buffer, plane) : CVPixelBufferGetHeight(buffer)
    var cvTexture: CVMetalTexture?
    let status = CVMetalTextureCacheCreateTextureFromImage(
      kCFAllocatorDefault, textureCache, buffer, nil, format, width, height, plane, &cvTexture)
    guard status == kCVReturnSuccess, let cvTexture, let texture = CVMetalTextureGetTexture(cvTexture) else {
      return nil
    }
    return (texture, cvTexture)
  }
}
