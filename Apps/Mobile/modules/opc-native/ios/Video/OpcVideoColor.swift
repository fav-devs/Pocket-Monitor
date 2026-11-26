import Foundation
import simd

// CPU side of the picture colour science. The shader (OpcVideoShaders.swift) evaluates the
// per-pixel parts; this file resolves everything that is constant for a frame (anchors, tone
// map, gamut matrix, false-colour edges) into `OpcVideoFxUniforms`.
//
// Sources (keep in sync with Android `OpcVideoColor.kt` and the web GLSL):
// - Transfers, anchors, WAVE IRE: Sources/OpenPocketViewCore/LiveColorScience.swift
// - Clip shelf (7 codes): OpenCineMedia/ScopeMath.swift `ScopeAnchors.clipShelfCodes`
// - False-colour tables: OpenCineMedia/FalseColor.swift
// - Log display transform + tone map: OpenCineMedia/MonitorLogDisplayTransform.swift,
//   MonitorSceneToneMap.swift
// - Peaking: Apps/Desktop/crates/opc-render/shaders/peaking_*.frag

/// Camera transfer of the incoming signal (`PictureEffects.sourceColor`).
enum OpcVideoTransfer: Int32 {
  case rec709 = 0
  case hlg = 1
  case dlogm = 2
  case dlog = 3
  case dlog2 = 4

  init(js: String?) {
    switch js {
    case "hlg": self = .hlg
    case "dlog-m": self = .dlogm
    case "dlog": self = .dlog
    case "dlog2": self = .dlog2
    default: self = .rec709
    }
  }

  /// Live-tap ceiling byte at the reference EI (D-Log2 1600 → 247, D-Log 400 → 223).
  /// VERIFY: the contract carries no ISO, so the ratcheted per-EI ceiling of the core is not used.
  var clipByte: Int {
    switch self {
    case .dlog2: return 247
    case .dlog: return 223
    default: return 255
    }
  }

  /// Encoded-domain luma weights: BT.709 for Rec.709 / D-Log / D-Log M, BT.2020 for HLG / D-Log2.
  var lumaWeights: SIMD3<Float> {
    switch self {
    case .hlg, .dlog2: return SIMD3(0.2627, 0.6780, 0.0593)
    default: return SIMD3(0.2126, 0.7152, 0.0722)
    }
  }

  /// Linear source gamut → linear Rec.709, row-major.
  var gamutToRec709: (SIMD3<Float>, SIMD3<Float>, SIMD3<Float>) {
    switch self {
    case .dlog:  // DJI D-Gamut (2017 white paper)
      return (SIMD3(1.6746, -0.5797, -0.0949), SIMD3(-0.0981, 1.3340, -0.2359), SIMD3(-0.0410, -0.2430, 1.2840))
    case .dlog2:  // D-Gamut2
      return (SIMD3(1.8577, -0.7712, -0.0869), SIMD3(-0.2018, 1.4176, -0.2158), SIMD3(-0.0125, -0.1621, 1.1746))
    case .hlg:  // BT.2020 → BT.709
      return (SIMD3(1.6605, -0.5876, -0.0728), SIMD3(-0.1246, 1.1329, -0.0083), SIMD3(-0.0182, -0.1006, 1.1187))
    default:
      // VERIFY: D-Log M primaries are not published; the core treats them as pass-through too.
      return (SIMD3(1, 0, 0), SIMD3(0, 1, 0), SIMD3(0, 0, 1))
    }
  }

  // MARK: Transfer curves (bit-for-bit with LiveColorScience)

  func decode(_ encoded: Double) -> Double {
    let e = min(1, max(0, encoded))
    switch self {
    case .rec709:
      return e < 0.081 ? e / 4.5 : pow((e + 0.099) / 1.099, 1 / 0.45)
    case .hlg:
      let s = e <= 0.5 ? e * e / 3 : (exp((e - 0.559_910_73) / 0.178_832_77) + 0.284_668_92) / 12
      return s / OpcVideoTransfer.hlgDiffuseWhite
    case .dlog:
      return e <= 0.14 ? (e - 0.0929) / 6.025 : (pow(10, 3.89616 * e - 2.27752) - 0.0108) / 0.9892
    case .dlog2:
      if e >= OpcVideoTransfer.d2b1 {
        return (475.0 / (pow(2, OpcVideoTransfer.d2a) - 1)) * (pow(2, OpcVideoTransfer.d2a * e) - 1)
      }
      if e >= OpcVideoTransfer.d2b2 {
        return pow(2, (e - OpcVideoTransfer.d2b1) / OpcVideoTransfer.d2k1 + log2(0.18))
      }
      return (e - OpcVideoTransfer.d2b2) / OpcVideoTransfer.d2k2 + OpcVideoTransfer.d2i2
    case .dlogm:
      let t = pow(2, e * 5.612990379333496 + 0.9327186346054077) - 2.428226947784424
      let v = t < 0.6034245491027832 ? t * 1.0151796340942383 + 0.5178895592689514 : t * 1.8734303712844849
      return v * (0.18 / 12.4054)
    }
  }

