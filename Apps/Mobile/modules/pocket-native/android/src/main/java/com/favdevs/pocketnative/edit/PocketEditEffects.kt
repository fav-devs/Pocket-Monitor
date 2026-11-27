package com.favdevs.pocketnative.edit

import android.content.Context
import android.opengl.GLES20
import androidx.media3.common.Effect
import androidx.media3.common.VideoFrameProcessingException
import androidx.media3.common.util.GlProgram
import androidx.media3.common.util.GlUtil
import androidx.media3.common.util.Size
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BaseGlShaderProgram
import androidx.media3.effect.Crop
import androidx.media3.effect.GlEffect
import androidx.media3.effect.GlShaderProgram
import androidx.media3.effect.Presentation
import androidx.media3.effect.ScaleAndRotateTransformation
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentHashMap

/*
 * The playback editor's effect pipeline (Android). Same stages and order as src/core/edit/plan.ts:
 *   1. colour   — one baked 3D LUT (PocketEditLuts) in a Media3 GL effect (PocketEditColorEffect)
 *   2. face     — PocketFaceRetouchEffect (landmarks → skin smooth / brighten → slim / eye warps)
 *   3. geometry — rotate (cw) → Crop → flip → Presentation (output size)
 * Preview: ExoPlayer.setVideoEffects([colour, face?]) on expo-video's player (geometry is React
 * Native transforms over a TextureView). Export: Media3 Transformer with all three + audio.
 */

/** Baked cubes from JS (`PocketEdit.setLut`): size³ RGB floats, red fastest. */
object PocketEditLuts {
  class Cube(val size: Int, val rgb: FloatArray)

  private val cubes = ConcurrentHashMap<String, Cube>()

  fun set(key: String, size: Int, rgb: FloatArray) {
    cubes[key] = Cube(size, rgb)
  }

  fun get(key: String?): Cube? = key?.let { cubes[it] }

  fun drop(key: String) {
    cubes.remove(key)
  }

  /** RGBA8 atlas for a 2D texture: pixel (x = b·size + r, y = g). */
  fun atlas(cube: Cube): ByteBuffer {
    val n = cube.size
    val buf = ByteBuffer.allocateDirect(n * n * n * 4).order(ByteOrder.nativeOrder())
    for (g in 0 until n) for (b in 0 until n) for (r in 0 until n) {
      val src = (r + g * n + b * n * n) * 3
      buf.put(q(cube.rgb[src])).put(q(cube.rgb[src + 1])).put(q(cube.rgb[src + 2])).put(255.toByte())
    }
    buf.position(0)
    return buf
  }

  private fun q(v: Float): Byte = (Math.round(v.coerceIn(0f, 1f) * 255f)).toByte()
}

/** Before/after line in the source frame (top-left origin, normalized). */
data class PocketEditSplit(val axisX: Boolean, val at: Float, val originalLow: Boolean)

data class PocketFaceParams(
  val auto: Float = 0f,
  val smooth: Float = 0f,
  val brighten: Float = 0f,
  val slim: Float = 0f,
  val eyes: Float = 0f,
) {
  val isZero: Boolean get() = maxOf(auto, smooth, brighten, slim, eyes) <= 0.001f

  companion object {
    fun from(map: Map<*, *>?): PocketFaceParams {
      fun v(k: String) = (map?.get(k) as? Number)?.toFloat() ?: 0f
      return PocketFaceParams(v("auto"), v("smooth"), v("brighten"), v("slim"), v("eyes"))
    }
  }
}

/**
 * Colour stage as a Media3 GL effect. The state is read on the GL thread every frame, so the
 * preview follows strength changes without rebuilding the player's effect pipeline.
 */
@UnstableApi
class PocketEditColorEffect : GlEffect {
  data class State(val lutKey: String? = null, val split: PocketEditSplit? = null)

  @Volatile
  var state = State()

  @Throws(VideoFrameProcessingException::class)
  override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram = Program(this, useHdr)

  private class Program(private val effect: PocketEditColorEffect, private val useHdr: Boolean) : BaseGlShaderProgram(useHdr, 1) {
    private val program: GlProgram = try {
      GlProgram(VERTEX, FRAGMENT)
    } catch (e: Exception) {
      throw VideoFrameProcessingException(e)
    }
    private var lutTex = 0
    private var lutKey: String? = null
    private var lutSize = 2

    init {
      program.setBufferAttribute("aFramePosition", GlUtil.getNormalizedCoordinateBounds(), GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE)
      lutTex = createTexture()
      upload(PocketEditLuts.Cube(2, floatArrayOf(0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f, 0f, 1f, 1f, 0f, 0f, 0f, 1f, 1f, 0f, 1f, 0f, 1f, 1f, 1f, 1f, 1f)))
    }

    override fun configure(inputWidth: Int, inputHeight: Int): Size = Size(inputWidth, inputHeight)

