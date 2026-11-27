import AVFoundation
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

// The playback editor's effect pipeline (iOS). Same stages and order as `src/core/edit/plan.ts`:
//   1. colour   — one baked 3D LUT (`PocketEditLutRegistry`), applied to the encoded signal
//   2. face     — `PocketFaceRetouchStage` (placeholder: passes through until face retouch lands)
//   3. geometry — rotate (clockwise) → crop (normalized, rotated frame, top-left origin) → flip → scale
// Preview runs 1–2 on the AVPlayerItem (geometry is React Native transforms); export runs 1–3 in
// the AVVideoComposition's Core Image handler.

// MARK: - LUT registry

/// Baked cubes from JS (`PocketEdit.setLut`), stored as CIColorCube RGBA float data.
final class PocketEditLutRegistry: @unchecked Sendable {
  static let shared = PocketEditLutRegistry()

  struct Cube {
    let size: Int
    let data: Data
  }

  private let lock = NSLock()
  private var cubes: [String: Cube] = [:]

  /// `rgb`: size³ triplets, red fastest (the JS `CubeLUT.rgb` layout).
  func set(_ key: String, size: Int, rgb: UnsafeBufferPointer<Float>) {
    let count = size * size * size
    var rgba = [Float](repeating: 1, count: count * 4)
    for i in 0..<count {
      rgba[i * 4] = rgb[i * 3]
      rgba[i * 4 + 1] = rgb[i * 3 + 1]
      rgba[i * 4 + 2] = rgb[i * 3 + 2]
    }
    let data = rgba.withUnsafeBufferPointer { Data(buffer: $0) }
    lock.lock()
    cubes[key] = Cube(size: size, data: data)
    lock.unlock()
  }

  func get(_ key: String?) -> Cube? {
    guard let key else { return nil }
    lock.lock()
    defer { lock.unlock() }
    return cubes[key]
  }

  func drop(_ key: String) {
    lock.lock()
    cubes.removeValue(forKey: key)
    lock.unlock()
  }
}

// MARK: - Plans

struct PocketEditSplit: Equatable {
  /// "x" or "y" in the source frame (top-left origin, normalized).
  var axisX: Bool
  var at: Double
  /// The original shows where the coordinate is below `at`.
  var originalLow: Bool

  init?(_ dict: [String: Any]?) {
    guard let dict, let axis = dict["axis"] as? String, let at = (dict["at"] as? NSNumber)?.doubleValue else { return nil }
    axisX = axis == "x"
    self.at = at
    originalLow = (dict["originalLow"] as? Bool) ?? true
  }
}

/// Face retouch strengths 0…1 (`FaceParams` in core/edit/model.ts).
struct PocketFaceParams: Equatable {
  var auto: Double = 0
  var smooth: Double = 0
  var brighten: Double = 0
  var slim: Double = 0
  var eyes: Double = 0

  init() {}

  init(_ dict: [String: Any]?) {
    func v(_ k: String) -> Double { (dict?[k] as? NSNumber)?.doubleValue ?? 0 }
    auto = v("auto")
    smooth = v("smooth")
    brighten = v("brighten")
    slim = v("slim")
    eyes = v("eyes")
  }

  var isZero: Bool { max(auto, smooth, brighten, slim, eyes) <= 0.001 }
}

struct PocketEditPreviewPlan: Equatable {
  var lutKey: String?
  var split: PocketEditSplit?
  var face = PocketFaceParams()
  var toneMapSdr = false
  var volume: Double = 1

  init(_ dict: [String: Any]) {
    lutKey = dict["lutKey"] as? String
    split = PocketEditSplit(dict["split"] as? [String: Any])
    face = PocketFaceParams(dict["face"] as? [String: Any])
    toneMapSdr = (dict["toneMapSdr"] as? Bool) ?? false
    volume = (dict["volume"] as? NSNumber)?.doubleValue ?? 1
  }
}

struct PocketEditExportPlan {
  var sourceUri: String
  var outputName: String
  var lutKey: String?
  var face: PocketFaceParams
  /// Clockwise degrees (0, 90, 180, 270).
  var rotation: Int
  /// Normalized crop in the rotated frame, top-left origin.
  var crop: CGRect
  var flipH: Bool
  var flipV: Bool
  var width: Int
  var height: Int
  var volume: Double
  var trim: (start: Double, end: Double)?
  var keepHdr: Bool
  var geometryIdentity: Bool

