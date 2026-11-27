import AVFoundation
import CoreImage
import CoreVideo
import Foundation
import Vision
import os

// The editor's face stage (iOS): Smooth / Brighten / Slim / Eyes / Auto on the full source frame,
// after colour and before geometry, in preview (the player item's composition) and export alike.
// Maths: src/core/edit/face.ts via PocketFaceMath.swift. Pixels: two Core Image Metal kernels
// (stitchable, compiled at runtime from source like PocketVideoShaders, so the pod ships no
// .metallib): `pocketFaceSkin` (edge-keeping smoothing and the skin lift under the skin mask) and
// `pocketFaceWarp` (the jaw pulled in, the eyes magnified), each run only over the face's bounds
// and composited over the frame, so everything else is the input untouched.

/// Core Image works in linear light (extended range for HDR); the kernels work on pow(c, 1/2.2),
/// close to the Rec.709 / sRGB code values the shared maths is tuned for, and decode after.
/// Values above 1 (HDR highlights) pass the lift untouched.
private let pocketFaceKernelSource = """
#include <CoreImage/CoreImage.h>
using namespace metal;

static float3 pf_enc(float3 c) { return pow(max(c, float3(0.0)), float3(1.0 / 2.2)); }
static float3 pf_dec(float3 e) { return pow(max(e, float3(0.0)), float3(2.2)); }

static float2 pf_chroma(float3 c) {
  return float2(dot(c, float3(-0.168736, -0.331264, 0.5)), dot(c, float3(0.5, -0.418688, -0.081312)));
}

static float pf_ellipse(float2 p, float4 e, float2 axis) {
  float2 d = p - e.xy;
  return length(float2(dot(d, axis), dot(d, float2(-axis.y, axis.x))) / max(e.zw, float2(0.001)));
}

static void pf_edge(float2 p, float2 a, float2 b, thread float &nearest, thread bool &inside) {
  float2 e = b - a;
  float2 w = p - a;
  float2 h = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-9), 0.0, 1.0);
  nearest = min(nearest, dot(h, h));
  if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
}

static float3 pf_sample(coreimage::sampler src, float2 p) { return pf_enc(src.sample(src.transform(p)).rgb); }

static float3 pf_lift(float3 e, float amount) {
  float3 c = min(e, float3(1.0));
  float3 up = max(pow(max(c, float3(0.0)), float3(1.0 - amount)) - c, float3(0.0));
  return e + up * (float3(1.0) - smoothstep(float3(0.8), float3(1.0), c));
}

// amounts: smooth, brighten, smoothRadius, feather · frame: axis.xy · holes, mouth: x, y, rx, ry
// skin: the cheeks' colour (encoded) · o0…o8: the outline, two points each.
[[stitchable]] float4 pocketFaceSkin(coreimage::sampler src, float4 amounts, float4 frame, float4 holeA, float4 holeB, float4 mouth, float4 skinColour,
                                     float4 o0, float4 o1, float4 o2, float4 o3, float4 o4, float4 o5, float4 o6, float4 o7, float4 o8,
                                     coreimage::destination dest) {
  float2 p = dest.coord();
  float4 raw = src.sample(src.transform(p));
  float4 oval[9] = { o0, o1, o2, o3, o4, o5, o6, o7, o8 };
  float nearest = 1e20;
  bool inside = false;
  float2 prev = o8.zw;
  for (int i = 0; i < 9; i++) {
    pf_edge(p, oval[i].xy, prev, nearest, inside);
    pf_edge(p, oval[i].zw, oval[i].xy, nearest, inside);
    prev = oval[i].zw;
  }
  float sd = (inside ? -1.0 : 1.0) * sqrt(nearest);
  float feather = amounts.w;
  float glow = 1.0 - smoothstep(-feather * 2.0, feather * 1.5, sd);
  if (glow <= 0.0) return raw;
  float face = 1.0 - smoothstep(-feather, feather * 0.25, sd);
  float2 axis = frame.xy;
  float holes = smoothstep(1.0, 1.35, pf_ellipse(p, holeA, axis)) * smoothstep(1.0, 1.35, pf_ellipse(p, holeB, axis))
    * smoothstep(1.0, 1.3, pf_ellipse(p, mouth, axis));
  float3 c = pf_enc(raw.rgb);
  float tone = 1.0 - smoothstep(0.05, 0.13, distance(pf_chroma(c), pf_chroma(skinColour.rgb)));
  float skin = face * holes * tone;
  float3 rgb = c;
  if (amounts.x > 0.0 && skin > 0.0) {
    float3 sum = c;
    float total = 1.0;
    float2 start = float2(1.0, 0.0);
    for (int ring = 1; ring <= 3; ring++) {
      float reach = amounts.z * float(ring) / 3.0;
      float falloff = exp(-float(ring * ring) / 6.0);
      start = float2(start.x * 0.92388 - start.y * 0.38268, start.x * 0.38268 + start.y * 0.92388);
      float2 dir = start;
      for (int k = 0; k < 8; k++) {
        float3 s = pf_sample(src, p + dir * reach);
        float3 d = s - c;
        float w = falloff * exp(-dot(d, d) * 30.0);
        sum += s * w;
        total += w;
        dir = float2(dir.x * 0.70711 - dir.y * 0.70711, dir.x * 0.70711 + dir.y * 0.70711);
      }
    }
    rgb = mix(rgb, sum / total, float3(amounts.x * skin));
  }
  if (amounts.y > 0.0) rgb = pf_lift(rgb, amounts.y * glow * (0.85 + 0.15 * holes) * (0.35 + 0.65 * tone));
  return float4(pf_dec(rgb), raw.a);
}

static float2 pf_push(float2 p, float4 push, float r2) {
  float2 d = p - push.xy;
  float d2 = dot(d, d);
  if (d2 >= r2 || dot(push.zw, push.zw) <= 0.0) return float2(0.0);
  float w = 1.0 - d2 / r2;
  return (w * w) * push.zw;
}

static float2 pf_magnify(float2 p, float4 eye, float k) {
  float2 d = p - eye.xy;
  float r = length(d) / max(eye.z, 0.001);
  if (r >= 1.0) return float2(0.0);
  float m = 1.0 - r * r;
  return d * (m * m * k);
}

// eyes: x, y, radius · shape: magnify, pushRadius · p0…p5: x, y, dx, dy.
[[stitchable]] float4 pocketFaceWarp(coreimage::sampler src, float4 eyeA, float4 eyeB, float4 shape,
                                     float4 p0, float4 p1, float4 p2, float4 p3, float4 p4, float4 p5,
                                     coreimage::destination dest) {
  float2 p = dest.coord();
  float r2 = shape.y * shape.y;
  float2 q = p - pf_push(p, p0, r2) - pf_push(p, p1, r2) - pf_push(p, p2, r2) - pf_push(p, p3, r2) - pf_push(p, p4, r2) - pf_push(p, p5, r2);
  if (shape.x > 0.0) q -= pf_magnify(p, eyeA, shape.x) + pf_magnify(p, eyeB, shape.x);
  return src.sample(src.transform(q));
}
"""

