package com.favdevs.opcnative.video

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.log10
import kotlin.math.log2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt

/*
 * CPU side of the picture colour science; mirror of iOS `OpcVideoColor.swift`. The GLSL in
 * OpcVideoShaders.kt evaluates the per-pixel parts. Sources: OpenPocketViewCore
 * LiveColorScience.swift (transfers, anchors, WAVE IRE), OpenCineMedia FalseColor.swift,
 * ScopeMath.swift (7-code clip shelf), MonitorLogDisplayTransform / MonitorSceneToneMap, and
 * Apps/Desktop opc-render peaking shaders.
 */

/** Camera transfer of the signal (`PictureEffects.sourceColor`). `id` is the shader id. */
enum class OpcVideoTransfer(val id: Int) {
  REC709(0), HLG(1), DLOGM(2), DLOG(3), DLOG2(4);

  /** Live-tap ceiling byte at the reference EI. VERIFY: the contract carries no ISO. */
  val clipByte: Int
    get() = when (this) {
      DLOG2 -> 247
      DLOG -> 223
      else -> 255
    }

  val lumaWeights: FloatArray
    get() = when (this) {
      HLG, DLOG2 -> floatArrayOf(0.2627f, 0.6780f, 0.0593f)
      else -> floatArrayOf(0.2126f, 0.7152f, 0.0722f)
    }

  /** Linear source gamut → linear Rec.709, row-major (9 floats). */
  val gamutToRec709: FloatArray
    get() = when (this) {
      DLOG -> floatArrayOf(1.6746f, -0.5797f, -0.0949f, -0.0981f, 1.3340f, -0.2359f, -0.0410f, -0.2430f, 1.2840f)
      DLOG2 -> floatArrayOf(1.8577f, -0.7712f, -0.0869f, -0.2018f, 1.4176f, -0.2158f, -0.0125f, -0.1621f, 1.1746f)
      HLG -> floatArrayOf(1.6605f, -0.5876f, -0.0728f, -0.1246f, 1.1329f, -0.0083f, -0.0182f, -0.1006f, 1.1187f)
      // VERIFY: D-Log M primaries are unpublished; the core treats them as pass-through.
      else -> floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f)
    }

  fun decode(encoded: Double): Double {
    val e = encoded.coerceIn(0.0, 1.0)
    return when (this) {
      REC709 -> if (e < 0.081) e / 4.5 else ((e + 0.099) / 1.099).pow(1 / 0.45)
      HLG -> {
        val s = if (e <= 0.5) e * e / 3 else (exp((e - 0.55991073) / 0.17883277) + 0.28466892) / 12
        s / HLG_DIFFUSE_WHITE
      }
      DLOG -> if (e <= 0.14) (e - 0.0929) / 6.025 else (10.0.pow(3.89616 * e - 2.27752) - 0.0108) / 0.9892
      DLOG2 -> when {
        e >= D2_B1 -> (475.0 / (2.0.pow(D2_A) - 1)) * (2.0.pow(D2_A * e) - 1)
        e >= D2_B2 -> 2.0.pow((e - D2_B1) / D2_K1 + log2(0.18))
        else -> (e - D2_B2) / D2_K2 + D2_I2
      }
      DLOGM -> {
        val t = 2.0.pow(e * 5.612990379333496 + 0.9327186346054077) - 2.428226947784424
        val v = if (t < 0.6034245491027832) t * 1.0151796340942383 + 0.5178895592689514 else t * 1.8734303712844849
        v * (0.18 / 12.4054)
      }
    }
  }

  fun encode(linear: Double): Double {
    val l = max(0.0, linear)
    val out = when (this) {
      REC709 -> {
        val c = min(1.0, l)
        if (c < 0.018) 4.5 * c else 1.099 * c.pow(0.45) - 0.099
      }
      HLG -> {
        val s = (l * HLG_DIFFUSE_WHITE).coerceIn(0.0, 1.0)
        if (s <= 1.0 / 12.0) sqrt(3 * s) else 0.17883277 * ln(12 * s - 0.28466892) + 0.55991073
      }
      DLOG -> if (l <= 0.0078) 6.025 * l + 0.0929 else log10(l * 0.9892 + 0.0108) * 0.256663 + 0.584555
      DLOG2 -> when {
        l >= 0.18 -> (1 / D2_A) * log2(l * (2.0.pow(D2_A) - 1) / 475.0 + 1)
        l >= D2_I2 -> D2_K1 * (log2(max(l, 1e-15)) - log2(0.18)) + D2_B1
        else -> D2_K2 * (l - D2_I2) + D2_B2
      }
      DLOGM -> {
        val v = l / (0.18 / 12.4054)
        val t = if (v < 0.6034245491027832 * 1.8734303712844849) (v - 0.5178895592689514) / 1.0151796340942383
        else v / 1.8734303712844849
        (log2(t + 2.428226947784424) - 0.9327186346054077) / 5.612990379333496
      }
    }
    return if (out.isFinite()) out.coerceIn(0.0, 1.0) else 0.0
  }

  /** ScopeAnchors: black = encode(0) (0 for D-Log M), mid = encode(0.18), clip = ceiling. */
  val anchors: OpcVideoAnchors
    get() {
      val black = if (this == DLOGM) 0.0 else encode(0.0)
      val mid = encode(0.18)
      return OpcVideoAnchors(black, mid, clipByte / 255.0, 0.05 + mid * 0.9)
    }

  companion object {
    val HLG_DIFFUSE_WHITE = (exp((0.75 - 0.55991073) / 0.17883277) + 0.28466892) / 12
    private const val D2_A = 16.285770761945304
    private const val D2_K1 = 0.059439938321493
    private const val D2_B1 = 0.304985337243402
    private const val D2_K2 = 2.960935245492250
    private const val D2_B2 = 0.148314799066323
    private const val D2_I2 = 0.028961695254132

    fun fromJs(value: String?): OpcVideoTransfer = when (value) {
      "hlg" -> HLG
      "dlog-m" -> DLOGM
      "dlog" -> DLOG
      "dlog2" -> DLOG2
      else -> REC709
    }
  }
}