  init(_ d: [String: Any]) throws {
    guard let source = d["sourceUri"] as? String, !source.isEmpty else {
      throw PocketEditError("The export has no source file.")
    }
    func num(_ k: String, _ fallback: Double = 0) -> Double { (d[k] as? NSNumber)?.doubleValue ?? fallback }
    sourceUri = source
    outputName = (d["outputName"] as? String) ?? "edit.mp4"
    lutKey = d["lutKey"] as? String
    face = PocketFaceParams(d["face"] as? [String: Any])
    rotation = ((Int(num("rotation")) % 360) + 360) % 360
    let c = (d["crop"] as? [String: Any]) ?? [:]
    func cn(_ k: String, _ f: Double) -> Double { (c[k] as? NSNumber)?.doubleValue ?? f }
    crop = CGRect(x: cn("x", 0), y: cn("y", 0), width: cn("w", 1), height: cn("h", 1))
    flipH = (d["flipH"] as? Bool) ?? false
    flipV = (d["flipV"] as? Bool) ?? false
    width = max(2, Int(num("width", 1920)))
    height = max(2, Int(num("height", 1080)))
    volume = num("volume", 1)
    if let t = d["trim"] as? [String: Any], let s = (t["start"] as? NSNumber)?.doubleValue, let e = (t["end"] as? NSNumber)?.doubleValue, e > s {
      trim = (s, e)
    }
    keepHdr = (d["keepHdr"] as? Bool) ?? false
    geometryIdentity = (d["geometryIdentity"] as? Bool) ?? false
  }
}

struct PocketEditError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

// MARK: - Stages

/// A per-frame stage in the pipeline. Stages run on the source frame (before geometry).
protocol PocketEditFrameStage: AnyObject {
  var isActive: Bool { get }
  func apply(_ image: CIImage, at time: CMTime) -> CIImage
}

/// Colour: the baked cube through CIColorCubeWithColorSpace in the source's encoding space, so
/// the cube sees the clip's code values (Rec.709, HLG or log), like a .cube in an editor. An
/// optional split shows the original on one side (before/after compare).
final class PocketEditColorStage: PocketEditFrameStage, @unchecked Sendable {
  private let lock = NSLock()
  private var key: String?
  private var split: PocketEditSplit?
  private var filter: CIFilter?
  private var filterKey: String?
  let colorSpace: CGColorSpace

  init(colorSpace: CGColorSpace) {
    self.colorSpace = colorSpace
  }

  func update(lutKey: String?, split: PocketEditSplit?) {
    lock.lock()
    key = lutKey
    self.split = split
    lock.unlock()
  }

  var isActive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return key != nil
  }

  func apply(_ image: CIImage, at time: CMTime) -> CIImage {
    lock.lock()
    defer { lock.unlock() }
    guard let key, let cube = PocketEditLutRegistry.shared.get(key) else { return image }
    if filterKey != key || filter == nil {
      let f = CIFilter.colorCubeWithColorSpace()
      f.cubeDimension = Float(cube.size)
      f.cubeData = cube.data
      f.colorSpace = colorSpace
      filter = f
      filterKey = key
    }
    guard let filter else { return image }
    filter.setValue(image, forKey: kCIInputImageKey)
    guard let graded = filter.outputImage?.cropped(to: image.extent) else { return image }
    guard let split else { return graded }
    // The original's side of the line, in Core Image coordinates (bottom-left origin).
    let e = image.extent
    let side: CGRect
    if split.axisX {
      let x = e.minX + CGFloat(split.at) * e.width
      side = split.originalLow ? CGRect(x: e.minX, y: e.minY, width: x - e.minX, height: e.height) : CGRect(x: x, y: e.minY, width: e.maxX - x, height: e.height)
    } else {
      // Top-left v → CI y.
      let y = e.maxY - CGFloat(split.at) * e.height
      side = split.originalLow ? CGRect(x: e.minX, y: y, width: e.width, height: e.maxY - y) : CGRect(x: e.minX, y: e.minY, width: e.width, height: y - e.minY)
    }
    return image.cropped(to: side).composited(over: graded)
  }
}

/// A face as the face stage sees it: bounds and named landmark points, in the frame's pixels.
struct PocketFaceLandmarks {
  var bounds: CGRect
  var points: [String: [CGPoint]]
}