  func encode(_ linear: Double) -> Double {
    let l = max(0, linear)
    let out: Double
    switch self {
    case .rec709:
      let c = min(1, l)
      out = c < 0.018 ? 4.5 * c : 1.099 * pow(c, 0.45) - 0.099
    case .hlg:
      let s = min(1, max(0, l * OpcVideoTransfer.hlgDiffuseWhite))
      out = s <= 1.0 / 12.0 ? sqrt(3 * s) : 0.178_832_77 * log(12 * s - 0.284_668_92) + 0.559_910_73
    case .dlog:
      out = l <= 0.0078 ? 6.025 * l + 0.0929 : log10(l * 0.9892 + 0.0108) * 0.256663 + 0.584555
    case .dlog2:
      if l >= 0.18 {
        out = (1 / OpcVideoTransfer.d2a) * log2(l * (pow(2, OpcVideoTransfer.d2a) - 1) / 475.0 + 1)
      } else if l >= OpcVideoTransfer.d2i2 {
        out = OpcVideoTransfer.d2k1 * (log2(max(l, 1e-15)) - log2(0.18)) + OpcVideoTransfer.d2b1
      } else {
        out = OpcVideoTransfer.d2k2 * (l - OpcVideoTransfer.d2i2) + OpcVideoTransfer.d2b2
      }
    case .dlogm:
      let v = l / (0.18 / 12.4054)
      let t = v < 0.6034245491027832 * 1.8734303712844849
        ? (v - 0.5178895592689514) / 1.0151796340942383 : v / 1.8734303712844849
      out = (log2(t + 2.428226947784424) - 0.9327186346054077) / 5.612990379333496
    }
    return out.isFinite ? min(1, max(0, out)) : 0
  }

  static let hlgDiffuseWhite = (exp((0.75 - 0.559_910_73) / 0.178_832_77) + 0.284_668_92) / 12
  private static let d2a = 16.285_770_761_945_304
  private static let d2k1 = 0.059_439_938_321_493
  private static let d2b1 = 0.304_985_337_243_402
  private static let d2k2 = 2.960_935_245_492_250
  private static let d2b2 = 0.148_314_799_066_323
  private static let d2i2 = 0.028_961_695_254_132

  // MARK: Scope axis (ScopeAnchors / ScopeDisplayScale)

  struct Anchors {
    var black: Double
    var mid: Double
    var clip: Double
    var midLevel: Double

    var vector: SIMD4<Float> { SIMD4(Float(black), Float(mid), Float(clip), Float(midLevel)) }

    func waveformLevel(_ c: Double) -> Double {
      let crush = 0.05, top = 0.95
      let v = min(1, max(0, c))
      if v < black { return black <= 0 ? crush : v / black * crush }
      if v > clip {
        let head = 1 - clip
        return head <= 0 ? top : top + (v - clip) / head * (1 - top)
      }
      if clip <= mid || mid <= black { return crush + (v - black) / max(clip - black, 1e-9) * (top - crush) }
      if v <= mid { return crush + (v - black) / (mid - black) * (midLevel - crush) }
      return midLevel + (v - mid) / (clip - mid) * (top - midLevel)
    }

    func monitorPercent(_ c: Double) -> Double {
      min(100, max(0, (waveformLevel(c) - 0.05) / 0.9 * 100))
    }
  }

  var anchors: Anchors {
    let black = self == .dlogm ? 0 : encode(0)
    let mid = encode(0.18)
    return Anchors(black: black, mid: mid, clip: Double(clipByte) / 255, midLevel: 0.05 + mid * 0.9)
  }
}

/// Parsed `PictureEffects` (src/types.ts). Unknown or missing fields keep the defaults of
/// `defaultPictureEffects`.
struct OpcPictureEffects: Equatable {
  var sourceColor: OpcVideoTransfer = .rec709
  var lutId: String?
  var lutIntensity: Float = 1
  /// 0 off, 1 cinestop (scene stops), 2 video (Video Mode IRE), 3 ire, 4 limits.
  var falseColor: Int32 = 0
  var zebraOn = false
  /// Highlight zebra: monitor IRE (0…100) at and above which the max RGB channel paints.
  var zebraUpper: Float = 99
  /// Midtone zebra centre in monitor IRE (±5 IRE band on luma), nil = off.
  var zebraLower: Float?
  var zebraPaint = SIMD3<Float>(1, 1, 1)
  var zebraStripes = true
  var peakingOn = false
  var peakingColor = SIMD3<Float>(1, 0, 0)
  var peakingRatio: Float = 2.10
  var peakingGate: Float = 0.001_74
  var desqueeze: Float = 1
  var desqueezeVertical = false
  var mirror = false
  var monochrome = false

