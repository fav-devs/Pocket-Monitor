package com.favdevs.pocketnative.edit

import kotlin.math.PI
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/*
 * Face retouch maths for the Android face stage: a line-for-line port of
 * src/core/edit/face.ts (Auto, the retouch geometry packed as the shader's uniforms, and the
 * One-Euro face tracker). Keep the numbers in step with that file; its tests pin them.
 */

/** One face from the landmarker: FACE_POINT_COUNT points (normalized, top-left) and the cheeks' colour. */
class PocketDetectedFace(val points: FloatArray, val skin: FloatArray)

/** A tracked face at some time: normalized points, the fade weight and what Auto reads. */
class PocketTrackedFace(val points: FloatArray, val weight: Float, val skin: FloatArray, val faceSize: Float, val skinLuma: Float)

object PocketFaceMath {
  const val POINTS = 35
  const val VEC4 = 25
  const val MAX_FACES = 3

  /** MediaPipe face-mesh indices of the points (FACE_LANDMARK_INDICES). */
  val LANDMARK_INDICES = intArrayOf(
    10, 297, 284, 389, 454, 361, 397, 379, 400, 152, 176, 150, 172, 132, 234, 162, 54, 67,
    33, 133, 159, 145, 468,
    263, 362, 386, 374, 473,
    61, 291, 0, 17,
    1,
    50, 280,
  )

  private const val OVAL_COUNT = 18
  private const val RIGHT_EYE = 18
  private const val LEFT_EYE = 23
  private const val MOUTH = 28
  private const val RIGHT_CHEEK = 33
  private const val LEFT_CHEEK = 34
  private const val FOREHEAD = 0
  private const val LEFT_SIDE = 4
  private const val RIGHT_SIDE = 14
  private const val CHIN = 9
  private val LEFT_JAW = intArrayOf(5, 6, 7)
  private val RIGHT_JAW = intArrayOf(13, 12, 11)

  private const val LIMIT_SMOOTH = 0.9f
  private const val LIMIT_MAGNIFY = 0.22f
  private const val LIMIT_BRIGHTEN = 0.28f
  private val LIMIT_SLIM = floatArrayOf(0.032f, 0.028f, 0.012f)
  private const val MAX_PUSH_OF_RADIUS = 0.2f

  class Strengths(val smooth: Float, val brighten: Float, val slim: Float, val eyes: Float)

  private fun c01(v: Float) = if (v.isNaN()) 0f else v.coerceIn(0f, 1f)

  fun auto(amount: Float, faceSize: Float, skinLuma: Float): Strengths {
    val a = c01(amount)
    if (a <= 0f) return Strengths(0f, 0f, 0f, 0f)
    val close = c01((faceSize - 0.12f) / (0.45f - 0.12f))
    val dim = c01((0.58f - skinLuma) / 0.3f)
    val bright = c01((skinLuma - 0.72f) / 0.14f)
    return Strengths(a * (0.3f + 0.25f * close), a * (0.08f + 0.52f * dim) * (1f - bright), a * 0.18f, a * (0.08f + 0.12f * close))
  }

  fun combine(a: Float, b: Float): Float = when {
    b <= 0f -> c01(a)
    a <= 0f -> c01(b)
    else -> 1f - (1f - c01(a)) * (1f - c01(b))
  }

  fun resolve(p: PocketFaceParams, faceSize: Float, skinLuma: Float): Strengths {
    val au = auto(p.auto, faceSize, skinLuma)
    return Strengths(combine(p.smooth, au.smooth), combine(p.brighten, au.brighten), combine(p.slim, au.slim), combine(p.eyes, au.eyes))
  }

