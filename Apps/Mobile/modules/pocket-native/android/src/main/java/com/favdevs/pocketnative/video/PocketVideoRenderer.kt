package com.favdevs.pocketnative.video

import android.opengl.GLES11Ext
import android.opengl.GLES30
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** What a pass reads: a session's latest decoded frame or a procedural demo scene. */
sealed class PocketVideoSource {
  class Frame(val session: PocketVideoSession) : PocketVideoSource()
  /** scene: 0 studio, 1 bars, 2 skin, 3 night. */
  class Demo(val scene: Int, val seconds: Float, val transfer: PocketVideoTransfer) : PocketVideoSource()

  val size: Pair<Int, Int>
    get() = when (this) {
      is Frame -> {
        val w = session.width
        val h = session.height
        // VERIFY: before the first output-format callback the SPS parse supplies the size; 720p
        // is only a last resort so the picture is not lost.
        if (w > 0 && h > 0) w to h else 1280 to 720
      }
      is Demo -> DEMO_WIDTH to DEMO_HEIGHT
    }

  companion object {
    const val DEMO_WIDTH = 1280
    const val DEMO_HEIGHT = 720

    fun demoScene(js: String?): Int? = when (js) {
      "studio" -> 0
      "bars" -> 1
      "skin" -> 2
      "night" -> 3
      else -> null
    }
  }
}

/**
 * GL passes of the picture pipeline (iOS `PocketVideoRenderer` equivalent). One instance per view;
 * GL thread only. Texture units: 0 signal, 1 LUT, 2 peaking mask, 3 decoder OES / peaking blur.
 */
class PocketVideoRenderer {
  private val programs: PocketVideoPrograms get() = PocketVideoGl.programs ?: error("GL not ready")
  private var signal: PocketGlFbo? = null
  private var blur: PocketGlFbo? = null
  private var mask: PocketGlFbo? = null

  private fun draw() {
    GLES30.glBindVertexArray(programs.vao)
    GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
  }