  static func parse(_ dict: [String: Any]?) -> OpcPictureEffects {
    var fx = OpcPictureEffects()
    guard let dict else { return fx }
    fx.sourceColor = OpcVideoTransfer(js: dict["sourceColor"] as? String)
    fx.lutId = dict["lutId"] as? String
    fx.lutIntensity = Float(opcVideoClamp(number(dict["lutIntensity"]) ?? 1, 0, 1))
    switch dict["falseColor"] as? String {
    case "cinestop": fx.falseColor = 1
    case "video": fx.falseColor = 2
    case "ire": fx.falseColor = 3
    case "limits": fx.falseColor = 4
    default: fx.falseColor = 0
    }
    if let zebra = dict["zebra"] as? [String: Any] {
      fx.zebraOn = true
      fx.zebraUpper = Float(number(zebra["upper"]) ?? 99)
      fx.zebraLower = number(zebra["lower"]).map { Float($0) }
      fx.zebraPaint = rgb(zebra["paint"]) ?? SIMD3(1, 1, 1)
      fx.zebraStripes = (zebra["stripes"] as? Bool) ?? true
    }
    if let peaking = dict["peaking"] as? [String: Any] {
      fx.peakingOn = true
      fx.peakingColor = rgb(peaking["color"]) ?? SIMD3(1, 0, 0)
      fx.peakingRatio = Float(number(peaking["ratioThreshold"]) ?? 2.10)
      fx.peakingGate = Float(number(peaking["noiseGate"]) ?? 0.001_74)
    }
    if let desqueeze = dict["desqueeze"] as? [String: Any] {
      fx.desqueeze = Float(max(0.1, number(desqueeze["factor"]) ?? 1))
      fx.desqueezeVertical = (desqueeze["direction"] as? String) == "vertical"
    }
    fx.mirror = (dict["mirror"] as? Bool) ?? false
    fx.monochrome = (dict["monochrome"] as? Bool) ?? false
    return fx
  }

  /// Display aspect of a source after desqueeze.
  func displayAspect(sourceWidth: Int, sourceHeight: Int) -> Double {
    let base = Double(max(sourceWidth, 1)) / Double(max(sourceHeight, 1))
    let factor = Double(desqueeze)
    guard abs(factor - 1) > 0.001 else { return base }
    return desqueezeVertical ? base / factor : base * factor
  }

  private static func number(_ value: Any?) -> Double? {
    if let n = value as? NSNumber { return n.doubleValue }
    if let d = value as? Double { return d }
    return nil
  }

  /// `Rgb` is documented as 0…1; 0…255 triples are accepted too.
  private static func rgb(_ value: Any?) -> SIMD3<Float>? {
    guard let array = value as? [Any], array.count >= 3 else { return nil }
    let values = array.prefix(3).map { number($0) ?? 0 }
    let scale = values.contains { $0 > 1 } ? 1.0 / 255.0 : 1.0
    return SIMD3(Float(values[0] * scale), Float(values[1] * scale), Float(values[2] * scale))
  }
}

func opcVideoClamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { min(hi, max(lo, v)) }

/// Seventeen float4 slots, the same order in MSL, GLSL (Android `uFx[17]`) and the web.
struct OpcVideoFxUniforms {
  static let count = 17
  var v = [SIMD4<Float>](repeating: .zero, count: OpcVideoFxUniforms.count)

  static let anchors = 0, luma = 1, tone = 2, gamutR = 3, gamutG = 4, gamutB = 5, lut = 6,
    lutMin = 7, lutMax = 8, falseColor = 9, zebra = 10, zebraPaint = 11, peak = 12, peakColor = 13,
    src = 14, view = 15, map = 16