  /**
   * One face's uniforms (VEC4 vec4s, `packFaceUniforms` layout) into `out` at `offset` from its
   * points in frame pixels; false when there's nothing to do (all strengths 0, or under 8 px wide).
   * `skin`: the measured colour, or null to have the shader sample the cheeks.
   */
  fun pack(px: FloatArray, s: Strengths, weight: Float, skin: FloatArray?, out: FloatArray, offset: Int): Boolean {
    if (px.size < POINTS * 2) return false
    val fade = c01(weight)
    val smooth = c01(s.smooth) * fade
    val slim = c01(s.slim) * fade
    val eyes = c01(s.eyes) * fade
    val brighten = c01(s.brighten) * fade
    if (smooth + slim + eyes + brighten < 1e-3f) return false
    fun x(i: Int) = px[i * 2]
    fun y(i: Int) = px[i * 2 + 1]
    fun dist(a: Int, b: Int) = hypot(x(a) - x(b), y(a) - y(b))
    val faceWidth = dist(LEFT_SIDE, RIGHT_SIDE)
    if (!(faceWidth >= 8f)) return false

    val rcx = (x(RIGHT_EYE) + x(RIGHT_EYE + 1)) / 2
    val rcy = (y(RIGHT_EYE) + y(RIGHT_EYE + 1)) / 2
    val lcx = (x(LEFT_EYE) + x(LEFT_EYE + 1)) / 2
    val lcy = (y(LEFT_EYE) + y(LEFT_EYE + 1)) / 2
    val eyeLine = hypot(lcx - rcx, lcy - rcy).takeIf { it > 0f } ?: 1f
    val ax = (lcx - rcx) / eyeLine
    val ay = (lcy - rcy) / eyeLine

    var o = offset
    fun put(a: Float, b: Float, c: Float, d: Float) {
      out[o] = a; out[o + 1] = b; out[o + 2] = c; out[o + 3] = d
      o += 4
    }
    // Ellipse centre: along the face from the corners' middle, across it from top/bottom's middle.
    fun ellipse(cornerX: Float, cornerY: Float, acrossX: Float, acrossY: Float, rx: Float, ry: Float) {
      val along = (cornerX - acrossX) * ax + (cornerY - acrossY) * ay
      put(acrossX + ax * along, acrossY + ay * along, rx, ry)
    }

    val smoothRadius = max(1f, faceWidth * 0.028f)
    val feather = faceWidth * 0.05f
    val pushRadius = faceWidth * 0.24f

    // Pushes first (bounds need them).
    val pushes = FloatArray(24)
    val fx = x(FOREHEAD)
    val fy = y(FOREHEAD)
    val lx = x(CHIN) - fx
    val ly = y(CHIN) - fy
    val lineLength = (lx * lx + ly * ly).takeIf { it > 0f } ?: 1f
    var k = 0
    for (side in arrayOf(LEFT_JAW, RIGHT_JAW)) {
      for (order in 0 until 3) {
        val px0 = x(side[order])
        val py0 = y(side[order])
        val along = c01(((px0 - fx) * lx + (py0 - fy) * ly) / lineLength)
        val tx = fx + lx * along - px0
        val ty = fy + ly * along - py0
        val length = hypot(tx, ty).takeIf { it > 0f } ?: 1f
        val size = min(min(slim * LIMIT_SLIM[order] * faceWidth, pushRadius * MAX_PUSH_OF_RADIUS), length * 0.5f)
        pushes[k] = px0; pushes[k + 1] = py0; pushes[k + 2] = tx / length * size; pushes[k + 3] = ty / length * size
        k += 4
      }
    }
    val eyeR = dist(RIGHT_EYE, RIGHT_EYE + 1) * 1.15f
    val eyeL = dist(LEFT_EYE, LEFT_EYE + 1) * 1.15f

    var x0 = Float.POSITIVE_INFINITY
    var y0 = Float.POSITIVE_INFINITY
    var x1 = Float.NEGATIVE_INFINITY
    var y1 = Float.NEGATIVE_INFINITY
    fun include(px1: Float, py1: Float, reach: Float) {
      x0 = min(x0, px1 - reach); y0 = min(y0, py1 - reach); x1 = max(x1, px1 + reach); y1 = max(y1, py1 + reach)
    }
    for (i in 0 until OVAL_COUNT) include(x(i), y(i), feather * 2 + smoothRadius)
    for (i in 0 until 6) include(pushes[i * 4], pushes[i * 4 + 1], pushRadius)
    include(x(RIGHT_EYE + 4), y(RIGHT_EYE + 4), eyeR)
    include(x(LEFT_EYE + 4), y(LEFT_EYE + 4), eyeL)

    put(smooth * LIMIT_SMOOTH, eyes * LIMIT_MAGNIFY, brighten * LIMIT_BRIGHTEN, smoothRadius)
    put(x0, y0, x1, y1)
    put(ax, ay, feather, pushRadius)
    put(x(RIGHT_EYE + 4), y(RIGHT_EYE + 4), eyeR, 0f)
    put(x(LEFT_EYE + 4), y(LEFT_EYE + 4), eyeL, 0f)
    for (e in intArrayOf(RIGHT_EYE, LEFT_EYE)) {
      val width = dist(e, e + 1)
      ellipse(
        (x(e) + x(e + 1)) / 2, (y(e) + y(e + 1)) / 2,
        (x(e + 2) + x(e + 3)) / 2, (y(e + 2) + y(e + 3)) / 2,
        width / 2 * 1.35f, max(dist(e + 2, e + 3) / 2 * 2f, width * 0.3f),
      )
    }
    val mouthRx = dist(MOUTH, MOUTH + 1) / 2 * 1.15f
    ellipse(
      (x(MOUTH) + x(MOUTH + 1)) / 2, (y(MOUTH) + y(MOUTH + 1)) / 2,
      (x(MOUTH + 2) + x(MOUTH + 3)) / 2, (y(MOUTH + 2) + y(MOUTH + 3)) / 2,
      mouthRx, max(dist(MOUTH + 2, MOUTH + 3) / 2 * 1.25f, mouthRx * 0.3f),
    )
    if (skin != null) put(skin[0], skin[1], skin[2], 1f) else put(0f, 0f, 0f, 0f)
    for (i in 0 until 6) put(pushes[i * 4], pushes[i * 4 + 1], pushes[i * 4 + 2], pushes[i * 4 + 3])
    for (i in 0 until OVAL_COUNT step 2) put(x(i), y(i), x(i + 1), y(i + 1))
    put(x(RIGHT_CHEEK), y(RIGHT_CHEEK), x(LEFT_CHEEK), y(LEFT_CHEEK))
    return true
  }

