package com.favdevs.opcnative.video

import android.content.Context
import android.opengl.GLES30
import expo.modules.kotlin.AppContext
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import kotlin.math.roundToInt

/**
 * `OpcScopeView` (ScopeViewProps). Downsampled CPU path: the GL thread renders the measure pass
 * (signal, or graded picture when `measureAfterLut`) into a ≤ 256-px-wide target, reads it back,
 * bins it here, uploads the bins as an R32F texture and draws them with the same fragment logic
 * as the iOS Metal scope (`OpcVideoShaders.SCOPE_DRAW`). Updates at ≤ 20 Hz, only on new frames.
 */
class OpcScopeView(context: Context, appContext: AppContext) : OpcVideoSurfaceView(context, appContext) {
  companion object {
    private const val MEASURE_WIDTH = 256
    private const val PLANE = 65536
    private const val BINS = 4 * PLANE
  }

  @Volatile private var demoScene: Int? = null
  @Volatile private var kind = 0 // 0 waveform, 1 parade, 2 histogram, 3 vectorscope
  @Volatile private var rgbMode = false
  @Volatile private var zoom = 1f
  @Volatile private var brightness = 0.8f
  @Volatile private var measureAfterLut = false
  @Volatile private var effects = OpcPictureEffects()

  // GL thread.
  private var measureTarget: OpcGlFbo? = null
  private var binsTexture = 0
  private val bins = FloatArray(BINS)
  private val binsBuffer: FloatBuffer = ByteBuffer.allocateDirect(BINS * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
  private var lastSequence = 0L
  private var lastDrawNanos = 0L
  private val demoEpochNanos = System.nanoTime()

  init {
    textureView.isOpaque = false
  }

  fun setDemoScene(scene: String?) { demoScene = OpcVideoSource.demoScene(scene); dirty = true }

  fun setKind(value: String?) {
    kind = when (value) {
      "parade" -> 1
      "histogram" -> 2
      "vectorscope" -> 3
      else -> 0
    }
    dirty = true
  }

  fun setOptions(options: Map<String, Any?>?) {
    rgbMode = options?.get("mode") == "rgb"
    zoom = ((options?.get("zoom") as? Number)?.toFloat() ?: 1f).coerceIn(1f, 4f)
    dirty = true
  }

  fun setBrightness(value: Double?) { brightness = (value ?: 0.8).coerceIn(0.0, 1.0).toFloat(); dirty = true }

  fun setMeasureAfterLut(value: Boolean?) { measureAfterLut = value ?: false; dirty = true }

  fun setEffects(map: Map<String, Any?>?) { effects = OpcPictureEffects.parse(map); dirty = true }

  override fun onSessionChanged() {
    OpcVideoGl.post { lastSequence = 0 }
  }

  override fun onGlFrame(frameTimeNanos: Long) {
    val now = System.nanoTime()
    if (!dirty && now - lastDrawNanos < 50_000_000L) return
    val s = session
    val demo = demoScene
    val source: OpcVideoSource? = when {
      s != null -> {
        val seq = s.frameSequence
        if (seq == 0L || (seq == lastSequence && !dirty)) return
        lastSequence = seq
        OpcVideoSource.Frame(s)
      }
      demo != null -> OpcVideoSource.Demo(demo, (now - demoEpochNanos) / 1e9f, effects.sourceColor)
      else -> null
    }
    if (!beginWindow()) return
    dirty = false
    lastDrawNanos = now
    val signal = source?.let { renderer.ingest(it) }
    if (source == null || signal == null) {
      clearWindow(0f, 0f, 0f, 0f)
      endWindow()
      return
    }
    val fx = effects
    val (sw, sh) = source.size
    val mh = (MEASURE_WIDTH.toDouble() * sh / maxOf(sw, 1)).roundToInt().coerceIn(16, 256)
    val target = measureTarget?.takeIf { it.width == MEASURE_WIDTH && it.height == mh }
      ?: OpcGlFbo(MEASURE_WIDTH, mh).also { measureTarget?.release(); measureTarget = it }
    val lut = OpcVideoLutRegistry.lut(fx.lutId)
    val afterLut = measureAfterLut
    renderer.measure(target, signal, afterLut, lut, OpcVideoFxUniforms.whole(fx, lut, sw, sh))
    val rgba = OpcVideoRenderer.readRgba(MEASURE_WIDTH, mh)

    val axis = if (afterLut) OpcVideoTransfer.REC709 else fx.sourceColor
    val anchors = axis.anchors
    val weights = axis.lumaWeights
    val k = kind
    val rgb = rgbMode
    val peak = accumulate(rgba, MEASURE_WIDTH, mh, k, rgb, zoom, anchors, weights)
    uploadBins()

    clearWindow(0f, 0f, 0f, 0f)
    val p = OpcVideoGl.programs ?: return
    val prog = p.scopeDraw
    prog.use()
    val u = floatArrayOf(
      anchors.black.toFloat(), anchors.mid.toFloat(), anchors.clip.toFloat(), anchors.midLevel.toFloat(),
      weights[0], weights[1], weights[2], 0f,
      k.toFloat(), if (rgb) 1f else 0f, zoom, MEASURE_WIDTH.toFloat(),
      brightness, surfaceWidth.toFloat(), surfaceHeight.toFloat(), peak,
    )
    GLES30.glUniform4fv(prog.loc("uScope"), 4, u, 0)
    GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, binsTexture)
    GLES30.glUniform1i(prog.loc("uBins"), 0)
    GLES30.glBindVertexArray(p.vao)
    GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
    endWindow()
  }