/// The two kernels, compiled once (nil when Core Image refuses them: the stage then passes frames through).
private enum PocketFaceKernels {
  static let log = Logger(subsystem: "PocketNative", category: "PocketFace")

  static let all: (skin: CIKernel, warp: CIKernel)? = {
    do {
      let kernels = try CIKernel.kernels(withMetalString: pocketFaceKernelSource)
      guard let skin = kernels.first(where: { $0.name == "pocketFaceSkin" }), let warp = kernels.first(where: { $0.name == "pocketFaceWarp" }) else {
        log.error("face kernels missing from the compiled library")
        return nil
      }
      return (skin, warp)
    } catch {
      log.error("face kernels did not compile: \(String(describing: error), privacy: .public)")
      return nil
    }
  }()

  static func vec(_ a: CGFloat, _ b: CGFloat, _ c: CGFloat, _ d: CGFloat) -> CIVector { CIVector(x: a, y: b, z: c, w: d) }
  static func vec(_ e: PocketFaceEllipse) -> CIVector { CIVector(x: e.x, y: e.y, z: e.rx, w: e.ry) }

  /// One face over `image` (Core Image pixels, y up). `skin`: the cheeks' colour, encoded 0…1.
  static func apply(_ image: CIImage, _ g: PocketFaceGeometry, skin: SIMD3<Float>) -> CIImage {
    guard let kernels = all else { return image }
    let area = g.bounds.intersection(image.extent).integral
    guard !area.isNull, area.width >= 2, area.height >= 2 else { return image }
    var out = image
    if g.smooth > 0 || g.brighten > 0 {
      let reach = g.smoothRadius + 2
      var args: [Any] = [
        out,
        vec(g.smooth, g.brighten, g.smoothRadius, g.feather),
        vec(g.axis.x, g.axis.y, 0, 0),
        vec(g.eyeHoles[0]), vec(g.eyeHoles[1]), vec(g.mouth),
        vec(CGFloat(skin.x), CGFloat(skin.y), CGFloat(skin.z), 1),
      ]
      for i in stride(from: 0, to: 18, by: 2) { args.append(vec(g.oval[i].x, g.oval[i].y, g.oval[i + 1].x, g.oval[i + 1].y)) }
      if let skinned = kernels.skin.apply(extent: area, roiCallback: { _, r in r.insetBy(dx: -reach, dy: -reach) }, arguments: args) {
        out = skinned.composited(over: out)
      }
    }
    let pushing = g.pushes.contains { $0.1.dx != 0 || $0.1.dy != 0 }
    if g.magnify > 0 || pushing {
      var reach: CGFloat = 2
      for push in g.pushes { reach = max(reach, hypot(push.1.dx, push.1.dy) + 2) }
      for eye in g.eyes { reach = max(reach, eye.1 * g.magnify + 2) }
      var args: [Any] = [
        out,
        vec(g.eyes[0].0.x, g.eyes[0].0.y, g.eyes[0].1, 0),
        vec(g.eyes[1].0.x, g.eyes[1].0.y, g.eyes[1].1, 0),
        vec(g.magnify, g.pushRadius, 0, 0),
      ]
      for push in g.pushes { args.append(vec(push.0.x, push.0.y, push.1.dx, push.1.dy)) }
      if let warped = kernels.warp.apply(extent: area, roiCallback: { _, r in r.insetBy(dx: -reach, dy: -reach) }, arguments: args) {
        out = warped.composited(over: out)
      }
    }
    return out.cropped(to: image.extent)
  }
}