  /// - Parameters:
  ///   - lut: the registered LUT, when `effects.lutId` resolves.
  ///   - viewSize: target size in pixels.
  ///   - contentScale: screen scale, for the zebra stripe pitch.
  ///   - geometry: false for scope measurement (whole source, no mirror).
  static func make(
    effects fx: OpcPictureEffects, lut: OpcVideoLut?, sourceWidth: Int, sourceHeight: Int,
    viewWidth: Double, viewHeight: Double, contentScale: Double, fill: Bool
  ) -> OpcVideoFxUniforms {
    var u = OpcVideoFxUniforms()
    let t = fx.sourceColor
    let a = t.anchors
    u.v[anchors] = a.vector
    let w = t.lumaWeights
    u.v[luma] = SIMD4(w.x, w.y, w.z, Float(t.rawValue))

    // MonitorSceneToneMap(sceneWhite: decode(1)), contrast 1.1.
    let sceneWhite = t.decode(1)
    let contrast = 1.1
    let mg = pow(0.42, 2.4)
    let whitePoint = max(sceneWhite / 0.18, 0.000_001)
    let cw = pow(whitePoint, contrast)
    let gain = max(0.000_001, (mg - 1 / (cw * cw)) / (1 - mg))
    u.v[tone] = SIMD4(Float(gain), Float(contrast), Float(gain * cw), t == .rec709 ? 0 : 1)
    let g = t.gamutToRec709
    u.v[gamutR] = SIMD4(g.0, 0)
    u.v[gamutG] = SIMD4(g.1, 0)
    u.v[gamutB] = SIMD4(g.2, 0)

    if let lut {
      u.v[self.lut] = SIMD4(1, Float(lut.size), fx.lutIntensity, fx.monochrome ? 1 : 0)
      u.v[lutMin] = SIMD4(lut.domainMin, 0)
      u.v[lutMax] = SIMD4(lut.domainMax, 1)
    } else {
      u.v[self.lut] = SIMD4(0, 2, 0, fx.monochrome ? 1 : 0)
      u.v[lutMin] = SIMD4(0, 0, 0, 0)
      u.v[lutMax] = SIMD4(1, 1, 1, 1)
    }

    // Clip shelf: 7 codes under the ceiling (ScopeAnchors.clipShelfCodes).
    let shelf = max(0, a.clip - 7.0 / 255.0)
    let shelfLinear = max(0, t.decode(shelf))
    let clipStops = shelfLinear > 0 ? log2(shelfLinear / 0.18) : 10.5
    var limitsEdge = a.monitorPercent(shelf)
    if !(limitsEdge < 99 && limitsEdge > 94) { limitsEdge = 99 }
    u.v[falseColor] = SIMD4(Float(fx.falseColor), Float(clipStops), Float(limitsEdge), 0)

    u.v[zebra] = SIMD4(fx.zebraOn ? 1 : 0, fx.zebraUpper, fx.zebraLower ?? -1, fx.zebraStripes ? 1 : 0)
    u.v[zebraPaint] = SIMD4(fx.zebraPaint, 1)
    u.v[peak] = SIMD4(fx.peakingOn ? 1 : 0, fx.peakingRatio, fx.peakingGate, 0)
    u.v[peakColor] = SIMD4(fx.peakingColor, 1)

    let sw = Float(max(sourceWidth, 1)), sh = Float(max(sourceHeight, 1))
    u.v[src] = SIMD4(sw, sh, 1 / sw, 1 / sh)
    // Stripe pitch: 14.14 px on the desktop's 2x display → 7.07 pt.
    let pitch = Float(7.07 * max(contentScale, 1))
    u.v[view] = SIMD4(Float(viewWidth), Float(viewHeight), pitch, fx.mirror ? 1 : 0)

    // View uv (top-left origin) → source uv: src = (uv - offset) * scale.
    let displayAspect = fx.displayAspect(sourceWidth: sourceWidth, sourceHeight: sourceHeight)
    let viewAspect = viewWidth / max(viewHeight, 1)
    var cw2 = 1.0, ch2 = 1.0
    if fill {
      if displayAspect > viewAspect { cw2 = displayAspect / viewAspect } else { ch2 = viewAspect / displayAspect }
    } else {
      if displayAspect > viewAspect { ch2 = viewAspect / displayAspect } else { cw2 = displayAspect / viewAspect }
    }
    let ox = (1 - cw2) / 2, oy = (1 - ch2) / 2
    u.v[map] = SIMD4(Float(1 / cw2), Float(1 / ch2), Float(ox), Float(oy))
    return u
  }

  /// Uniforms for whole-frame work (scope measurement, raw sample): identity mapping, no mirror.
  static func whole(effects fx: OpcPictureEffects, lut: OpcVideoLut?, sourceWidth: Int, sourceHeight: Int)
    -> OpcVideoFxUniforms
  {
    var noGeometry = fx
    noGeometry.mirror = false
    noGeometry.desqueeze = 1
    return make(
      effects: noGeometry, lut: lut, sourceWidth: sourceWidth, sourceHeight: sourceHeight,
      viewWidth: Double(sourceWidth), viewHeight: Double(sourceHeight), contentScale: 1, fill: false)
  }
}
