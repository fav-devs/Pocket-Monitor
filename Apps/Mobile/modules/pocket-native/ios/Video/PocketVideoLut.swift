import Foundation
import Metal
import simd

/// A registered 3D LUT: parsed once, uploaded once, shared by every picture and scope view.
final class PocketVideoLut {
  let id: String
  let size: Int
  let domainMin: SIMD3<Float>
  let domainMax: SIMD3<Float>
  let texture: MTLTexture

  init(id: String, size: Int, domainMin: SIMD3<Float>, domainMax: SIMD3<Float>, texture: MTLTexture) {
    self.id = id
    self.size = size
    self.domainMin = domainMin
    self.domainMax = domainMax
    self.texture = texture
  }
}

enum PocketVideoLutError: Error, CustomStringConvertible {
  case notA3DCube
  case badSize(Int)
  case wrongCount(expected: Int, got: Int)
  case badNumber(line: Int)
  case noDevice

  var description: String {
    switch self {
    case .notA3DCube: return "Not a 3D .cube (LUT_3D_SIZE missing or LUT_1D_SIZE present)."
    case .badSize(let n): return "Unsupported LUT_3D_SIZE \(n) (2…129)."
    case .wrongCount(let expected, let got): return "Expected \(expected) table rows, found \(got)."
    case .badNumber(let line): return "Unreadable number on line \(line)."
    case .noDevice: return "Metal is unavailable."
    }
  }
}

/// Adobe/Resolve `.cube` text → RGB floats, red fastest (the file order).
struct PocketVideoCubeParser {
  var size = 0
  var domainMin = SIMD3<Float>(0, 0, 0)
  var domainMax = SIMD3<Float>(1, 1, 1)
  var rgb: [Float] = []

  static func parse(_ text: String) throws -> PocketVideoCubeParser {
    var out = PocketVideoCubeParser()
    var rows = 0
    var lineNumber = 0
    var sawTableStart = false
    out.rgb.reserveCapacity(33 * 33 * 33 * 3)
    for rawLine in text.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r" }) {
      lineNumber += 1
      var line = Substring(rawLine)
      if let hash = line.firstIndex(of: "#") { line = line[..<hash] }
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.isEmpty { continue }
      let first = trimmed.first!
      if first.isLetter {
        // Keywords only before the table (TITLE may hold anything; skip it).
        let parts = trimmed.split(whereSeparator: { $0 == " " || $0 == "\t" })
        switch parts.first.map({ String($0).uppercased() }) {
        case "LUT_3D_SIZE":
          guard parts.count >= 2, let n = Int(parts[1]) else { throw PocketVideoLutError.badNumber(line: lineNumber) }
          guard (2...129).contains(n) else { throw PocketVideoLutError.badSize(n) }
          out.size = n
        case "LUT_1D_SIZE":
          throw PocketVideoLutError.notA3DCube
        case "DOMAIN_MIN":
          out.domainMin = try triple(parts.dropFirst(), line: lineNumber)
        case "DOMAIN_MAX":
          out.domainMax = try triple(parts.dropFirst(), line: lineNumber)
        default:
          break  // TITLE, LUT_3D_INPUT_RANGE, vendor keys
        }
        continue
      }
      sawTableStart = true
      let parts = trimmed.split(whereSeparator: { $0 == " " || $0 == "\t" })
      guard parts.count >= 3,
        let r = Float(parts[0]), let g = Float(parts[1]), let b = Float(parts[2])
      else { throw PocketVideoLutError.badNumber(line: lineNumber) }
      out.rgb.append(r)
      out.rgb.append(g)
      out.rgb.append(b)
      rows += 1
    }
    guard out.size >= 2, sawTableStart else { throw PocketVideoLutError.notA3DCube }
    let expected = out.size * out.size * out.size
    guard rows == expected else { throw PocketVideoLutError.wrongCount(expected: expected, got: rows) }
    return out
  }

  private static func triple(_ parts: ArraySlice<Substring>, line: Int) throws -> SIMD3<Float> {
    let values = parts.prefix(3).compactMap { Float($0) }
    guard values.count == 3 else { throw PocketVideoLutError.badNumber(line: line) }
    return SIMD3(values[0], values[1], values[2])
  }
}

/// Process-wide LUT registry (`loadLut` / `unloadLut`). Thread-safe.
final class PocketVideoLutRegistry {
  static let shared = PocketVideoLutRegistry()
  private let lock = NSLock()
  private var luts: [String: PocketVideoLut] = [:]

  func lut(_ id: String?) -> PocketVideoLut? {
    guard let id else { return nil }
    lock.lock()
    defer { lock.unlock() }
    return luts[id]
  }

  /// Parses and uploads; returns the cube size.
  func load(id: String, cubeText: String) throws -> Int {
    let parsed = try PocketVideoCubeParser.parse(cubeText)
    guard let device = PocketVideoMetal.shared?.device else { throw PocketVideoLutError.noDevice }
    let n = parsed.size
    let descriptor = MTLTextureDescriptor()
    descriptor.textureType = .type3D
    descriptor.pixelFormat = .rgba16Float
    descriptor.width = n
    descriptor.height = n
    descriptor.depth = n
    descriptor.usage = .shaderRead
    descriptor.storageMode = .shared
    guard let texture = device.makeTexture(descriptor: descriptor) else { throw PocketVideoLutError.noDevice }
    // RGBA half floats, x = R (fastest), y = G, z = B — the .cube order.
    // Float16 is unavailable on x86_64 simulators, so convert bits by hand.
    let one = pocketVideoHalfBits(1)
    var halves = [UInt16](repeating: one, count: n * n * n * 4)
    for i in 0..<(n * n * n) {
      halves[i * 4] = pocketVideoHalfBits(parsed.rgb[i * 3])
      halves[i * 4 + 1] = pocketVideoHalfBits(parsed.rgb[i * 3 + 1])
      halves[i * 4 + 2] = pocketVideoHalfBits(parsed.rgb[i * 3 + 2])
    }
    halves.withUnsafeBytes { raw in
      texture.replace(
        region: MTLRegionMake3D(0, 0, 0, n, n, n), mipmapLevel: 0, slice: 0,
        withBytes: raw.baseAddress!, bytesPerRow: n * 8, bytesPerImage: n * n * 8)
    }
    let lut = PocketVideoLut(
      id: id, size: n, domainMin: parsed.domainMin, domainMax: parsed.domainMax, texture: texture)
    lock.lock()
    luts[id] = lut
    lock.unlock()
    return n
  }

  func unload(_ id: String) {
    lock.lock()
    luts[id] = nil
    lock.unlock()
  }
}

/// IEEE 754 binary32 → binary16 bits, round-to-nearest, clamped to the half range.
func pocketVideoHalfBits(_ value: Float) -> UInt16 {
  let v = value.isFinite ? min(max(value, -65504), 65504) : 0
  let bits = v.bitPattern
  let sign = UInt16((bits >> 16) & 0x8000)
  let exponent = Int((bits >> 23) & 0xff) - 127 + 15
  var mantissa = bits & 0x7f_ffff
  if exponent <= 0 {
    // Subnormal half (or zero).
    if exponent < -10 { return sign }
    mantissa |= 0x80_0000
    let shift = UInt32(14 - exponent)
    var half = mantissa >> shift
    if (mantissa >> (shift - 1)) & 1 == 1 { half += 1 }
    return sign | UInt16(half)
  }
  var half = UInt32(exponent) << 10 | (mantissa >> 13)
  if mantissa & 0x1000 != 0 { half += 1 }  // round; a carry into the exponent is correct
  return sign | UInt16(min(half, 0x7bff))
}
