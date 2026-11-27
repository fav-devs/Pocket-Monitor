package com.favdevs.pocketnative.relay

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES30
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.util.Log
import android.view.Surface
import com.favdevs.pocketnative.shared.PocketVideoCodec
import com.favdevs.pocketnative.video.PocketVideoGl
import com.favdevs.pocketnative.video.PocketVideoSession
import java.util.concurrent.atomic.AtomicInteger

/**
 * The relay's own picture (docs/watcher-relay.md; twin of iOS `PocketRelayEncoder`): the decoded
 * camera picture re-encoded as identity-size HEVC by the phone's hardware encoder, so watchers get
 * a keyframe at least every [KEY_INTERVAL_SECONDS] and on demand, never from the camera
 * (`0x09/0xa8` stays the watchdog's).
 *
 * Pipeline: the session's decoder renders into its SurfaceTexture on the shared GL thread; this
 * [PocketVideoSession.FrameTap] draws each latched OES frame into an EGL window surface on the
 * encoder's input Surface (same EGL context, recordable config), stamped with its arrival time.
 * The codec runs in async mode on its own thread; output goes to [Listener.encoded].
 *
 * Admission: at most two frames are drawn but not yet out of the encoder (a busy encoder skips
 * input, which keeps the reference chain intact, and the GL thread never waits on the encoder's
 * input queue); an encoder whose pipeline is deeper (no output for 500 ms with the window full)
 * gets one more slot, up to [MAX_ADMISSION]. Nothing is drawn while no watcher can take a frame
 * ([wantFrames]). A keyframe is requested ([wantKey]) at most once a second.
 *
 * Threads: GL thread owns the EGL surface and the draw; the encoder thread owns the codec; the
 * host reads/writes the volatile demand flags from its executor.
 */
class RelayEncoder(private val listener: Listener) : PocketVideoSession.FrameTap {
  interface Listener {
    /** Encoder thread. `au` is Annex-B; a keyframe carries its parameter sets in front. */
    fun encoded(encoder: RelayEncoder, au: ByteArray, key: Boolean, sets: List<ByteArray>?)
    /** The encoder could not be built or died: the host falls back to forwarding. */
    fun encoderFailed(encoder: RelayEncoder, reason: String)
  }

  private class Ready(val generation: Int, val surface: Surface, val width: Int, val height: Int)