/// Face retouch (Smooth / Brighten / Slim / Eyes / Auto). PLACEHOLDER: passes frames through.
///
/// To implement (the face agent): set `landmarks` to a provider that runs Vision
/// (`VNDetectFaceLandmarksRequest` through a `VNSequenceRequestHandler`) on the frame, cached by
/// `time`, then in `apply` build masks from the landmarks and run Core Image / Metal kernels:
/// smooth = edge-preserving blur blended in the skin mask, brighten = exposure in the face mask,
/// slim / eyes = local warps (CIBumpDistortion-like) around jaw / eye points. Flip `isActive` on.
/// The same stage runs in preview (player item) and export (before geometry, so landmarks are in
/// source coordinates).
final class PocketFaceRetouchStage: PocketEditFrameStage, @unchecked Sendable {
  private let lock = NSLock()
  private var params = PocketFaceParams()
  /// Per-frame landmarks (set by the face implementation).
  var landmarks: ((CIImage, CMTime) -> [PocketFaceLandmarks])?

  func update(_ params: PocketFaceParams) {
    lock.lock()
    self.params = params
    lock.unlock()
  }

  var isActive: Bool { false }

  func apply(_ image: CIImage, at time: CMTime) -> CIImage { image }
}

/// Geometry for export: rotate → crop → flip → scale to the output size.
struct PocketEditGeometry {
  let rotation: Int
  let crop: CGRect
  let flipH: Bool
  let flipV: Bool
  let output: CGSize

  func apply(_ source: CIImage) -> CIImage {
    var img = source.transformed(by: CGAffineTransform(translationX: -source.extent.minX, y: -source.extent.minY))
    if rotation != 0 {
      // Clockwise on screen is a negative angle in Core Image's y-up space.
      img = img.transformed(by: CGAffineTransform(rotationAngle: -CGFloat(rotation) * .pi / 180))
      img = img.transformed(by: CGAffineTransform(translationX: -img.extent.minX, y: -img.extent.minY))
    }
    let w = img.extent.width
    let h = img.extent.height
    let rect = CGRect(x: crop.minX * w, y: (1 - crop.minY - crop.height) * h, width: crop.width * w, height: crop.height * h).integral
      .intersection(CGRect(x: 0, y: 0, width: w, height: h))
    guard rect.width >= 2, rect.height >= 2 else { return img }
    img = img.clampedToExtent().cropped(to: rect).transformed(by: CGAffineTransform(translationX: -rect.minX, y: -rect.minY))
    if flipH { img = img.transformed(by: CGAffineTransform(scaleX: -1, y: 1).translatedBy(x: -rect.width, y: 0)) }
    if flipV { img = img.transformed(by: CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -rect.height)) }
    let sx = output.width / rect.width
    let sy = output.height / rect.height
    if abs(sx - 1) > 0.0001 || abs(sy - 1) > 0.0001 {
      img = img.clampedToExtent().transformed(by: CGAffineTransform(scaleX: sx, y: sy))
    }
    return img.cropped(to: CGRect(origin: .zero, size: output))
  }
}

// MARK: - Source colour

enum PocketEditSourceColor {
  case sdr
  case hlg
  case pq

  var isHdr: Bool { self != .sdr }

  /// The space the cube is applied in (the clip's encoding).
  var lutSpace: CGColorSpace {
    switch self {
    case .sdr: return CGColorSpace(name: CGColorSpace.itur_709) ?? CGColorSpaceCreateDeviceRGB()
    case .hlg: return CGColorSpace(name: CGColorSpace.itur_2100_HLG) ?? CGColorSpaceCreateDeviceRGB()
    case .pq: return CGColorSpace(name: CGColorSpace.itur_2100_PQ) ?? CGColorSpaceCreateDeviceRGB()
    }
  }

  static func of(_ track: AVAssetTrack) async -> PocketEditSourceColor {
    guard let descriptions = try? await track.load(.formatDescriptions), let d = descriptions.first,
      let ext = (CMFormatDescriptionGetExtensions(d) as NSDictionary?) as? [String: Any],
      let transfer = ext[kCVImageBufferTransferFunctionKey as String] as? String
    else { return .sdr }
    if transfer == (kCVImageBufferTransferFunction_ITU_R_2100_HLG as String) { return .hlg }
    if transfer == (kCVImageBufferTransferFunction_SMPTE_ST_2084_PQ as String) { return .pq }
    return .sdr
  }

  /// Video composition colour properties: keep the source's HDR, or Rec.709 (tone-mapped SDR).
  func apply(to composition: AVMutableVideoComposition, keepHdr: Bool) {
    if isHdr && keepHdr {
      composition.colorPrimaries = AVVideoColorPrimaries_ITU_R_2020
      composition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_2020
      composition.colorTransferFunction = self == .pq ? AVVideoTransferFunction_SMPTE_ST_2084_PQ : AVVideoTransferFunction_ITU_R_2100_HLG
    } else {
      composition.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
      composition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
      composition.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
    }
  }
}