  fun luma(rgb: FloatArray) = 0.2126f * rgb[0] + 0.7152f * rgb[1] + 0.0722f * rgb[2]
}

/**
 * `FaceTracker` (src/core/edit/face.ts): matches detections to tracks, One-Euro smooths each face
 * (one cutoff for the whole face), holds a missed face then fades it, interpolates between
 * detections and extrapolates briefly past the last; a seek back or a long gap starts afresh.
 * Thread-safe (the landmark worker updates, the GL thread samples).
 */
class PocketFaceTracker(private val aspect: Float) {
  private val minCutoff = 1.2
  private val beta = 4.0
  private val derivativeCutoff = 1.0
  private val hold = 0.4
  private val fade = 0.3
  private val maxExtrapolate = 0.08

  private class Sample(val t: Double, val points: FloatArray)

  private class Track(var filtered: FloatArray, var lastT: Double, var width: Float, val skin: FloatArray) {
    var velocity = 0.0
    var lastSeen = lastT
    val history = ArrayList<Sample>(5)
  }

  private val tracks = ArrayList<Track>()
  private var lastUpdate = Double.NEGATIVE_INFINITY

  @Synchronized
  fun reset() {
    tracks.clear()
    lastUpdate = Double.NEGATIVE_INFINITY
  }

  @get:Synchronized
  val count: Int get() = tracks.size

  private fun centre(p: FloatArray): FloatArray {
    var x = 0f
    var y = 0f
    for (i in 0 until 18) { x += p[i * 2]; y += p[i * 2 + 1] }
    return floatArrayOf(x / 18, y / 18)
  }

  private fun widthOf(p: FloatArray) = hypot((p[8] - p[28]) * aspect, p[9] - p[29])

  private fun alpha(cutoff: Double, dt: Double) = 1.0 / (1.0 + 1.0 / (2 * PI * cutoff * dt))