  companion object {
    private const val TAG = "PocketRelay"
    const val MIME = MediaFormat.MIMETYPE_VIDEO_HEVC
    val LADDER = intArrayOf(10_000_000, 7_000_000, 4_500_000, 3_000_000)
    const val FRAME_RATE = 25
    const val KEY_INTERVAL_SECONDS = 2
    private const val MIN_FORCED_KEY_NANOS = 1_000_000_000L
    private const val MAX_ADMISSION = 5
    /** An encoder that swallowed frames must not freeze admission. */
    private const val STALL_NANOS = 500_000_000L
    private const val MAX_LONG_EDGE = 1920
    private const val FALLBACK_LONG_EDGE = 1280

    /** The hardware HEVC encoder that takes Surface input, or null (the host forwards instead). */
    val hardware: MediaCodecInfo? by lazy {
      runCatching {
        MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.firstOrNull { info ->
          info.isEncoder && info.isHardwareAccelerated && !info.isSoftwareOnly && !info.isAlias &&
            info.supportedTypes.any { it.equals(MIME, ignoreCase = true) } &&
            info.getCapabilitiesForType(MIME).colorFormats.contains(MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
        }
      }.getOrNull()
    }
  }

  @Volatile var wantFrames = false
  @Volatile var wantKey = false
  private val framesIn = AtomicInteger(0)
  private val inFlight = AtomicInteger(0)
  @Volatile private var lastOutputNanos = 0L
  @Volatile private var closed = false
  @Volatile private var ready: Ready? = null
  @Volatile private var admission = 2

  private val thread = HandlerThread("pocket.relay.encode", Process.THREAD_PRIORITY_DISPLAY).apply { start() }
  private val handler = Handler(thread.looper)

  // Encoder thread.
  private var codec: MediaCodec? = null
  private var inputSurface: Surface? = null
  private var generation = 0
  private var bitrate = LADDER[0]
  private var sets: List<ByteArray>? = null
  private var failed = false

  // GL thread.
  private var egl: EGLSurface? = null
  private var eglGeneration = -1
  private var requested: Pair<Int, Int>? = null
  private var lastKeyNanos = 0L

  /** Decoded frames that reached the tap since the last call (camera delivery rate). */
  fun takeFrames(): Int = framesIn.getAndSet(0)

  fun setBitrate(bps: Int) = handler.post {
    if (bps == bitrate) return@post
    bitrate = bps
    runCatching { codec?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bps) }) }
  }

  /** Remove the tap from the session first. Tears down the EGL surface, then the codec. */
  fun close() {
    closed = true
    wantFrames = false
    PocketVideoGl.post {
      destroyEgl()
      handler.post {
        releaseCodec()
        thread.quitSafely()
      }
    }
  }

  // ─── GL thread (frame tap) ───────────────────────────────────────────────────────

  override fun onFrame(session: PocketVideoSession) {
    framesIn.incrementAndGet()
    if (closed || session.oesTexture == 0) return
    val size = targetSize(session.width, session.height) ?: return
    val r = ready
    if (r == null || r.width != size.first || r.height != size.second) {
      if (requested != size) {
        requested = size
        destroyEgl()
        handler.post { build(size.first, size.second) }
      }
      return
    }
    if (egl == null || eglGeneration != r.generation) {
      destroyEgl()
      egl = PocketVideoGl.createWindowSurface(r.surface)
      eglGeneration = r.generation
      if (egl == null) {
        Log.w(TAG, "relay encoder: no EGL surface (recordable=${PocketVideoGl.recordable})")
        handler.post { fail("no EGL surface for the encoder") }
        return
      }
    }
    if (!wantFrames) return
    val now = System.nanoTime()
    if (inFlight.get() >= admission) {
      if (now - lastOutputNanos < STALL_NANOS) return
      if (admission < MAX_ADMISSION) {
        admission += 1
        Log.i(TAG, "relay encoder: deeper pipeline, admission $admission")
      }
      inFlight.set(0)
      lastOutputNanos = now
    }
    if (wantKey && now - lastKeyNanos >= MIN_FORCED_KEY_NANOS) {
      lastKeyNanos = now
      handler.post {
        runCatching { codec?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) }
      }
    }
    val surface = egl ?: return
    val programs = PocketVideoGl.programs ?: return
    if (!PocketVideoGl.makeCurrent(surface)) return
    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
    GLES30.glViewport(0, 0, r.width, r.height)
    GLES30.glDisable(GLES30.GL_BLEND)
    val p = programs.ingestOes
    p.use()
    GLES30.glActiveTexture(GLES30.GL_TEXTURE3)
    GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, session.oesTexture)
    GLES30.glUniform1i(p.loc("uTex"), 3)
    GLES30.glUniformMatrix4fv(p.loc("uSt"), 1, false, session.transform, 0)
    GLES30.glBindVertexArray(programs.vao)
    GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
    PocketVideoGl.setPresentationTime(surface, session.frameArrivedNanos)
    if (PocketVideoGl.swap(surface)) {
      if (inFlight.incrementAndGet() == 1) lastOutputNanos = now
    }
    PocketVideoGl.makeOffscreenCurrent()
  }

  /** Identity size (even), scaled down only past 1920 px on the long edge or when unsupported. */
  private fun targetSize(w: Int, h: Int): Pair<Int, Int>? {
    if (w <= 8 || h <= 8) return null
    fun fit(limit: Int): Pair<Int, Int> {
      val scale = minOf(1.0, limit.toDouble() / maxOf(w, h))
      return ((w * scale).toInt() and 1.inv()) to ((h * scale).toInt() and 1.inv())
    }
    val identity = fit(MAX_LONG_EDGE)
    val caps = runCatching { hardware?.getCapabilitiesForType(MIME)?.videoCapabilities }.getOrNull() ?: return identity
    if (caps.isSizeSupported(identity.first, identity.second)) return identity
    return fit(FALLBACK_LONG_EDGE)
  }

  private fun destroyEgl() {
    egl?.let { PocketVideoGl.destroySurface(it) }
    egl = null
    eglGeneration = -1
  }

  // ─── Encoder thread ──────────────────────────────────────────────────────────────

  private fun build(width: Int, height: Int) {
    if (closed || failed) return
    releaseCodec()
    val info = hardware ?: return fail("no hardware HEVC encoder")
    val caps = runCatching { info.getCapabilitiesForType(MIME) }.getOrNull()
    fun format(extras: Boolean): MediaFormat = MediaFormat.createVideoFormat(MIME, width, height).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
      setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
      setInteger(MediaFormat.KEY_FRAME_RATE, FRAME_RATE)
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, KEY_INTERVAL_SECONDS)
      setInteger(MediaFormat.KEY_PRIORITY, 0) // real time
      if (extras) {
        setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.HEVCProfileMain)
        val cbr = caps?.encoderCapabilities?.isBitrateModeSupported(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR) == true
        setInteger(
          MediaFormat.KEY_BITRATE_MODE,
          if (cbr) MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR else MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR,
        )
        setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
        // Low delay: output each frame as soon as it is encoded (API 30+).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) setInteger(MediaFormat.KEY_LATENCY, 1)
        // VERIFY on device: vendor low-latency key (ignored by components that don't know it).
        setInteger("vendor.qti-ext-enc-low-latency.enable", 1)
      }
    }
    for (extras in listOf(true, false)) {
      var created: MediaCodec? = null
      var surface: Surface? = null
      try {
        created = MediaCodec.createByCodecName(info.name)
        created.setCallback(callback, handler)
        created.configure(format(extras), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        surface = created.createInputSurface()
        created.start()
        codec = created
        inputSurface = surface
        generation += 1
        sets = null
        inFlight.set(0)
        ready = Ready(generation, surface, width, height)
        Log.i(TAG, "relay encoder ${info.name} ${width}x$height HEVC $bitrate b/s extras=$extras")
        return
      } catch (e: Exception) {
        Log.w(TAG, "relay encoder configure (extras=$extras) failed", e)
        runCatching { surface?.release() }
        runCatching { created?.release() }
      }
    }
    fail("the hardware encoder refused ${width}x$height")
  }

  private fun fail(reason: String) {
    if (failed || closed) return
    failed = true
    ready = null
    releaseCodec()
    listener.encoderFailed(this, reason)
  }

  private fun releaseCodec() {
    ready = null
    val c = codec
    codec = null
    if (c != null) {
      runCatching { c.stop() }
      runCatching { c.release() }
    }
    runCatching { inputSurface?.release() }
    inputSurface = null
  }

  private val callback = object : MediaCodec.Callback() {
    override fun onInputBufferAvailable(mc: MediaCodec, index: Int) = Unit // Surface input

    override fun onOutputBufferAvailable(mc: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
      if (mc !== codec) return
      val bytes = try {
        val buffer = mc.getOutputBuffer(index)
        val out = if (buffer != null && info.size > 0) {
          buffer.position(info.offset)
          buffer.limit(info.offset + info.size)
          ByteArray(info.size).also { buffer.get(it) }
        } else null
        mc.releaseOutputBuffer(index, false)
        out
      } catch (e: Exception) {
        Log.w(TAG, "relay encoder output failed", e)
        null
      }
      if ((info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
        if (bytes != null) sets = RelayWire.classify(bytes, PocketVideoCodec.HEVC).parameterSets.ifEmpty { null }
        return
      }
      if (inFlight.decrementAndGet() < 0) inFlight.set(0)
      lastOutputNanos = System.nanoTime()
      if (bytes == null || closed) return
      val c = RelayWire.classify(bytes, PocketVideoCodec.HEVC)
      if (c.hasParameterSets) sets = c.parameterSets
      val key = c.keyframe || (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0
      val keySets = if (key) sets else null
      val au = if (key && !c.hasParameterSets && keySets != null) RelayWire.prefixed(keySets, bytes) else bytes
      listener.encoded(this@RelayEncoder, au, key, keySets)
    }

    override fun onError(mc: MediaCodec, e: MediaCodec.CodecException) {
      if (mc !== codec) return
      Log.w(TAG, "relay encoder error transient=${e.isTransient} recoverable=${e.isRecoverable}", e)
      if (e.isTransient) return
      fail("the hardware encoder stopped")
    }

    override fun onOutputFormatChanged(mc: MediaCodec, format: MediaFormat) {
      if (mc !== codec) return
      // Some encoders report the parameter sets here instead of a codec-config buffer.
      val csd = runCatching { format.getByteBuffer("csd-0") }.getOrNull() ?: return
      val bytes = ByteArray(csd.remaining()).also { csd.duplicate().get(it) }
      RelayWire.classify(bytes, PocketVideoCodec.HEVC).parameterSets.takeIf { it.isNotEmpty() }?.let { sets = it }
    }
  }
}

/**
 * Upstream `WatcherRelayBitrate` (twin of iOS `PocketRelayBitrate`): a 5 s window of 5 Hz ticks.
 * More than 30 % consecutive-saturated ticks (every watcher's window full, or the camera delivering
 * below 80 % of the best rate seen) step one rung down; 30 clean seconds step one rung back up.
 */
internal class RelayBitrate(now: Double) {
  companion object {
    const val WINDOW_SECONDS = 5.0
    const val STEP_DOWN = 0.3
    const val STEP_UP = 0.05
    const val CLEAN_SECONDS = 30.0
    const val STARVATION_FRACTION = 0.8
  }

  var ceilingIndex = 0
  var rungIndex = 0
    private set
  private var windowStartedAt = now
  private var ticks = 0
  private var saturatedTicks = 0
  private var previousFull = false
  private var cleanSince = now

  val bitsPerSecond: Int
    get() = RelayEncoder.LADDER[maxOf(rungIndex, ceilingIndex).coerceIn(0, RelayEncoder.LADDER.size - 1)]

  /** The new bitrate when it changes. */
  fun tick(saturated: Boolean, cameraStarving: Boolean, now: Double): Int? {
    val full = saturated || cameraStarving
    ticks += 1
    if (full && previousFull) saturatedTicks += 1
    previousFull = full
    if (now - windowStartedAt < WINDOW_SECONDS || ticks == 0) return null
    val saturation = saturatedTicks.toDouble() / ticks
    ticks = 0
    saturatedTicks = 0
    windowStartedAt = now
    if (saturation > STEP_DOWN) {
      cleanSince = now
      if (rungIndex >= RelayEncoder.LADDER.size - 1) return null
      rungIndex += 1
      return bitsPerSecond
    }
    if (saturation > STEP_UP) {
      cleanSince = now
      return null
    }
    if (rungIndex > ceilingIndex && now - cleanSince >= CLEAN_SECONDS) {
      rungIndex -= 1
      cleanSince = now
      return bitsPerSecond
    }
    return null
  }
}
