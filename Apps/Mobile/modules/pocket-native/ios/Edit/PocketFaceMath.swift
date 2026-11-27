import CoreGraphics
import Foundation

// Face retouch maths for the iOS face stage: a line-for-line port of src/core/edit/face.ts (Auto,
// the retouch geometry and the One-Euro face tracker). Keep the numbers in step with that file;
// its tests pin them. Android's port is PocketFaceMath.kt.

/// One face from the detector: `pointCount` points (normalized, top-left origin) and the cheeks' colour.
struct PocketDetectedFace {
  var points: [Float]
  var skin: SIMD3<Float>
}

/// A tracked face at some time: normalized points, the fade weight, and what Auto reads.
struct PocketTrackedFace {
  var points: [Float]
  var weight: Float
  var skin: SIMD3<Float>
  var faceSize: Float
  var skinLuma: Float
}

/// An ellipse along (rx) and across (ry) the eye line.
struct PocketFaceEllipse {
  var x: CGFloat
  var y: CGFloat
  var rx: CGFloat
  var ry: CGFloat
}

/// One face's retouch in frame pixels (`RetouchGeometry` in face.ts).
struct PocketFaceGeometry {
  var smooth: CGFloat
  var magnify: CGFloat
  var brighten: CGFloat
  var bounds: CGRect
  var axis: CGPoint
  var faceWidth: CGFloat
  /// 18 points.
  var oval: [CGPoint]
  /// x, y, radius: the person's right eye, then left.
  var eyes: [(CGPoint, CGFloat)]
  var eyeHoles: [PocketFaceEllipse]
  var mouth: PocketFaceEllipse
  var cheeks: [CGPoint]
  /// Point and displacement, three each side.
  var pushes: [(CGPoint, CGVector)]
  var pushRadius: CGFloat
  var smoothRadius: CGFloat
  var feather: CGFloat
}

enum PocketFaceMath {
  static let pointCount = 35
  static let maxFaces = 3

  private static let ovalCount = 18
  private static let rightEye = 18
  private static let leftEye = 23
  private static let mouth = 28
  private static let rightCheek = 33
  private static let leftCheek = 34
  private static let forehead = 0
  private static let leftSide = 4
  private static let rightSide = 14
  private static let chin = 9
  private static let leftJaw = [5, 6, 7]
  private static let rightJaw = [13, 12, 11]

  private static let limitSmooth: CGFloat = 0.9
  private static let limitMagnify: CGFloat = 0.22
  private static let limitBrighten: CGFloat = 0.28
  private static let limitSlim: [CGFloat] = [0.032, 0.028, 0.012]
  private static let maxPushOfRadius: CGFloat = 0.2

  struct Strengths {
    var smooth: Float
    var brighten: Float
    var slim: Float
    var eyes: Float
  }

  private static func c01(_ v: Float) -> Float { v.isNaN ? 0 : min(1, max(0, v)) }

  static func auto(_ amount: Float, faceSize: Float, skinLuma: Float) -> Strengths {
    let a = c01(amount)
    if a <= 0 { return Strengths(smooth: 0, brighten: 0, slim: 0, eyes: 0) }
    let close = c01((faceSize - 0.12) / (0.45 - 0.12))
    let dim = c01((0.58 - skinLuma) / 0.3)
    let bright = c01((skinLuma - 0.72) / 0.14)
    return Strengths(smooth: a * (0.3 + 0.25 * close), brighten: a * (0.08 + 0.52 * dim) * (1 - bright), slim: a * 0.18, eyes: a * (0.08 + 0.12 * close))
  }

  static func combine(_ a: Float, _ b: Float) -> Float {
    if b <= 0 { return c01(a) }
    if a <= 0 { return c01(b) }
    return 1 - (1 - c01(a)) * (1 - c01(b))
  }

  static func resolve(_ p: PocketFaceParams, faceSize: Float, skinLuma: Float) -> Strengths {
    let au = auto(Float(p.auto), faceSize: faceSize, skinLuma: skinLuma)
    return Strengths(
      smooth: combine(Float(p.smooth), au.smooth), brighten: combine(Float(p.brighten), au.brighten),
      slim: combine(Float(p.slim), au.slim), eyes: combine(Float(p.eyes), au.eyes))
  }

  static func luma(_ c: SIMD3<Float>) -> Float { 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z }

  /// `buildRetouchGeometry`: `px` are the face's points in frame pixels (any orientation of axes).
  static func geometry(_ px: [CGPoint], _ s: Strengths, weight: Float) -> PocketFaceGeometry? {
    guard px.count >= pointCount else { return nil }
    let fade = CGFloat(c01(weight))
    let smooth = CGFloat(c01(s.smooth)) * fade
    let slim = CGFloat(c01(s.slim)) * fade
    let eyes = CGFloat(c01(s.eyes)) * fade
    let brighten = CGFloat(c01(s.brighten)) * fade
    if smooth + slim + eyes + brighten < 1e-3 { return nil }
    func dist(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }
    func mid(_ a: CGPoint, _ b: CGPoint) -> CGPoint { CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2) }
    let faceWidth = dist(px[leftSide], px[rightSide])
    guard faceWidth >= 8 else { return nil }