/// Apple Vision's face landmarks (`VNDetectFaceLandmarksRequest`: contour, eyes, pupils, lips,
/// nose) mapped onto the MediaPipe points the shared maths uses (FACE_LANDMARK_INDICES), up to
/// three faces, the largest first. Vision has no forehead, so the top of the outline is an arc over
/// the eyes. Adapted from the Sondr editor's VisionFaceEngine (fav-devs/ai-cut, same owner).
enum PocketFaceVision {
  /// Faces in an upright BGRA picture; points normalized with a top-left origin.
  static func detect(_ buffer: CVPixelBuffer, request: VNDetectFaceLandmarksRequest) -> [PocketDetectedFace] {
    let width = Double(CVPixelBufferGetWidth(buffer))
    let height = Double(CVPixelBufferGetHeight(buffer))
    do {
      try VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .up, options: [:]).perform([request])
    } catch {
      return []
    }
    let faces = (request.results ?? []).sorted { $0.boundingBox.width * $0.boundingBox.height > $1.boundingBox.width * $1.boundingBox.height }
    var out: [PocketDetectedFace] = []
    for face in faces.prefix(PocketFaceMath.maxFaces) {
      guard let points = map(face, width: width, height: height) else { continue }
      out.append(PocketDetectedFace(points: points, skin: skinColour(buffer, points)))
    }
    return out
  }

  private static func map(_ face: VNFaceObservation, width: Double, height: Double) -> [Float]? {
    guard let landmarks = face.landmarks, let contour = landmarks.faceContour, let eyeA = landmarks.leftEye, let eyeB = landmarks.rightEye,
      let lips = landmarks.outerLips, let nose = landmarks.nose
    else { return nil }
    let size = CGSize(width: width, height: height)
    // Vision's points have their origin at the bottom left; flip to top-left picture pixels.
    func pixels(_ region: VNFaceLandmarkRegion2D) -> [SIMD2<Double>] {
      region.pointsInImage(imageSize: size).map { SIMD2(Double($0.x), height - Double($0.y)) }
    }
    func centre(_ points: [SIMD2<Double>]) -> SIMD2<Double> { points.reduce(.zero, +) / Double(max(1, points.count)) }
    func length(_ v: SIMD2<Double>) -> Double { (v * v).sum().squareRoot() }
    let eyesA = pixels(eyeA), eyesB = pixels(eyeB), mouth = pixels(lips), jaw = pixels(contour), nosePoints = pixels(nose)
    guard !eyesA.isEmpty, !eyesB.isEmpty, !mouth.isEmpty, jaw.count >= 3, !nosePoints.isEmpty else { return nil }

    // The face's own directions: up (mouth to eyes) and the picture-left side of an upright face,
    // which is the person's right (MediaPipe's "right").
    let eyesMiddle = (centre(eyesA) + centre(eyesB)) / 2
    var up = eyesMiddle - centre(mouth)
    up /= max(1e-6, length(up))
    let right = SIMD2(up.y, -up.x)
    let along = { (p: SIMD2<Double>) in (p * right).sum() }
    let across = { (p: SIMD2<Double>) in (p * up).sum() }
    let (rightEye, leftEye) = along(centre(eyesA)) > along(centre(eyesB)) ? (eyesA, eyesB) : (eyesB, eyesA)
    func extreme(_ points: [SIMD2<Double>], _ key: (SIMD2<Double>) -> Double, largest: Bool) -> SIMD2<Double> {
      (largest ? points.max(by: { key($0) < key($1) }) : points.min(by: { key($0) < key($1) })) ?? centre(points)
    }
    let pupils = [landmarks.rightPupil, landmarks.leftPupil].compactMap { $0 }.flatMap(pixels)
    func pupil(near eye: [SIMD2<Double>]) -> SIMD2<Double> {
      let middle = centre(eye)
      return pupils.min(by: { length($0 - middle) < length($1 - middle) }) ?? middle
    }

    // The outline: the jaw from the person's left side through the chin to their right (oval
    // positions 4 to 14), then an arc over the forehead back round (positions 15 to 3).
    let jawLine = along(jaw.first!) < along(jaw.last!) ? jaw : Array(jaw.reversed())
    func resampled(_ line: [SIMD2<Double>], count: Int) -> [SIMD2<Double>] {
      var lengths = [0.0]
      for i in 1..<line.count { lengths.append(lengths[i - 1] + length(line[i] - line[i - 1])) }
      let total = max(1e-6, lengths.last!)
      return (0..<count).map { k in
        let target = total * Double(k) / Double(count - 1)
        var i = 1
        while i < line.count - 1 && lengths[i] < target { i += 1 }
        let span = max(1e-6, lengths[i] - lengths[i - 1])
        let t = min(1, max(0, (target - lengths[i - 1]) / span))
        return line[i - 1] + (line[i] - line[i - 1]) * t
      }
    }
    let lower = resampled(jawLine, count: 11)
    let sideL = lower.first!, sideR = lower.last!
    let temples = (sideL + sideR) / 2
    let chin = lower[5]
    let halfWidth = length(sideL - sideR) / 2
    let rise = max(halfWidth, length(temples - chin) * 0.75)
    let upper = (1...7).map { k -> SIMD2<Double> in
      let angle = Double(k) * Double.pi / 8
      return temples + right * (cos(angle) * halfWidth) + up * (sin(angle) * rise)
    }
    var oval = [SIMD2<Double>](repeating: .zero, count: 18)
    for (k, point) in lower.enumerated() { oval[4 + k] = point }
    for (k, point) in upper.enumerated() { oval[(15 + k) % 18] = point }

    var named: [SIMD2<Double>] = oval
    named.append(extreme(rightEye, along, largest: true))
    named.append(extreme(rightEye, along, largest: false))
    named.append(extreme(rightEye, across, largest: true))
    named.append(extreme(rightEye, across, largest: false))
    named.append(pupil(near: rightEye))
    named.append(extreme(leftEye, along, largest: false))
    named.append(extreme(leftEye, along, largest: true))
    named.append(extreme(leftEye, across, largest: true))
    named.append(extreme(leftEye, across, largest: false))
    named.append(pupil(near: leftEye))
    let mouthRight = extreme(mouth, along, largest: true)
    let mouthLeft = extreme(mouth, along, largest: false)
    named.append(mouthRight)
    named.append(mouthLeft)
    named.append(extreme(mouth, across, largest: true))
    named.append(extreme(mouth, across, largest: false))
    named.append(extreme(nosePoints, across, largest: false))
    // Cheek apples: between each eye and that side's mouth corner, a little out.
    named.append((centre(rightEye) + mouthRight) / 2 + right * (halfWidth * 0.15))
    named.append((centre(leftEye) + mouthLeft) / 2 - right * (halfWidth * 0.15))
    var points = [Float]()
    points.reserveCapacity(named.count * 2)
    for p in named {
      points.append(Float(p.x / width))
      points.append(Float(p.y / height))
    }
    return points
  }

  /// The two cheek apples' mean colour (5 × 5 each) in the BGRA picture, 0…1.
  private static func skinColour(_ buffer: CVPixelBuffer, _ points: [Float]) -> SIMD3<Float> {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) else { return SIMD3(0.5, 0.5, 0.5) }
    let w = CVPixelBufferGetWidth(buffer)
    let h = CVPixelBufferGetHeight(buffer)
    let row = CVPixelBufferGetBytesPerRow(buffer)
    var sum = SIMD3<Float>(0, 0, 0)
    var n: Float = 0
    for k in [33, 34] {
      let cx = Int((points[k * 2] * Float(w)).rounded())
      let cy = Int((points[k * 2 + 1] * Float(h)).rounded())
      for dy in -2...2 {
        for dx in -2...2 {
          let x = cx + dx
          let y = cy + dy
          guard x >= 0, y >= 0, x < w, y < h else { continue }
          let px = base + y * row + x * 4
          sum += SIMD3(Float(px[2]), Float(px[1]), Float(px[0])) / 255
          n += 1
        }
      }
    }
    return n > 0 ? sum / n : SIMD3(0.5, 0.5, 0.5)
  }
}