  @Synchronized
  fun update(t: Double, faces: List<PocketDetectedFace>) {
    if (tracks.isNotEmpty() && (t < lastUpdate - 0.05 || t > lastUpdate + 1.5)) reset()
    lastUpdate = if (tracks.isNotEmpty()) max(t, lastUpdate) else t
    val free = tracks.indices.toMutableSet()
    for (face in faces.sortedByDescending { widthOf(it.points) }.take(PocketFaceMath.MAX_FACES)) {
      val c = centre(face.points)
      val width = max(1e-4f, widthOf(face.points))
      var best = -1
      var bestD = Float.MAX_VALUE
      for (i in free) {
        val tc = centre(tracks[i].filtered)
        val d = hypot((tc[0] - c[0]) * aspect, tc[1] - c[1])
        if (d < bestD && d < width * 0.6f) { best = i; bestD = d }
      }
      if (best >= 0) {
        free.remove(best)
        step(tracks[best], t, face, width)
      } else if (tracks.size < PocketFaceMath.MAX_FACES) {
        val tr = Track(face.points.copyOf(), t, width, face.skin.copyOf())
        tr.history.add(Sample(t, face.points.copyOf()))
        tracks.add(tr)
      }
    }
    tracks.removeAll { t - it.lastSeen > hold + fade }
  }

  private fun step(tr: Track, t: Double, face: PocketDetectedFace, width: Float) {
    val dt = if (t > tr.lastT) t - tr.lastT else 1.0 / 30
    val f = centre(tr.filtered)
    val c = centre(face.points)
    val speed = hypot(((c[0] - f[0]) * aspect).toDouble(), (c[1] - f[1]).toDouble()) / dt / width
    tr.velocity += alpha(derivativeCutoff, dt) * (speed - tr.velocity)
    val a = alpha(minCutoff + beta * tr.velocity, dt).toFloat()
    for (i in tr.filtered.indices) tr.filtered[i] += a * (face.points[i] - tr.filtered[i])
    tr.width = width
    for (k in 0 until 3) tr.skin[k] += 0.35f * (face.skin[k] - tr.skin[k])
    if (t > tr.lastT || tr.history.isEmpty()) {
      tr.history.add(Sample(t, tr.filtered.copyOf()))
      if (tr.history.size > 4) tr.history.removeAt(0)
    } else {
      tr.history[tr.history.size - 1] = Sample(tr.history.last().t, tr.filtered.copyOf())
    }
    tr.lastT = max(tr.lastT, t)
    tr.lastSeen = max(tr.lastSeen, t)
  }

  @Synchronized
  fun sample(t: Double): List<PocketTrackedFace> {
    val out = ArrayList<PocketTrackedFace>(tracks.size)
    for (tr in tracks) {
      val h = tr.history
      if (h.isEmpty()) continue
      val last = h.last()
      val points: FloatArray
      if (t >= last.t) {
        points = last.points.copyOf()
        if (h.size >= 2) {
          val prev = h[h.size - 2]
          val span = last.t - prev.t
          val ahead = min(t - last.t, maxExtrapolate)
          if (span > 1e-4 && ahead > 0) for (i in points.indices) points[i] += ((last.points[i] - prev.points[i]) / span * ahead).toFloat()
        }
      } else if (t <= h[0].t) {
        if (h[0].t - t > 0.1) continue
        points = h[0].points.copyOf()
      } else {
        var i = h.size - 2
        while (i > 0 && h[i].t > t) i--
        val a = h[i]
        val b = h[i + 1]
        val f = ((t - a.t) / max(1e-6, b.t - a.t)).toFloat()
        points = FloatArray(a.points.size) { k -> a.points[k] + (b.points[k] - a.points[k]) * f }
      }
      val since = t - tr.lastSeen
      val weight = if (since <= hold) 1.0 else max(0.0, 1 - (since - hold) / fade)
      if (weight <= 0) continue
      val skin = tr.skin.copyOf()
      out += PocketTrackedFace(points, weight.toFloat(), skin, tr.width / min(1f, aspect), PocketFaceMath.luma(skin))
    }
    return out
  }
}