    let rc = mid(px[rightEye], px[rightEye + 1])
    let lc = mid(px[leftEye], px[leftEye + 1])
    var eyeLine = hypot(lc.x - rc.x, lc.y - rc.y)
    if eyeLine <= 0 { eyeLine = 1 }
    let axis = CGPoint(x: (lc.x - rc.x) / eyeLine, y: (lc.y - rc.y) / eyeLine)
    func centre(_ corners: CGPoint, _ across: CGPoint) -> CGPoint {
      let along = (corners.x - across.x) * axis.x + (corners.y - across.y) * axis.y
      return CGPoint(x: across.x + axis.x * along, y: across.y + axis.y * along)
    }
    func eyeHole(_ e: Int) -> PocketFaceEllipse {
      let width = dist(px[e], px[e + 1])
      let c = centre(mid(px[e], px[e + 1]), mid(px[e + 2], px[e + 3]))
      return PocketFaceEllipse(x: c.x, y: c.y, rx: width / 2 * 1.35, ry: max(dist(px[e + 2], px[e + 3]) / 2 * 2, width * 0.3))
    }
    let mc = centre(mid(px[mouth], px[mouth + 1]), mid(px[mouth + 2], px[mouth + 3]))
    let mouthRx = dist(px[mouth], px[mouth + 1]) / 2 * 1.15
    let mouthShape = PocketFaceEllipse(x: mc.x, y: mc.y, rx: mouthRx, ry: max(dist(px[mouth + 2], px[mouth + 3]) / 2 * 1.25, mouthRx * 0.3))

    let pushRadius = faceWidth * 0.24
    let maxPush = pushRadius * maxPushOfRadius
    let top = px[forehead]
    let line = CGVector(dx: px[chin].x - top.x, dy: px[chin].y - top.y)
    var lineLength = line.dx * line.dx + line.dy * line.dy
    if lineLength <= 0 { lineLength = 1 }
    var pushes: [(CGPoint, CGVector)] = []
    for side in [leftJaw, rightJaw] {
      for (order, position) in side.enumerated() {
        let p = px[position]
        let along = min(1, max(0, ((p.x - top.x) * line.dx + (p.y - top.y) * line.dy) / lineLength))
        let tx = top.x + line.dx * along - p.x
        let ty = top.y + line.dy * along - p.y
        var length = hypot(tx, ty)
        if length <= 0 { length = 1 }
        let size = min(slim * limitSlim[order] * faceWidth, maxPush, length * 0.5)
        pushes.append((p, CGVector(dx: tx / length * size, dy: ty / length * size)))
      }
    }
    let eyeCircles = [(px[rightEye + 4], dist(px[rightEye], px[rightEye + 1]) * 1.15), (px[leftEye + 4], dist(px[leftEye], px[leftEye + 1]) * 1.15)]
    let smoothRadius = max(1, faceWidth * 0.028)
    let feather = faceWidth * 0.05
    var x0 = CGFloat.infinity, y0 = CGFloat.infinity, x1 = -CGFloat.infinity, y1 = -CGFloat.infinity
    func include(_ p: CGPoint, _ reach: CGFloat) {
      x0 = min(x0, p.x - reach); y0 = min(y0, p.y - reach); x1 = max(x1, p.x + reach); y1 = max(y1, p.y + reach)
    }
    for i in 0..<ovalCount { include(px[i], feather * 2 + smoothRadius) }
    for push in pushes { include(push.0, pushRadius) }
    for eye in eyeCircles { include(eye.0, eye.1) }
    return PocketFaceGeometry(
      smooth: smooth * limitSmooth, magnify: eyes * limitMagnify, brighten: brighten * limitBrighten,
      bounds: CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0), axis: axis, faceWidth: faceWidth,
      oval: Array(px[0..<ovalCount]), eyes: eyeCircles, eyeHoles: [eyeHole(rightEye), eyeHole(leftEye)], mouth: mouthShape,
      cheeks: [px[rightCheek], px[leftCheek]], pushes: pushes, pushRadius: pushRadius, smoothRadius: smoothRadius, feather: feather)
  }
}

/// `FaceTracker` (face.ts): matches detections to tracks, One-Euro smooths each face (one cutoff for
/// the whole face), holds a missed face then fades it, interpolates between detections and
/// extrapolates briefly past the last; a seek back or a long gap starts afresh. Thread-safe.
final class PocketFaceTracker: @unchecked Sendable {
  private let minCutoff = 1.2
  private let beta = 4.0
  private let derivativeCutoff = 1.0
  private let hold = 0.4
  private let fade = 0.3
  private let maxExtrapolate = 0.08
  let aspect: Float

  private final class Track {
    var filtered: [Float]
    var lastT: Double
    var lastSeen: Double
    var width: Float
    var skin: SIMD3<Float>
    var velocity = 0.0
    var history: [(t: Double, points: [Float])] = []
    init(_ points: [Float], t: Double, width: Float, skin: SIMD3<Float>) {
      filtered = points
      lastT = t
      lastSeen = t
      self.width = width
      self.skin = skin
      history = [(t, points)]
    }
  }