  /** Source → RGBA signal texture at source size (GL convention, upright). */
  fun ingest(source: PocketVideoSource): PocketGlFbo? {
    val (w, h) = source.size
    if (signal?.width != w || signal?.height != h) {
      signal?.release(); blur?.release(); mask?.release()
      signal = PocketGlFbo(w, h)
      blur = null
      mask = null
    }
    val target = signal ?: return null
    target.bind()
    GLES30.glDisable(GLES30.GL_BLEND)
    when (source) {
      is PocketVideoSource.Frame -> {
        val tex = source.session.oesTexture
        if (tex == 0) return null
        val p = programs.ingestOes
        p.use()
        GLES30.glActiveTexture(GLES30.GL_TEXTURE3)
        GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, tex)
        GLES30.glUniform1i(p.loc("uTex"), 3)
        GLES30.glUniformMatrix4fv(p.loc("uSt"), 1, false, source.session.transform, 0)
      }
      is PocketVideoSource.Demo -> {
        val p = programs.ingestDemo
        p.use()
        GLES30.glUniform4f(p.loc("uDemo"), source.scene.toFloat(), source.seconds % 3600f, source.transfer.id.toFloat(), w.toFloat() / h)
      }
    }
    draw()
    return target
  }

  private fun bindCommon(p: PocketGlProgram, signal: PocketGlFbo, lut: PocketVideoLut?, uniforms: FloatArray) {
    GLES30.glUniform4fv(p.loc("uFx"), PocketVideoFxUniforms.SLOTS, uniforms, 0)
    GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, signal.texture)
    GLES30.glUniform1i(p.loc("uSrc"), 0)
    GLES30.glActiveTexture(GLES30.GL_TEXTURE1)
    GLES30.glBindTexture(GLES30.GL_TEXTURE_3D, lut?.texture ?: programs.identityLut)
    GLES30.glUniform1i(p.loc("uLut"), 1)
  }

  /** Peaking edge mask (R stroke, G hairline) at source size. */
  private fun peaking(signal: PocketGlFbo, uniforms: FloatArray): Int {
    val w = signal.width
    val h = signal.height
    if (blur?.width != w || blur?.height != h) {
      blur?.release(); mask?.release()
      blur = PocketGlFbo(w, h)
      mask = PocketGlFbo(w, h)
    }
    val b = blur ?: return programs.emptyMask
    val m = mask ?: return programs.emptyMask
    b.bind()
    programs.peakBlur.use()
    bindCommon(programs.peakBlur, signal, null, uniforms)
    draw()
    m.bind()
    val pm = programs.peakMask
    pm.use()
    bindCommon(pm, signal, null, uniforms)
    GLES30.glActiveTexture(GLES30.GL_TEXTURE3)
    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, b.texture)
    GLES30.glUniform1i(pm.loc("uBlur"), 3)
    draw()
    return m.texture
  }

  /** The monitoring picture into `framebuffer` (0 = the current window surface). */
  fun picture(framebuffer: Int, width: Int, height: Int, signal: PocketGlFbo, fx: PocketPictureEffects, lut: PocketVideoLut?, uniforms: FloatArray) {
    val maskTexture = if (fx.peakingOn) peaking(signal, uniforms) else programs.emptyMask
    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, framebuffer)
    GLES30.glViewport(0, 0, width, height)
    val p = programs.picture
    p.use()
    bindCommon(p, signal, lut, uniforms)
    GLES30.glActiveTexture(GLES30.GL_TEXTURE2)
    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, maskTexture)
    GLES30.glUniform1i(p.loc("uMask"), 2)
    draw()
  }

  /** Signal (or graded picture) into a small target for the scopes. */
  fun measure(target: PocketGlFbo, signal: PocketGlFbo, afterLut: Boolean, lut: PocketVideoLut?, uniforms: FloatArray) {
    target.bind()
    val p = programs.measure
    p.use()
    bindCommon(p, signal, lut, uniforms)
    GLES30.glUniform4f(p.loc("uMeasure"), if (afterLut) 1f else 0f, 0f, 0f, 0f)
    draw()
  }

  fun release() {
    signal?.release(); blur?.release(); mask?.release()
    signal = null; blur = null; mask = null
  }

  companion object {
    /** RGBA8 rows of the bound framebuffer, top row first. */
    fun readRgba(width: Int, height: Int): ByteArray {
      val buffer = ByteBuffer.allocateDirect(width * height * 4).order(ByteOrder.nativeOrder())
      GLES30.glPixelStorei(GLES30.GL_PACK_ALIGNMENT, 1)
      GLES30.glReadPixels(0, 0, width, height, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, buffer)
      val bottomUp = ByteArray(width * height * 4)
      buffer.get(bottomUp)
      val out = ByteArray(bottomUp.size)
      val row = width * 4
      for (y in 0 until height) System.arraycopy(bottomUp, (height - 1 - y) * row, out, y * row, row)
      return out
    }

    /**
     * Renders `source` offscreen at `width`×`height` and returns RGBA (top row first).
     * GL thread only. `stretch` maps the whole source onto the target (meters).
     */
    fun renderOffscreen(source: PocketVideoSource, fx: PocketPictureEffects, width: Int, height: Int, stretch: Boolean): ByteArray? {
      PocketVideoGl.makeOffscreenCurrent()
      val renderer = PocketVideoRenderer()
      val out = PocketGlFbo(width, height)
      try {
        val signal = renderer.ingest(source) ?: return null
        val (sw, sh) = source.size
        val lut = PocketVideoLutRegistry.lut(fx.lutId)
        val u = PocketVideoFxUniforms.make(fx, lut, sw, sh, width.toDouble(), height.toDouble(), 2.0, false)
        if (stretch) {
          val m = PocketVideoFxUniforms.MAP * 4
          u[m] = 1f; u[m + 1] = 1f; u[m + 2] = 0f; u[m + 3] = 0f
        }
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, out.framebuffer)
        GLES30.glClearColor(0f, 0f, 0f, 1f)
        GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT)
        renderer.picture(out.framebuffer, width, height, signal, fx, lut, u)
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, out.framebuffer)
        return readRgba(width, height)
      } finally {
        out.release()
        renderer.release()
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
      }
    }
  }
}