/** ScopeDisplayScale on one transfer's anchors. */
data class OpcVideoAnchors(val black: Double, val mid: Double, val clip: Double, val midLevel: Double) {
  fun waveformLevel(c: Double): Double {
    val crush = 0.05
    val top = 0.95
    val v = c.coerceIn(0.0, 1.0)
    if (v < black) return if (black <= 0) crush else v / black * crush
    if (v > clip) {
      val head = 1 - clip
      return if (head <= 0) top else top + (v - clip) / head * (1 - top)
    }
    if (clip <= mid || mid <= black) return crush + (v - black) / max(clip - black, 1e-9) * (top - crush)
    if (v <= mid) return crush + (v - black) / (mid - black) * (midLevel - crush)
    return midLevel + (v - mid) / (clip - mid) * (top - midLevel)
  }

  fun monitorPercent(c: Double): Double = ((waveformLevel(c) - 0.05) / 0.9 * 100).coerceIn(0.0, 100.0)
}

/** Parsed `PictureEffects`; defaults match `defaultPictureEffects`. */
data class OpcPictureEffects(
  val sourceColor: OpcVideoTransfer = OpcVideoTransfer.REC709,
  val lutId: String? = null,
  val lutIntensity: Float = 1f,
  /** 0 off, 1 cinestop, 2 video, 3 ire, 4 limits. */
  val falseColor: Int = 0,
  val zebraOn: Boolean = false,
  /** Highlight zebra threshold, monitor IRE 0…100 (max RGB channel). */
  val zebraUpper: Float = 99f,
  /** Midtone zebra centre, monitor IRE (±5 on luma); null = off. */
  val zebraLower: Float? = null,
  val zebraPaint: FloatArray = floatArrayOf(1f, 1f, 1f),
  val zebraStripes: Boolean = true,
  val peakingOn: Boolean = false,
  val peakingColor: FloatArray = floatArrayOf(1f, 0f, 0f),
  val peakingRatio: Float = 2.10f,
  val peakingGate: Float = 0.00174f,
  val desqueeze: Float = 1f,
  val desqueezeVertical: Boolean = false,
  val mirror: Boolean = false,
  val monochrome: Boolean = false,
) {
  fun displayAspect(sourceWidth: Int, sourceHeight: Int): Double {
    val base = max(sourceWidth, 1).toDouble() / max(sourceHeight, 1).toDouble()
    if (abs(desqueeze - 1f) <= 0.001f) return base
    return if (desqueezeVertical) base / desqueeze else base * desqueeze
  }

  override fun equals(other: Any?): Boolean {
    if (other !is OpcPictureEffects) return false
    return sourceColor == other.sourceColor && lutId == other.lutId && lutIntensity == other.lutIntensity &&
      falseColor == other.falseColor && zebraOn == other.zebraOn && zebraUpper == other.zebraUpper &&
      zebraLower == other.zebraLower && zebraPaint.contentEquals(other.zebraPaint) &&
      zebraStripes == other.zebraStripes && peakingOn == other.peakingOn &&
      peakingColor.contentEquals(other.peakingColor) && peakingRatio == other.peakingRatio &&
      peakingGate == other.peakingGate && desqueeze == other.desqueeze &&
      desqueezeVertical == other.desqueezeVertical && mirror == other.mirror && monochrome == other.monochrome
  }

  override fun hashCode(): Int = arrayOf<Any?>(sourceColor, lutId, falseColor, zebraUpper, mirror).contentHashCode()

  companion object {
    fun parse(map: Map<String, Any?>?): OpcPictureEffects {
      if (map == null) return OpcPictureEffects()
      val zebra = map["zebra"] as? Map<*, *>
      val peaking = map["peaking"] as? Map<*, *>
      val desqueeze = map["desqueeze"] as? Map<*, *>
      return OpcPictureEffects(
        sourceColor = OpcVideoTransfer.fromJs(map["sourceColor"] as? String),
        lutId = map["lutId"] as? String,
        lutIntensity = (num(map["lutIntensity"]) ?: 1.0).coerceIn(0.0, 1.0).toFloat(),
        falseColor = when (map["falseColor"] as? String) {
          "cinestop" -> 1
          "video" -> 2
          "ire" -> 3
          "limits" -> 4
          else -> 0
        },
        zebraOn = zebra != null,
        zebraUpper = (num(zebra?.get("upper")) ?: 99.0).toFloat(),
        zebraLower = num(zebra?.get("lower"))?.toFloat(),
        zebraPaint = rgb(zebra?.get("paint")) ?: floatArrayOf(1f, 1f, 1f),
        zebraStripes = (zebra?.get("stripes") as? Boolean) ?: true,
        peakingOn = peaking != null,
        peakingColor = rgb(peaking?.get("color")) ?: floatArrayOf(1f, 0f, 0f),
        peakingRatio = (num(peaking?.get("ratioThreshold")) ?: 2.10).toFloat(),
        peakingGate = (num(peaking?.get("noiseGate")) ?: 0.00174).toFloat(),
        desqueeze = max(0.1, num(desqueeze?.get("factor")) ?: 1.0).toFloat(),
        desqueezeVertical = desqueeze?.get("direction") == "vertical",
        mirror = (map["mirror"] as? Boolean) ?: false,
        monochrome = (map["monochrome"] as? Boolean) ?: false,
      )
    }

    private fun num(value: Any?): Double? = (value as? Number)?.toDouble()

    /** `Rgb` is documented 0…1; 0…255 triples are accepted too. */
    private fun rgb(value: Any?): FloatArray? {
      val list = value as? List<*> ?: return null
      if (list.size < 3) return null
      val values = list.take(3).map { num(it) ?: 0.0 }
      val scale = if (values.any { it > 1.0 }) 1.0 / 255.0 else 1.0
      return FloatArray(3) { (values[it] * scale).toFloat() }
    }
  }
}