  private let lock = NSLock()
  private var tracks: [Track] = []
  private var lastUpdate = -Double.infinity

  init(aspect: Float) {
    self.aspect = aspect
  }

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return tracks.count
  }

  func reset() {
    lock.lock()
    tracks = []
    lastUpdate = -.infinity
    lock.unlock()
  }

  private func centre(_ p: [Float]) -> SIMD2<Float> {
    var c = SIMD2<Float>(0, 0)
    for i in 0..<18 { c += SIMD2(p[i * 2], p[i * 2 + 1]) }
    return c / 18
  }

  private func widthOf(_ p: [Float]) -> Float { hypot((p[8] - p[28]) * aspect, p[9] - p[29]) }

  private func alpha(_ cutoff: Double, _ dt: Double) -> Double { 1 / (1 + 1 / (2 * Double.pi * cutoff * dt)) }

  func update(_ t: Double, _ faces: [PocketDetectedFace]) {
    lock.lock()
    defer { lock.unlock() }
    if !tracks.isEmpty && (t < lastUpdate - 0.05 || t > lastUpdate + 1.5) {
      tracks = []
      lastUpdate = -.infinity
    }
    lastUpdate = tracks.isEmpty ? t : max(t, lastUpdate)
    var free = Set(tracks.indices)
    let sorted = faces.filter { $0.points.count >= PocketFaceMath.pointCount * 2 }.sorted { widthOf($0.points) > widthOf($1.points) }.prefix(PocketFaceMath.maxFaces)
    for face in sorted {
      let c = centre(face.points)
      let width = max(1e-4, widthOf(face.points))
      var best = -1
      var bestD = Float.greatestFiniteMagnitude
      for i in free {
        let tc = centre(tracks[i].filtered)
        let d = hypot((tc.x - c.x) * aspect, tc.y - c.y)
        if d < bestD && d < width * 0.6 {
          best = i
          bestD = d
        }
      }
      if best >= 0 {
        free.remove(best)
        step(tracks[best], t, face, width)
      } else if tracks.count < PocketFaceMath.maxFaces {
        tracks.append(Track(face.points, t: t, width: width, skin: face.skin))
      }
    }
    tracks.removeAll { t - $0.lastSeen > hold + fade }
  }

  private func step(_ tr: Track, _ t: Double, _ face: PocketDetectedFace, _ width: Float) {
    let dt = t > tr.lastT ? t - tr.lastT : 1.0 / 30
    let f = centre(tr.filtered)
    let c = centre(face.points)
    let speed = Double(hypot((c.x - f.x) * aspect, c.y - f.y)) / dt / Double(width)
    tr.velocity += alpha(derivativeCutoff, dt) * (speed - tr.velocity)
    let a = Float(alpha(minCutoff + beta * tr.velocity, dt))
    for i in tr.filtered.indices { tr.filtered[i] += a * (face.points[i] - tr.filtered[i]) }
    tr.width = width
    tr.skin += 0.35 * (face.skin - tr.skin)
    if t > tr.lastT || tr.history.isEmpty {
      tr.history.append((t, tr.filtered))
      if tr.history.count > 4 { tr.history.removeFirst() }
    } else {
      tr.history[tr.history.count - 1] = (tr.history[tr.history.count - 1].t, tr.filtered)
    }
    tr.lastT = max(tr.lastT, t)
    tr.lastSeen = max(tr.lastSeen, t)
  }

  func sample(_ t: Double) -> [PocketTrackedFace] {
    lock.lock()
    defer { lock.unlock() }
    var out: [PocketTrackedFace] = []
    for tr in tracks {
      let h = tr.history
      guard let last = h.last, let first = h.first else { continue }
      var points: [Float]
      if t >= last.t {
        points = last.points
        if h.count >= 2 {
          let prev = h[h.count - 2]
          let span = last.t - prev.t
          let ahead = min(t - last.t, maxExtrapolate)
          if span > 1e-4 && ahead > 0 {
            for i in points.indices { points[i] += Float(Double(last.points[i] - prev.points[i]) / span * ahead) }
          }
        }
      } else if t <= first.t {
        if first.t - t > 0.1 { continue }
        points = first.points
      } else {
        var i = h.count - 2
        while i > 0 && h[i].t > t { i -= 1 }
        let a = h[i]
        let b = h[i + 1]
        let f = Float((t - a.t) / max(1e-6, b.t - a.t))
        points = zip(a.points, b.points).map { $0 + ($1 - $0) * f }
      }
      let since = t - tr.lastSeen
      let weight = since <= hold ? 1.0 : max(0, 1 - (since - hold) / fade)
      if weight <= 0 { continue }
      out.append(PocketTrackedFace(points: points, weight: Float(weight), skin: tr.skin, faceSize: tr.width / min(1, aspect), skinLuma: PocketFaceMath.luma(tr.skin)))
    }
    return out
  }
}