  /** Same bin layout as the Metal `opc_scope_accumulate`; returns the peak used for density. */
  private fun accumulate(
    rgba: ByteArray, w: Int, h: Int, kind: Int, rgb: Boolean, gain: Float,
    anchors: OpcVideoAnchors, weights: FloatArray,
  ): Float {
    java.util.Arrays.fill(bins, 0f)
    val level = IntArray(256) { bin(anchors.waveformLevel(it / 255.0)) }
    for (y in 0 until h) {
      for (x in 0 until w) {
        val o = (y * w + x) * 4
        val r = rgba[o].toInt() and 0xff
        val g = rgba[o + 1].toInt() and 0xff
        val b = rgba[o + 2].toInt() and 0xff
        when (kind) {
          0, 1 -> {
            val col = minOf(x, 255) * 256
            if (kind == 0 && !rgb) {
              val luma = (weights[0] * r + weights[1] * g + weights[2] * b) / 255.0
              bins[col + bin(anchors.waveformLevel(luma))] += 1f
            } else {
              bins[col + level[r]] += 1f
              bins[PLANE + col + level[g]] += 1f
              bins[2 * PLANE + col + level[b]] += 1f
            }
          }
          2 -> {
            val luma = (weights[0] * r + weights[1] * g + weights[2] * b) / 255.0
            bins[bin(anchors.waveformLevel(luma))] += 1f
            bins[256 + level[r]] += 1f
            bins[512 + level[g]] += 1f
            bins[768 + level[b]] += 1f
          }
          else -> {
            val rf = r / 255f
            val gf = g / 255f
            val bf = b / 255f
            val yy = 0.2126f * rf + 0.7152f * gf + 0.0722f * bf
            val cx = (bf - yy) / 1.8556f * gain + 0.5f
            val cy = (rf - yy) / 1.5748f * gain + 0.5f
            if (cx < 0f || cx > 1f || cy < 0f || cy > 1f) continue
            val idx = (cy * 127f).roundToInt() * 128 + (cx * 127f).roundToInt()
            bins[idx] += 1f
            bins[PLANE + idx] += r.toFloat()
            bins[2 * PLANE + idx] += g.toFloat()
            bins[3 * PLANE + idx] += b.toFloat()
          }
        }
      }
    }
    var peak = 0f
    fun scan(start: Int, count: Int, stride: Int, planes: Int) {
      for (p in 0 until planes) {
        val base = start + p * stride
        for (i in 0 until count) if (bins[base + i] > peak) peak = bins[base + i]
      }
    }
    when (kind) {
      0 -> scan(0, w * 256, PLANE, if (rgb) 3 else 1)
      1 -> scan(0, w * 256, PLANE, 3)
      2 -> if (rgb) scan(256, 256, 256, 3) else scan(0, 256, 256, 1)
      else -> scan(0, 16384, 0, 1)
    }
    return peak
  }

  private fun bin(level: Double): Int = (level * 255.0 + 0.5).toInt().coerceIn(0, 255)

  private fun uploadBins() {
    if (binsTexture == 0) {
      val ids = IntArray(1)
      GLES30.glGenTextures(1, ids, 0)
      binsTexture = ids[0]
      GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, binsTexture)
      GLES30.glTexStorage2D(GLES30.GL_TEXTURE_2D, 1, GLES30.GL_R32F, 256, 1024)
      // R32F is not filterable: NEAREST keeps the texture complete for texelFetch.
      GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_NEAREST)
      GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_NEAREST)
    }
    binsBuffer.position(0)
    binsBuffer.put(bins)
    binsBuffer.position(0)
    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, binsTexture)
    GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 4)
    GLES30.glTexSubImage2D(GLES30.GL_TEXTURE_2D, 0, 0, 0, 256, 1024, GLES30.GL_RED, GLES30.GL_FLOAT, binsBuffer)
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    OpcVideoGl.post {
      measureTarget?.release()
      measureTarget = null
      if (binsTexture != 0) GLES30.glDeleteTextures(1, intArrayOf(binsTexture), 0)
      binsTexture = 0
    }
  }
}
