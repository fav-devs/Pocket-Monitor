package com.favdevs.pocketnative.edit

import android.content.Context
import android.graphics.Bitmap
import android.opengl.GLES20
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.util.Log
import androidx.media3.common.VideoFrameProcessingException
import androidx.media3.common.util.GlProgram
import androidx.media3.common.util.GlUtil
import androidx.media3.common.util.Size
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BaseGlShaderProgram
import androidx.media3.effect.GlEffect
import androidx.media3.effect.GlShaderProgram
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The editor's face stage as a Media3 GL effect (after colour, before geometry, on the full source
 * frame), for the ExoPlayer preview and the Transformer export alike. Maths: src/core/edit/face.ts
 * via [PocketFaceMath]; GLSL: the web demo's `FACE_FS`, in GLSL ES 1.00.
 *
 * Landmarks: the input frame is drawn small (640 on the long side, upright, top row first, HDR
 * encoded with the colour stage's 1/2.4 gamma) into an RGBA8 target, read back, and handed to a
 * [PocketFaceLandmarker] on this program's own worker thread; results feed a [PocketFaceTracker].
 * - Preview: at most every [PREVIEW_INTERVAL_NANOS] and only while the worker is free (a picture
 *   offered while it is busy is dropped); frames in between are drawn from the tracker
 *   (interpolated / briefly extrapolated, held over misses).
 * - Export: every frame, waiting for its landmarks.
 * No read-back or landmark work while every strength is 0 (unless `probe`, the Face panel open).
 *
 * Params and probe are read on the GL thread every frame, so the preview follows the sliders
 * without rebuilding the player's effects.
 */
@UnstableApi
class PocketFaceRetouchEffect(private val export: Boolean) : GlEffect {
  @Volatile
  var params = PocketFaceParams()

  /** Look for faces at strength 0 too (preview; reports through [onFaces]). */
  @Volatile
  var probe = false

  /** Preview compare: the original's side of the line stays untouched (as the colour stage's). */
  @Volatile
  var split: PocketEditSplit? = null

  /** Preview: the faces seen in the latest analysed frame, when that count changes (worker thread). */
  @Volatile
  var onFaces: ((Int) -> Unit)? = null

  /** Preview: landmarks arrived for the frame on screen and it was drawn without them (worker thread). */
  @Volatile
  var onRedraw: (() -> Unit)? = null

  @Throws(VideoFrameProcessingException::class)
  override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram = Program(context.applicationContext, this, useHdr, export)

  private class Program(context: Context, private val effect: PocketFaceRetouchEffect, private val useHdr: Boolean, private val export: Boolean) :
    BaseGlShaderProgram(useHdr, 1) {
    private val program: GlProgram
    private val copy: GlProgram
    private val faceLocation: Int
    private val landmarker = PocketFaceLandmarker(context)
    private val thread = HandlerThread("pocket-face", Process.THREAD_PRIORITY_DEFAULT).apply { start() }
    private val worker = Handler(thread.looper)
    private val busy = AtomicBoolean(false)
    private val uniforms = FloatArray(PocketFaceMath.VEC4 * 4 * PocketFaceMath.MAX_FACES)

    @Volatile private var tracker = PocketFaceTracker(16f / 9f)
    private var width = 0
    private var height = 0
    private var lastDetectNanos = 0L
    private var readFbo = 0
    private var readTex = 0
    private var readW = 0
    private var readH = 0
    private var pixels: ByteBuffer? = null

    // What the GL thread last drew, for the paused-preview redraw.
    @Volatile private var drawnTime = Double.NaN
    @Volatile private var drawnFaces = 0

    // ---- worker-confined ----
    private var bitmap: Bitmap? = null
    private var lastCount = -1

    init {
      try {
        program = GlProgram(VERTEX, FRAGMENT)
        copy = GlProgram(VERTEX, COPY)
      } catch (e: Exception) {
        thread.quitSafely()
        throw VideoFrameProcessingException(e)
      }
      for (p in arrayOf(program, copy)) {
        p.setBufferAttribute("aFramePosition", GlUtil.getNormalizedCoordinateBounds(), GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE)
      }
      faceLocation = program.getUniformLocation("uFace")
    }

    override fun configure(inputWidth: Int, inputHeight: Int): Size {
      if (inputWidth != width || inputHeight != height) {
        width = inputWidth
        height = inputHeight
        tracker = PocketFaceTracker(inputWidth.toFloat() / inputHeight.coerceAtLeast(1))
      }
      return Size(inputWidth, inputHeight)
    }

    override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
      val params = effect.params
      val t = presentationTimeUs / 1_000_000.0
      val active = !params.isZero
      try {
        if (active || effect.probe) detect(inputTexId, presentationTimeUs)
        var faces = 0
        if (active) {
          for (face in tracker.sample(t)) {
            if (faces >= PocketFaceMath.MAX_FACES) break
            val px = FloatArray(face.points.size) { i -> face.points[i] * if (i % 2 == 0) width else height }
            val strengths = PocketFaceMath.resolve(params, face.faceSize, face.skinLuma)
            if (PocketFaceMath.pack(px, strengths, face.weight, null, uniforms, faces * PocketFaceMath.VEC4 * 4)) faces++
          }
        }
        drawnTime = t
        drawnFaces = faces
        program.use()
        program.setSamplerTexIdUniform("uTexSampler", inputTexId, 0)
        program.setFloatsUniform("uRes", floatArrayOf(width.toFloat(), height.toFloat()))
        program.setFloatUniform("uHdr", if (useHdr) 1f else 0f)
        program.setIntUniform("uFaces", faces)
        val split = effect.split
        program.setFloatsUniform(
          "uSplit",
          if (split == null) floatArrayOf(0f, 0f, 0f, 0f)
          else floatArrayOf(if (split.axisX) 1f else 0f, split.at, if (split.originalLow) 1f else 0f, 1f),
        )
        program.bindAttributesAndUniforms()
        if (faces > 0) GLES20.glUniform4fv(faceLocation, faces * PocketFaceMath.VEC4, uniforms, 0)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
      } catch (e: GlUtil.GlException) {
        throw VideoFrameProcessingException(e, presentationTimeUs)
      }
    }

    /** Landmarks for this frame: queued (preview) or waited for (export). GL thread. */
    private fun detect(inputTexId: Int, presentationTimeUs: Long) {
      val t = presentationTimeUs / 1_000_000.0
      val ms = presentationTimeUs / 1000
      if (export) {
        val buffer = readBack(inputTexId) ?: return
        val done = CountDownLatch(1)
        var found: List<PocketDetectedFace> = emptyList()
        worker.post {
          try {
            found = analyse(buffer, ms)
          } finally {
            done.countDown()
          }
        }
        if (done.await(3, TimeUnit.SECONDS)) tracker.update(t, found)
        return
      }
      val now = System.nanoTime()
      if (now - lastDetectNanos < PREVIEW_INTERVAL_NANOS) return
      if (!busy.compareAndSet(false, true)) return
      lastDetectNanos = now
      val buffer = try {
        readBack(inputTexId)
      } catch (e: Throwable) {
        busy.set(false)
        throw e
      }
      if (buffer == null) {
        busy.set(false)
        return
      }
      worker.post {
        try {
          val found = analyse(buffer, ms)
          val current = tracker
          current.update(t, found)
          if (found.size != lastCount) {
            lastCount = found.size
            effect.onFaces?.invoke(found.size)
          }
          // Paused on this frame and it went out without the faces now known: draw it again.
          if (drawnTime == t && !effect.params.isZero && drawnFaces != current.sample(t).size.coerceAtMost(PocketFaceMath.MAX_FACES)) {
            effect.onRedraw?.invoke()
          }
        } catch (e: Throwable) {
          Log.w(TAG, "face analysis failed", e)
        } finally {
          busy.set(false)
        }
      }
    }

    /** Worker: the read-back pixels through the landmarker. */
    private fun analyse(buffer: ByteBuffer, ms: Long): List<PocketDetectedFace> {
      val bmp = bitmap?.takeIf { it.width == readW && it.height == readH } ?: Bitmap.createBitmap(readW, readH, Bitmap.Config.ARGB_8888).also { bitmap = it }
      buffer.rewind()
      bmp.copyPixelsFromBuffer(buffer) // RGBA bytes, top row first
      return landmarker.detect(bmp, ms)
    }

    /** GL thread: the input small into `pixels` (RGBA8, top row first); restores the output target. */
    private fun readBack(inputTexId: Int): ByteBuffer? {
      if (width <= 0 || height <= 0) return null
      val (w, h) = pocketFaceReadSize(width, height, READ_LONG_SIDE)
      if (readFbo == 0 || w != readW || h != readH) {
        deleteReadTarget()
        val ids = IntArray(1)
        GLES20.glGenTextures(1, ids, 0)
        readTex = ids[0]
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, readTex)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, w, h, 0, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null)
        GLES20.glGenFramebuffers(1, ids, 0)
        readFbo = ids[0]
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, readFbo)
        GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, readTex, 0)
        readW = w
        readH = h
        pixels = ByteBuffer.allocateDirect(w * h * 4).order(ByteOrder.nativeOrder())
      }
      val previous = IntArray(1)
      val viewport = IntArray(4)
      GLES20.glGetIntegerv(GLES20.GL_FRAMEBUFFER_BINDING, previous, 0)
      GLES20.glGetIntegerv(GLES20.GL_VIEWPORT, viewport, 0)
      val out = pixels ?: return null
      try {
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, readFbo)
        GLES20.glViewport(0, 0, w, h)
        copy.use()
        copy.setSamplerTexIdUniform("uTexSampler", inputTexId, 0)
        copy.setFloatUniform("uHdr", if (useHdr) 1f else 0f)
        copy.bindAttributesAndUniforms()
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        out.rewind()
        GLES20.glReadPixels(0, 0, w, h, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, out)
      } finally {
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, previous[0])
        GLES20.glViewport(viewport[0], viewport[1], viewport[2], viewport[3])
      }
      return out
    }

    private fun deleteReadTarget() {
      if (readFbo != 0) GLES20.glDeleteFramebuffers(1, intArrayOf(readFbo), 0)
      if (readTex != 0) GLES20.glDeleteTextures(1, intArrayOf(readTex), 0)
      readFbo = 0
      readTex = 0
    }

    override fun release() {
      super.release()
      try {
        program.delete()
        copy.delete()
      } catch (_: GlUtil.GlException) {
      }
      deleteReadTarget()
      worker.post {
        landmarker.close()
        bitmap?.recycle()
        bitmap = null
      }
      thread.quitSafely()
    }
  }

  companion object {
    private const val TAG = "PocketFace"
    /** Preview landmarks at most ~10 a second. */
    private const val PREVIEW_INTERVAL_NANOS = 100_000_000L
    private const val READ_LONG_SIDE = 640

    // GLSL ES 1.00 throughout: Media3 runs SDR effects in an OpenGL ES 2 context.
    private const val VERTEX = """
attribute vec4 aFramePosition;
varying vec2 vTexSamplingCoord;
void main() {
  gl_Position = aFramePosition;
  vTexSamplingCoord = vec2(aFramePosition.x * 0.5 + 0.5, aFramePosition.y * 0.5 + 0.5);
}
"""

    /** The frame small and upright for the landmarker: top row first, HDR encoded like the colour stage. */
    private const val COPY = """
precision highp float;
uniform sampler2D uTexSampler;
uniform float uHdr;
varying vec2 vTexSamplingCoord;
void main() {
  vec3 c = texture2D(uTexSampler, vec2(vTexSamplingCoord.x, 1.0 - vTexSamplingCoord.y)).rgb;
  if (uHdr > 0.5) c = pow(max(c, 0.0), vec3(1.0 / 2.4));
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
"""

    // FACE_FS (src/features/picture/web/faceShader.ts) in GLSL ES 1.00, with the HDR encoding
    // around it: HDR pipelines hand effects linear light, so work on pow(c, 1/2.4) like the colour
    // stage. `uFace` is indexed only by loop indices (ES 1.00's rule): each face's vec4s are copied
    // out in `main`. A pixel outside every face's bounds is the input, untouched.
    private const val FRAGMENT = """
precision highp float;
uniform sampler2D uTexSampler;
uniform vec2 uRes;
uniform float uHdr;
uniform int uFaces;
uniform vec4 uFace[75];
uniform vec4 uSplit;
varying vec2 vTexSamplingCoord;

vec3 enc(vec3 c) { return uHdr > 0.5 ? pow(max(c, 0.0), vec3(1.0 / 2.4)) : c; }
vec3 dec(vec3 e) { return uHdr > 0.5 ? pow(max(e, 0.0), vec3(2.4)) : e; }
vec3 src(vec2 p) { return enc(texture2D(uTexSampler, vec2(p.x / uRes.x, 1.0 - p.y / uRes.y)).rgb); }

vec2 chroma(vec3 c) { return vec2(dot(c, vec3(-0.168736, -0.331264, 0.5)), dot(c, vec3(0.5, -0.418688, -0.081312))); }

float ellipse(vec2 p, vec4 e, vec2 axis) {
  vec2 d = p - e.xy;
  return length(vec2(dot(d, axis), dot(d, vec2(-axis.y, axis.x))) / max(e.zw, vec2(0.001)));
}

vec2 magnify(vec2 p, vec4 eye, float k) {
  vec2 d = p - eye.xy;
  float r = length(d) / max(eye.z, 0.001);
  if (r >= 1.0) return vec2(0.0);
  float m = 1.0 - r * r;
  return d * (m * m * k);
}

void edge(vec2 p, vec2 a, vec2 b, inout float nearest, inout bool inside) {
  vec2 e = b - a;
  vec2 w = p - a;
  vec2 h = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-9), 0.0, 1.0);
  nearest = min(nearest, dot(h, h));
  if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
}

float outline(vec2 p, vec4 o[9]) {
  float nearest = 1e20;
  bool inside = false;
  vec2 prev = o[8].zw;
  for (int i = 0; i < 9; i++) {
    edge(p, o[i].xy, prev, nearest, inside);
    edge(p, o[i].zw, o[i].xy, nearest, inside);
    prev = o[i].zw;
  }
  return (inside ? -1.0 : 1.0) * sqrt(nearest);
}

vec3 lift(vec3 e, float amount) {
  vec3 c = min(e, vec3(1.0));
  vec3 up = max(pow(max(c, vec3(0.0)), vec3(1.0 - amount)) - c, vec3(0.0));
  return e + up * (1.0 - smoothstep(0.8, 1.0, c));
}

// A: smooth, magnify, brighten, smoothRadius · F: axis, feather, pushRadius · eyes, holes, mouth,
// S: skin colour (w = 1) · K: cheeks · pu: pushes · o: the outline.
vec3 retouch(vec2 p, vec4 A, vec4 F, vec4 eyeA, vec4 eyeB, vec4 holeA, vec4 holeB, vec4 mouth, vec4 S, vec4 K, vec4 pu[6], vec4 o[9]) {
  vec2 q = p;
  float r2 = F.w * F.w;
  for (int i = 0; i < 6; i++) {
    vec2 d = p - pu[i].xy;
    float d2 = dot(d, d);
    if (d2 < r2 && dot(pu[i].zw, pu[i].zw) > 0.0) {
      float w = 1.0 - d2 / r2;
      q -= (w * w) * pu[i].zw;
    }
  }
  if (A.y > 0.0) q -= magnify(p, eyeA, A.y) + magnify(p, eyeB, A.y);
  vec3 c = src(q);
  float sd = outline(q, o);
  float glow = 1.0 - smoothstep(-F.z * 2.0, F.z * 1.5, sd);
  if (glow <= 0.0) return c;
  float face = 1.0 - smoothstep(-F.z, F.z * 0.25, sd);
  float holes = smoothstep(1.0, 1.35, ellipse(q, holeA, F.xy)) * smoothstep(1.0, 1.35, ellipse(q, holeB, F.xy))
    * smoothstep(1.0, 1.3, ellipse(q, mouth, F.xy));
  vec3 skinColour = S.w > 0.5 ? S.rgb : (src(K.xy) + src(K.zw)) * 0.5;
  float tone = 1.0 - smoothstep(0.05, 0.13, distance(chroma(c), chroma(skinColour)));
  float skin = face * holes * tone;
  vec3 rgb = c;
  if (A.x > 0.0 && skin > 0.0) {
    vec3 sum = c;
    float total = 1.0;
    vec2 start = vec2(1.0, 0.0);
    for (int ring = 1; ring <= 3; ring++) {
      float reach = A.w * float(ring) / 3.0;
      float falloff = exp(-float(ring * ring) / 6.0);
      start = vec2(start.x * 0.92388 - start.y * 0.38268, start.x * 0.38268 + start.y * 0.92388);
      vec2 dir = start;
      for (int k = 0; k < 8; k++) {
        vec3 s = src(q + dir * reach);
        vec3 d = s - c;
        float w = falloff * exp(-dot(d, d) * 30.0);
        sum += s * w;
        total += w;
        dir = vec2(dir.x * 0.70711 - dir.y * 0.70711, dir.x * 0.70711 + dir.y * 0.70711);
      }
    }
    rgb = mix(rgb, sum / total, A.x * skin);
  }
  if (A.z > 0.0) rgb = lift(rgb, A.z * glow * (0.85 + 0.15 * holes) * (0.35 + 0.65 * tone));
  return rgb;
}

void main() {
  vec4 raw = texture2D(uTexSampler, vTexSamplingCoord);
  vec2 p = vec2(vTexSamplingCoord.x * uRes.x, (1.0 - vTexSamplingCoord.y) * uRes.y);
  gl_FragColor = raw;
  if (uSplit.w > 0.5) {
    // Compare: the original's side (source coordinates, top-left origin) is left alone.
    float coord = uSplit.x > 0.5 ? vTexSamplingCoord.x : 1.0 - vTexSamplingCoord.y;
    if ((coord < uSplit.y) == (uSplit.z > 0.5)) return;
  }
  for (int f = 0; f < 3; f++) {
    if (f >= uFaces) break;
    vec4 bounds = uFace[f * 25 + 1];
    if (p.x < bounds.x || p.y < bounds.y || p.x > bounds.z || p.y > bounds.w) continue;
    vec4 pu[6];
    for (int i = 0; i < 6; i++) pu[i] = uFace[f * 25 + 9 + i];
    vec4 o[9];
    for (int i = 0; i < 9; i++) o[i] = uFace[f * 25 + 15 + i];
    vec3 rgb = retouch(p, uFace[f * 25], uFace[f * 25 + 2], uFace[f * 25 + 3], uFace[f * 25 + 4], uFace[f * 25 + 5], uFace[f * 25 + 6],
      uFace[f * 25 + 7], uFace[f * 25 + 8], uFace[f * 25 + 24], pu, o);
    gl_FragColor = vec4(dec(rgb), raw.a);
    break;
  }
}
"""
  }
}