/// Face retouch (Smooth / Brighten / Slim / Eyes / Auto) on the source frame.
///
/// Landmarks: the stage's input frame rendered small (640 on the long side, upright, sRGB BGRA)
/// into its own buffer, through Vision, into a `PocketFaceTracker`.
/// - Preview: at most every 0.1 s and only while the detector is free (a frame offered while it
///   is busy is not analysed), on its own queue; frames in between are drawn from the tracker
///   (interpolated, briefly extrapolated, held over misses). Reports face counts (`onFaces`) and
///   asks for a redraw when a paused frame went out before its landmarks (`onRedraw`).
/// - Export: every frame, inline.
/// No detection while every strength is 0, unless `probe` (the Face panel is open).
final class PocketFaceRetouchStage: PocketEditFrameStage, @unchecked Sendable {
  enum Mode { case preview, export }

  private static let previewInterval: CFTimeInterval = 0.1
  private static let readLongSide: CGFloat = 640

  let mode: Mode
  /// Preview: faces in the latest analysed frame, when the count changes (any thread).
  var onFaces: ((Int) -> Void)?
  /// Preview: landmarks arrived for the frame on screen after it was drawn without them.
  var onRedraw: (() -> Void)?

  private let lock = NSLock()
  private var params = PocketFaceParams()
  private var probe = false
  private var tracker: PocketFaceTracker?
  private var busy = false
  private var lastDetect: CFTimeInterval = 0
  private var lastCount = -1
  private var drawnTime = Double.nan
  private var drawnFaces = 0
  private var buffer: CVPixelBuffer?
  private let request = VNDetectFaceLandmarksRequest()
  private let queue = DispatchQueue(label: "pocket.edit.face", qos: .userInitiated)
  private lazy var context = CIContext(options: [.cacheIntermediates: false])