    override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
      val s = effect.state
      val cube = PocketEditLuts.get(s.lutKey)
      if (cube != null && s.lutKey != lutKey) {
        upload(cube)
        lutKey = s.lutKey
      }
      val split = s.split
      try {
        program.use()
        program.setSamplerTexIdUniform("uTexSampler", inputTexId, 0)
        program.setSamplerTexIdUniform("uLut", lutTex, 1)
        program.setFloatUniform("uLutSize", lutSize.toFloat())
        program.setFloatUniform("uLutOn", if (cube != null) 1f else 0f)
        program.setFloatUniform("uHdr", if (useHdr) 1f else 0f)
        program.setFloatsUniform(
          "uSplit",
          if (split == null) floatArrayOf(0f, 0f, 0f, 0f)
          else floatArrayOf(if (split.axisX) 1f else 0f, split.at, if (split.originalLow) 1f else 0f, 1f),
        )
        program.bindAttributesAndUniforms()
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
      } catch (e: GlUtil.GlException) {
        throw VideoFrameProcessingException(e, presentationTimeUs)
      }
    }

    override fun release() {
      super.release()
      try {
        program.delete()
      } catch (_: GlUtil.GlException) {
      }
      if (lutTex != 0) GLES20.glDeleteTextures(1, intArrayOf(lutTex), 0)
      lutTex = 0
    }

    private fun createTexture(): Int {
      val ids = IntArray(1)
      GLES20.glGenTextures(1, ids, 0)
      GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, ids[0])
      GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
      GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
      GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
      GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
      return ids[0]
    }

    private fun upload(cube: PocketEditLuts.Cube) {
      val n = cube.size
      GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, lutTex)
      GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, 1)
      GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, n * n, n, 0, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, PocketEditLuts.atlas(cube))
      lutSize = n
    }
  }

  companion object {
    private const val VERTEX = """
attribute vec4 aFramePosition;
varying vec2 vTexSamplingCoord;
void main() {
  gl_Position = aFramePosition;
  vTexSamplingCoord = vec2(aFramePosition.x * 0.5 + 0.5, aFramePosition.y * 0.5 + 0.5);
}
"""

    // The cube is a 2D atlas (x = b·n + r, y = g); blue is interpolated between two slices.
    // HDR pipelines hand effects linear light: encode with a 1/2.4 gamma around the lookup.
    private const val FRAGMENT = """
precision highp float;
uniform sampler2D uTexSampler;
uniform sampler2D uLut;
uniform float uLutSize;
uniform float uLutOn;
uniform float uHdr;
uniform vec4 uSplit;
varying vec2 vTexSamplingCoord;

vec3 lut(vec3 c) {
  float n = uLutSize;
  c = clamp(c, 0.0, 1.0);
  float b = c.b * (n - 1.0);
  float b0 = floor(b);
  float b1 = min(b0 + 1.0, n - 1.0);
  float x = (c.r * (n - 1.0) + 0.5) / (n * n);
  float y = (c.g * (n - 1.0) + 0.5) / n;
  vec3 s0 = texture2D(uLut, vec2(x + b0 / n, y)).rgb;
  vec3 s1 = texture2D(uLut, vec2(x + b1 / n, y)).rgb;
  return mix(s0, s1, b - b0);
}

void main() {
  vec4 src = texture2D(uTexSampler, vTexSamplingCoord);
  vec3 c = src.rgb;
  if (uLutOn > 0.5) {
    if (uHdr > 0.5) c = pow(max(c, 0.0), vec3(1.0 / 2.4));
    c = lut(c);
    if (uHdr > 0.5) c = pow(c, vec3(2.4));
  }
  if (uSplit.w > 0.5) {
    // Source coordinates, top-left origin.
    float coord = uSplit.x > 0.5 ? vTexSamplingCoord.x : 1.0 - vTexSamplingCoord.y;
    bool low = coord < uSplit.y;
    if (low == (uSplit.z > 0.5)) c = src.rgb;
  }
  gl_FragColor = vec4(c, src.a);
}
"""
  }
}

/**
 * The face stage for export: a [PocketFaceRetouchEffect] that finds landmarks on every frame, or
 * null while every face strength is 0 (no stage, no detection). The preview keeps its own
 * effect per player ([PocketEditPreview]). Runs after colour and before geometry, on the source
 * frame.
 */
object PocketFaceRetouch {
  @UnstableApi
  fun effect(params: PocketFaceParams): GlEffect? = if (params.isZero) null else PocketFaceRetouchEffect(export = true).also { it.params = params }
}

@UnstableApi
object PocketEditPipeline {
  /** Geometry effects for export: rotate (cw) → crop → flip → scale to the output size. */
  fun geometry(rotation: Int, crop: FloatArray, flipH: Boolean, flipV: Boolean, width: Int, height: Int): List<Effect> {
    val out = mutableListOf<Effect>()
    if (rotation != 0) {
      // Media3 rotates counter-clockwise.
      out += ScaleAndRotateTransformation.Builder().setRotationDegrees(((360 - rotation) % 360).toFloat()).build()
    }
    val (x, y, w, h) = crop.toList()
    if (x > 0.0005f || y > 0.0005f || w < 0.9995f || h < 0.9995f) {
      // Normalized device coordinates of the rotated frame (y up).
      out += Crop(x * 2f - 1f, (x + w) * 2f - 1f, 1f - (y + h) * 2f, 1f - y * 2f)
    }
    if (flipH || flipV) {
      out += ScaleAndRotateTransformation.Builder().setScale(if (flipH) -1f else 1f, if (flipV) -1f else 1f).build()
    }
    out += Presentation.createForWidthAndHeight(width, height, Presentation.LAYOUT_SCALE_TO_FIT)
    return out
  }
}
