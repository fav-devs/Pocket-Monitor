package com.favdevs.pocketnative.hands

import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.HardwareBuffer
import android.media.Image
import android.media.ImageReader
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES30
import android.os.Handler
import android.util.Log
import com.favdevs.pocketnative.video.PocketVideoGl
import com.favdevs.pocketnative.video.PocketVideoSession
import java.nio.ByteBuffer

/**
 * The camera's live picture, small, for the hand models.
 *
 * A [PocketVideoSession.FrameTap] on the decoder's GL thread: at most every `intervalNanos`, and
 * only when the models are free (`offer`), it draws the latched picture (the same `ingestOes`
 * pass the relay encoder uses, so colour and orientation match what the views show) `width`
 * across into an `ImageReader`'s surface and swaps. That is one small draw on the GL thread and
 * no read-back there: the reader hands the buffer to the hands worker (`handler`), which copies it
 * into a reused bitmap and calls `deliver`. A picture offered while the models are busy is never
 * drawn.
 */
class HandsFeedTap(
  val session: PocketVideoSession,
  private val width: Int,
  private val intervalNanos: Long,
  private val worker: Handler,
  private val offer: () -> Boolean,
  /** Frees the models when a picture taken with `offer` never reaches `deliver`. */
  private val offerDone: () -> Unit,
  private val deliver: (Bitmap) -> Unit,
) : PocketVideoSession.FrameTap {
  companion object {
    private const val TAG = "PocketHandsFeed"
  }

  @Volatile private var closed = false

  // ---- GL thread ----
  private var reader: ImageReader? = null
  private var egl: EGLSurface? = null
  private var size: Pair<Int, Int>? = null
  private var lastNanos = 0L

  // ---- worker ----
  private var bitmap: Bitmap? = null
  private var packed: ByteBuffer? = null

  private val available = ImageReader.OnImageAvailableListener { r ->
    val image = try {
      r.acquireLatestImage()
    } catch (t: Throwable) {
      null
    } ?: return@OnImageAvailableListener
    var handed = false
    try {
      if (!closed) {
        val picture = copy(image)
        if (picture != null) {
          handed = true
          deliver(picture)
        }
      }
    } catch (t: Throwable) {
      Log.w(TAG, "picture copy failed", t)
    } finally {
      runCatching { image.close() }
      // `deliver` frees the models when it is done; a picture not handed over frees them here.
      if (!handed) offerDone()
    }
  }

  override fun onFrame(session: PocketVideoSession) {
    if (closed || session.oesTexture == 0) return
    val now = System.nanoTime()
    if (now - lastNanos < intervalNanos) return
    val target = targetSize(session.width, session.height) ?: return
    if (!offer()) return
    var drawn = false
    try {
      if (reader == null || size != target) rebuild(target)
      val surface = egl ?: return
      val programs = PocketVideoGl.programs ?: return
      if (!PocketVideoGl.makeCurrent(surface)) return
      GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
      GLES30.glViewport(0, 0, target.first, target.second)
      GLES30.glDisable(GLES30.GL_BLEND)
      val p = programs.ingestOes
      p.use()
      GLES30.glActiveTexture(GLES30.GL_TEXTURE3)
      GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, session.oesTexture)
      GLES30.glUniform1i(p.loc("uTex"), 3)
      GLES30.glUniformMatrix4fv(p.loc("uSt"), 1, false, session.transform, 0)
      GLES30.glBindVertexArray(programs.vao)
      GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
      drawn = PocketVideoGl.swap(surface)
      lastNanos = now
    } catch (t: Throwable) {
      Log.w(TAG, "feed draw failed", t)
    } finally {
      PocketVideoGl.makeOffscreenCurrent()
      if (!drawn) offerDone()
    }
  }

  /** Removes the tap and frees the surface and the reader. */
  fun close() {
    closed = true
    session.removeFrameTap(this)
    PocketVideoGl.post { destroyGl() }
  }

  /** `width` across in proportion, even. */
  private fun targetSize(w: Int, h: Int): Pair<Int, Int>? {
    if (w <= 8 || h <= 8) return null
    val tw = minOf(width, w) and 1.inv()
    val th = maxOf(2, Math.round(h.toDouble() * tw / w).toInt() and 1.inv())
    return tw to th
  }

  /** GL thread. */
  private fun rebuild(target: Pair<Int, Int>) {
    destroyGl()
    val r = ImageReader.newInstance(
      target.first,
      target.second,
      PixelFormat.RGBA_8888,
      2,
      HardwareBuffer.USAGE_GPU_COLOR_OUTPUT or HardwareBuffer.USAGE_CPU_READ_OFTEN,
    )
    r.setOnImageAvailableListener(available, worker)
    egl = PocketVideoGl.createWindowSurface(r.surface)
    if (egl == null) Log.w(TAG, "no EGL surface for the hands reader")
    reader = r
    size = target
  }

  /** GL thread. */
  private fun destroyGl() {
    egl?.let { PocketVideoGl.destroySurface(it) }
    egl = null
    reader?.let { r ->
      r.setOnImageAvailableListener(null, null)
      // The worker may still hold an image; close the reader on the worker after it.
      worker.post { runCatching { r.close() } }
    }
    reader = null
    size = null
  }

  /** Worker: the RGBA buffer into the reused bitmap (rows packed when the buffer pads them). */
  private fun copy(image: Image): Bitmap? {
    val w = image.width
    val h = image.height
    val plane = image.planes.firstOrNull() ?: return null
    val buffer = plane.buffer
    val rowStride = plane.rowStride
    val out = bitmap?.takeIf { it.width == w && it.height == h } ?: Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { bitmap = it }
    if (rowStride == w * 4) {
      buffer.rewind()
      out.copyPixelsFromBuffer(buffer)
    } else {
      val rows = packed?.takeIf { it.capacity() == w * h * 4 } ?: ByteBuffer.allocateDirect(w * h * 4).also { packed = it }
      rows.clear()
      for (y in 0 until h) {
        buffer.limit(y * rowStride + w * 4)
        buffer.position(y * rowStride)
        rows.put(buffer)
      }
      buffer.clear()
      rows.flip()
      out.copyPixelsFromBuffer(rows)
    }
    return out
  }
}