/**
 * The 17 vec4 slots of `uFx` (same order as iOS `OpcVideoFxUniforms` and the web shader):
 * 0 anchors, 1 luma(+transfer id), 2 tone, 3–5 gamut rows, 6 lut, 7 lutMin, 8 lutMax,
 * 9 falseColor, 10 zebra, 11 zebraPaint, 12 peak, 13 peakColor, 14 src, 15 view, 16 map.
 */
object OpcVideoFxUniforms {
  const val SLOTS = 17
  const val MAP = 16

  fun make(
    fx: OpcPictureEffects,
    lut: OpcVideoLut?,
    sourceWidth: Int,
    sourceHeight: Int,
    viewWidth: Double,
    viewHeight: Double,
    density: Double,
    fill: Boolean,
  ): FloatArray {
    val u = FloatArray(SLOTS * 4)
    fun put(slot: Int, x: Float, y: Float, z: Float, w: Float) {
      u[slot * 4] = x; u[slot * 4 + 1] = y; u[slot * 4 + 2] = z; u[slot * 4 + 3] = w
    }
    val t = fx.sourceColor
    val a = t.anchors
    put(0, a.black.toFloat(), a.mid.toFloat(), a.clip.toFloat(), a.midLevel.toFloat())
    val w = t.lumaWeights
    put(1, w[0], w[1], w[2], t.id.toFloat())

    val sceneWhite = t.decode(1.0)
    val contrast = 1.1
    val mg = 0.42.pow(2.4)
    val whitePoint = max(sceneWhite / 0.18, 0.000001)
    val cw = whitePoint.pow(contrast)
    val gain = max(0.000001, (mg - 1 / (cw * cw)) / (1 - mg))
    put(2, gain.toFloat(), contrast.toFloat(), (gain * cw).toFloat(), if (t == OpcVideoTransfer.REC709) 0f else 1f)
    val g = t.gamutToRec709
    put(3, g[0], g[1], g[2], 0f)
    put(4, g[3], g[4], g[5], 0f)
    put(5, g[6], g[7], g[8], 0f)

    val mono = if (fx.monochrome) 1f else 0f
    if (lut != null) {
      put(6, 1f, lut.size.toFloat(), fx.lutIntensity, mono)
      put(7, lut.domainMin[0], lut.domainMin[1], lut.domainMin[2], 0f)
      put(8, lut.domainMax[0], lut.domainMax[1], lut.domainMax[2], 1f)
    } else {
      put(6, 0f, 2f, 0f, mono)
      put(7, 0f, 0f, 0f, 0f)
      put(8, 1f, 1f, 1f, 1f)
    }

    val shelf = max(0.0, a.clip - 7.0 / 255.0)
    val shelfLinear = max(0.0, t.decode(shelf))
    val clipStops = if (shelfLinear > 0) log2(shelfLinear / 0.18) else 10.5
    var limitsEdge = a.monitorPercent(shelf)
    if (!(limitsEdge < 99 && limitsEdge > 94)) limitsEdge = 99.0
    put(9, fx.falseColor.toFloat(), clipStops.toFloat(), limitsEdge.toFloat(), 0f)

    put(10, if (fx.zebraOn) 1f else 0f, fx.zebraUpper, fx.zebraLower ?: -1f, if (fx.zebraStripes) 1f else 0f)
    put(11, fx.zebraPaint[0], fx.zebraPaint[1], fx.zebraPaint[2], 1f)
    put(12, if (fx.peakingOn) 1f else 0f, fx.peakingRatio, fx.peakingGate, 0f)
    put(13, fx.peakingColor[0], fx.peakingColor[1], fx.peakingColor[2], 1f)

    val sw = max(sourceWidth, 1).toFloat()
    val sh = max(sourceHeight, 1).toFloat()
    put(14, sw, sh, 1f / sw, 1f / sh)
    // Stripe pitch 7.07 dp (14.14 px at the desktop's 2x).
    put(15, viewWidth.toFloat(), viewHeight.toFloat(), (7.07 * max(density, 1.0)).toFloat(), if (fx.mirror) 1f else 0f)

    val displayAspect = fx.displayAspect(sourceWidth, sourceHeight)
    val viewAspect = viewWidth / max(viewHeight, 1.0)
    var cw2 = 1.0
    var ch2 = 1.0
    if (fill) {
      if (displayAspect > viewAspect) cw2 = displayAspect / viewAspect else ch2 = viewAspect / displayAspect
    } else {
      if (displayAspect > viewAspect) ch2 = viewAspect / displayAspect else cw2 = displayAspect / viewAspect
    }
    put(16, (1 / cw2).toFloat(), (1 / ch2).toFloat(), ((1 - cw2) / 2).toFloat(), ((1 - ch2) / 2).toFloat())
    return u
  }

  /** Whole-frame uniforms (scope measurement, samples): identity mapping, no mirror/desqueeze. */
  fun whole(fx: OpcPictureEffects, lut: OpcVideoLut?, sourceWidth: Int, sourceHeight: Int): FloatArray =
    make(
      fx.copy(mirror = false, desqueeze = 1f), lut, sourceWidth, sourceHeight,
      sourceWidth.toDouble(), sourceHeight.toDouble(), 1.0, false,
    )
}