  init(mode: Mode = .export) {
    self.mode = mode
  }

  func update(_ params: PocketFaceParams, probe: Bool = false) {
    lock.lock()
    let wasLooking = !self.params.isZero || self.probe
    self.params = params
    self.probe = probe
    // Starting to look again: report the next count even if it is the last one reported.
    if !wasLooking && (!params.isZero || probe) { lastCount = -1 }
    lock.unlock()
  }

  var isActive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !params.isZero || probe
  }

  func apply(_ image: CIImage, at time: CMTime) -> CIImage {
    lock.lock()
    let params = self.params
    let probe = self.probe
    lock.unlock()
    if params.isZero && !probe { return image }
    let extent = image.extent
    guard extent.width >= 16, extent.height >= 16, extent.width.isFinite, extent.height.isFinite else { return image }
    let t = time.seconds
    let tracker = trackerFor(extent)
    detect(image, t: t, tracker: tracker)
    var out = image
    var drawn = 0
    if !params.isZero {
      for face in tracker.sample(t).prefix(PocketFaceMath.maxFaces) {
        // Normalized top-left → Core Image pixels (y up).
        var px = [CGPoint]()
        px.reserveCapacity(PocketFaceMath.pointCount)
        for i in 0..<PocketFaceMath.pointCount {
          px.append(CGPoint(x: extent.minX + CGFloat(face.points[i * 2]) * extent.width, y: extent.maxY - CGFloat(face.points[i * 2 + 1]) * extent.height))
        }
        let strengths = PocketFaceMath.resolve(params, faceSize: face.faceSize, skinLuma: face.skinLuma)
        guard let g = PocketFaceMath.geometry(px, strengths, weight: face.weight) else { continue }
        out = PocketFaceKernels.apply(out, g, skin: face.skin)
        drawn += 1
      }
    }
    lock.lock()
    drawnTime = t
    drawnFaces = drawn
    lock.unlock()
    return out
  }

  private func trackerFor(_ extent: CGRect) -> PocketFaceTracker {
    lock.lock()
    defer { lock.unlock() }
    let aspect = Float(extent.width / extent.height)
    if let tracker, abs(tracker.aspect - aspect) < 0.001 { return tracker }
    let fresh = PocketFaceTracker(aspect: aspect)
    tracker = fresh
    return fresh
  }

  /// Landmarks for this frame: queued (preview) or inline (export).
  private func detect(_ image: CIImage, t: Double, tracker: PocketFaceTracker) {
    if mode == .export {
      // One frame at a time, in order (the buffer and the request are shared).
      lock.lock()
      defer { lock.unlock() }
      guard let small = render(image) else { return }
      tracker.update(t, PocketFaceVision.detect(small, request: request))
      return
    }
    let now = CACurrentMediaTime()
    lock.lock()
    guard !busy, now - lastDetect >= Self.previewInterval, let small = render(image) else {
      lock.unlock()
      return
    }
    busy = true
    lastDetect = now
    lock.unlock()
    queue.async { [weak self] in
      guard let self else { return }
      let found = PocketFaceVision.detect(small, request: self.request)
      tracker.update(t, found)
      self.lock.lock()
      self.busy = false
      let changed = found.count != self.lastCount
      self.lastCount = found.count
      let redraw = self.drawnTime == t && !self.params.isZero && self.drawnFaces != min(PocketFaceMath.maxFaces, tracker.sample(t).count)
      self.lock.unlock()
      if changed { self.onFaces?(found.count) }
      if redraw { self.onRedraw?() }
    }
  }

  /// The frame `readLongSide` on its long side into this stage's BGRA buffer (sRGB, upright, top
  /// row first). Called with `lock` held; the buffer is reused (one analysis in flight at a time).
  private func render(_ image: CIImage) -> CVPixelBuffer? {
    let extent = image.extent
    let scale = min(1, Self.readLongSide / max(extent.width, extent.height))
    let w = max(2, Int((extent.width * scale).rounded()) & ~1)
    let h = max(2, Int((extent.height * scale).rounded()) & ~1)
    if buffer == nil || CVPixelBufferGetWidth(buffer!) != w || CVPixelBufferGetHeight(buffer!) != h {
      var fresh: CVPixelBuffer?
      let attrs: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary, kCVPixelBufferMetalCompatibilityKey: true]
      CVPixelBufferCreate(kCFAllocatorDefault, w, h, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &fresh)
      buffer = fresh
    }
    guard let buffer else { return nil }
    let small = image
      .transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
      .transformed(by: CGAffineTransform(scaleX: CGFloat(w) / extent.width, y: CGFloat(h) / extent.height))
      .cropped(to: CGRect(x: 0, y: 0, width: w, height: h))
    let destination = CIRenderDestination(pixelBuffer: buffer)
    destination.colorSpace = CGColorSpace(name: CGColorSpace.sRGB)
    do {
      let task = try context.startTask(toRender: small, from: small.extent, to: destination, at: .zero)
      _ = try task.waitUntilCompleted()
    } catch {
      return nil
    }
    return buffer
  }
}
