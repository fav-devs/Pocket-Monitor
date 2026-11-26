package com.favdevs.pocketnative.video

import android.graphics.SurfaceTexture
import android.media.MediaCodec
import android.media.MediaFormat
import android.opengl.GLES11Ext
import android.opengl.GLES30
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.util.Log
import android.view.Surface
import com.favdevs.pocketnative.shared.PocketVideoCodec
import com.favdevs.pocketnative.shared.PocketVideoSink
import com.favdevs.pocketnative.shared.PocketVideoSinkRegistry
import java.io.ByteArrayOutputStream
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean

/** Sessions shared by every view of one `sessionId`, reference-counted by those views. */
object PocketVideoSessionHub {
  private val sessions = HashMap<String, Pair<PocketVideoSession, Int>>()

  @Synchronized
  fun acquire(id: String): PocketVideoSession {
    sessions[id]?.let { (session, refs) ->
      sessions[id] = session to refs + 1
      return session
    }
    val session = PocketVideoSession(id)
    sessions[id] = session to 1
    PocketVideoSinkRegistry.add(id, session)
    return session
  }

  fun release(session: PocketVideoSession) {
    synchronized(this) {
      val entry = sessions[session.sessionId] ?: return
      if (entry.first !== session) return
      if (entry.second > 1) {
        sessions[session.sessionId] = session to entry.second - 1
        return
      }
      sessions.remove(session.sessionId)
    }
    PocketVideoSinkRegistry.remove(session.sessionId, session)
    session.shutdown()
  }

  @Synchronized
  fun existing(id: String): PocketVideoSession? = sessions[id]?.first
}

/**
 * Per-session MediaCodec decoder (async callback mode) fed Annex-B access units by the datalink,
 * rendering into a SurfaceTexture on the shared GL context.
 *
 * Threads: `receive`/`reset` (datalink thread) only queue; every MediaCodec call happens on the
 * session's codec HandlerThread; the SurfaceTexture belongs to the GL thread, which latches each
 * frame as it arrives (latest wins) and lets views present it at the next vsync.
 */
class PocketVideoSession(val sessionId: String) : PocketVideoSink {
  private class Au(val data: ByteArray, val codec: PocketVideoCodec, val ptsUs: Long)

  companion object {
    private const val TAG = "PocketVideoSession"
    /** Backlog beyond this sheds until the next keyframe instead of growing latency. */
    private const val MAX_PENDING = 4
    private val START = byteArrayOf(0, 0, 0, 1)
  }

  private val codecThread = HandlerThread("pocket-codec-$sessionId", Process.THREAD_PRIORITY_URGENT_DISPLAY).apply { start() }
  private val codecHandler = Handler(codecThread.looper)

  // Guarded by `pending`.
  private val pending = ArrayDeque<Au>()
  private var shedding = false
  private var forceKeyframeWait = false
  @Volatile private var closed = false
  private val pumpScheduled = AtomicBoolean(false)

  // Codec thread confined.
  private var codec: MediaCodec? = null
  private var codecKind: PocketVideoCodec? = null
  private var vps: ByteArray? = null
  private var sps: ByteArray? = null
  private var pps: ByteArray? = null
  private var configuredSets: List<ByteArray>? = null
  private var awaitingKeyframe = true
  private val freeInputs = ArrayDeque<Int>()
  private var surface: Surface? = null
  private var configureFailed = false

  // GL thread confined.
  var oesTexture = 0
    private set
  private var surfaceTexture: SurfaceTexture? = null
  /** SurfaceTexture transform for the latest latched frame (GL thread). */
  val transform = FloatArray(16)

  // Read by views / module from any thread.
  @Volatile var frameSequence = 0L
    private set
  @Volatile var frameArrivedNanos = 0L
    private set
  @Volatile var width = 0
    private set
  @Volatile var height = 0
    private set
  @Volatile var decodedTotal = 0L
    private set
  @Volatile var droppedTotal = 0L
    private set
  /** Effects of the most recently drawn picture (for `snapshot(withEffects)`). */
  @Volatile var lastEffects = PocketPictureEffects()

  init {
    PocketVideoGl.post {
      val ids = IntArray(1)
      GLES30.glGenTextures(1, ids, 0)
      oesTexture = ids[0]
      GLES30.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTexture)
      GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
      GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
      GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
      GLES30.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
      val st = SurfaceTexture(oesTexture)
      st.setOnFrameAvailableListener({ onFrameAvailable() }, PocketVideoGl.handler)
      surfaceTexture = st
      val target = Surface(st)
      codecHandler.post { surface = target; schedulePump() }
    }
  }

  /** GL thread: latch the newest decoded picture. Called once per decoded frame. */
  private fun onFrameAvailable() {
    val st = surfaceTexture ?: return
    try {
      st.updateTexImage()
      st.getTransformMatrix(transform)
    } catch (e: Exception) {
      Log.w(TAG, "updateTexImage failed", e)
      return
    }
    frameArrivedNanos = System.nanoTime()
    frameSequence += 1
  }

  fun shutdown() {
    closed = true
    synchronized(pending) { pending.clear() }
    codecHandler.post {
      releaseCodec()
      surface?.release()
      surface = null
      codecThread.quitSafely()
    }
    PocketVideoGl.post {
      surfaceTexture?.release()
      surfaceTexture = null
      if (oesTexture != 0) GLES30.glDeleteTextures(1, intArrayOf(oesTexture), 0)
      oesTexture = 0
    }
  }

  // ─── PocketVideoSink (datalink thread; never blocks) ───────────────────────────────────

  override fun receive(accessUnit: ByteArray, codec: PocketVideoCodec, presentationTimeUs: Long) {
    if (closed) return
    synchronized(pending) {
      if (pending.size >= MAX_PENDING) shedding = true
    }
    val keyframe = if (shedding) PocketVideoAnnexB.carriesKeyframe(accessUnit, codec) else false
    synchronized(pending) {
      if (shedding) {
        if (!keyframe) {
          droppedTotal++
          return
        }
        shedding = false
        forceKeyframeWait = true
        // Everything still queued predates the keyframe and is now useless.
        droppedTotal += pending.size
        pending.clear()
      }
      pending.addLast(Au(accessUnit, codec, presentationTimeUs))
    }
    schedulePump()
  }

  override fun reset() {
    codecHandler.post {
      synchronized(pending) { pending.clear() }
      releaseCodec()
      vps = null; sps = null; pps = null
      configuredSets = null
      configureFailed = false
      awaitingKeyframe = true
    }
  }

  // ─── Codec thread ──────────────────────────────────────────────────────────────────

  private fun schedulePump() {
    if (pumpScheduled.compareAndSet(false, true)) {
      codecHandler.post {
        pumpScheduled.set(false)
        pump()
      }
    }
  }

  private fun pump() {
    while (!closed) {
      val au: Au = synchronized(pending) {
        when {
          pending.isEmpty() -> null
          // Hold the AU until the codec has an input buffer, unless there is no codec yet.
          codec != null && freeInputs.isEmpty() -> null
          else -> {
            if (forceKeyframeWait) {
              forceKeyframeWait = false
              awaitingKeyframe = true
            }
            pending.removeFirst()
          }
        }
      } ?: return
      process(au)
    }
  }

  private fun process(au: Au) {
    val kind = au.codec
    if (kind != codecKind) {
      releaseCodec()
      codecKind = kind
      vps = null; sps = null; pps = null
      configuredSets = null
    }
    val nals = PocketVideoAnnexB.nals(au.data, kind)
    val out = ByteArrayOutputStream(au.data.size + 16)
    var randomAccess = false
    var slices = 0
    for (nal in nals) {
      val t = nal.type
      if (PocketVideoAnnexB.isParameterSet(t, kind)) {
        val bytes = au.data.copyOfRange(nal.offset, nal.offset + nal.length)
        when {
          kind == PocketVideoCodec.HEVC && t == 32 -> {
            if (vps?.contentEquals(bytes) != true) configureFailed = false
            vps = bytes
          }
          (kind == PocketVideoCodec.HEVC && t == 33) || (kind == PocketVideoCodec.AVC && t == 7) -> {
            if (sps?.contentEquals(bytes) != true) {
              configureFailed = false
              PocketVideoAnnexB.spsSize(bytes, 0, bytes.size, kind)?.let { (w, h) -> width = w; height = h }
            }
            sps = bytes
          }
          else -> {
            if (pps?.contentEquals(bytes) != true) configureFailed = false
            pps = bytes
          }
        }
        out.write(START); out.write(au.data, nal.offset, nal.length)
      } else if (PocketVideoAnnexB.isVcl(t, kind)) {
        if (PocketVideoAnnexB.isRandomAccess(t, kind)) randomAccess = true
        out.write(START); out.write(au.data, nal.offset, nal.length)
        slices++
      }
      // AUD, SEI (DJI metadata), DJI marker (HEVC 63) are dropped.
    }

    val sets = currentSets(kind)
    if (sets != null && configuredSets != null && !sameSets(sets, configuredSets!!)) {
      // New stream geometry / profile: rebuild the decoder from the new parameter sets.
      releaseCodec()
      configureFailed = false
    }
    if (codec == null) {
      if (sets == null || surface == null || configureFailed || !randomAccess) {
        droppedTotal++
        return
      }
      if (!configure(kind, sets)) {
        droppedTotal++
        return
      }
      awaitingKeyframe = true
    }
    if (slices == 0) return
    if (awaitingKeyframe) {
      if (!randomAccess) {
        droppedTotal++
        return
      }
      awaitingKeyframe = false
    }
    val decoder = codec ?: return
    val index = freeInputs.pollFirst() ?: run {
      // Configure just happened and no input buffer is announced yet: keep the AU for later.
      synchronized(pending) { pending.addFirst(au) }
      return
    }
    try {
      val buffer = decoder.getInputBuffer(index) ?: return
      buffer.clear()
      val bytes = out.toByteArray()
      if (bytes.size > buffer.capacity()) {
        droppedTotal++
        awaitingKeyframe = true
        decoder.queueInputBuffer(index, 0, 0, au.ptsUs, 0)
        return
      }
      buffer.put(bytes)
      val flags = if (randomAccess) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
      decoder.queueInputBuffer(index, 0, bytes.size, au.ptsUs, flags)
    } catch (e: Exception) {
      Log.w(TAG, "queueInputBuffer failed", e)
      droppedTotal++
      releaseCodec()
    }
  }

  private fun currentSets(kind: PocketVideoCodec): List<ByteArray>? = when (kind) {
    PocketVideoCodec.HEVC -> { val v = vps; val s = sps; val p = pps; if (v != null && s != null && p != null) listOf(v, s, p) else null }
    PocketVideoCodec.AVC -> { val s = sps; val p = pps; if (s != null && p != null) listOf(s, p) else null }
  }

  private fun sameSets(a: List<ByteArray>, b: List<ByteArray>) =
    a.size == b.size && a.indices.all { a[it].contentEquals(b[it]) }

  private fun annexB(vararg nals: ByteArray): java.nio.ByteBuffer {
    val out = ByteArrayOutputStream()
    for (nal in nals) { out.write(START); out.write(nal) }
    return java.nio.ByteBuffer.wrap(out.toByteArray())
  }

  private fun configure(kind: PocketVideoCodec, sets: List<ByteArray>): Boolean {
    val target = surface ?: return false
    val mime = if (kind == PocketVideoCodec.HEVC) MediaFormat.MIMETYPE_VIDEO_HEVC else MediaFormat.MIMETYPE_VIDEO_AVC
    val w = if (width > 0) width else 1920
    val h = if (height > 0) height else 1080
    fun format(lowLatency: Boolean): MediaFormat {
      val f = MediaFormat.createVideoFormat(mime, w, h)
      if (kind == PocketVideoCodec.HEVC) {
        f.setByteBuffer("csd-0", annexB(sets[0], sets[1], sets[2]))
      } else {
        f.setByteBuffer("csd-0", annexB(sets[0]))
        f.setByteBuffer("csd-1", annexB(sets[1]))
      }
      f.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 1 shl 20)
      f.setInteger(MediaFormat.KEY_PRIORITY, 0) // real time
      if (lowLatency) {
        // Some components refuse an operating rate above their capability: only on the first try.
        f.setInteger(MediaFormat.KEY_OPERATING_RATE, 120)
        if (Build.VERSION.SDK_INT >= 30) f.setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
        // VERIFY on device: vendor low-latency keys (ignored by components that don't know them).
        f.setInteger("vendor.qti-ext-dec-low-latency.enable", 1)
        f.setInteger("vendor.rtc-ext-dec-low-latency.enable", 1)
        f.setInteger("vendor.low-latency.enable", 1)
      }
      // Do not stamp KEY_COLOR_*: Pocket VUI is unspecified (upstream HevcDecoder note).
      return f
    }
    for (lowLatency in listOf(true, false)) {
      var created: MediaCodec? = null
      try {
        created = MediaCodec.createDecoderByType(mime)
        created.setCallback(callback, codecHandler)
        created.configure(format(lowLatency), target, null, 0)
        created.start()
        codec = created
        configuredSets = sets
        freeInputs.clear()
        Log.i(TAG, "decoder ${created.name} ${w}x$h lowLatency=$lowLatency")
        return true
      } catch (e: Exception) {
        Log.w(TAG, "configure (lowLatency=$lowLatency) failed", e)
        try { created?.release() } catch (_: Exception) {}
      }
    }
    configureFailed = true
    return false
  }

  private fun releaseCodec() {
    val c = codec ?: return
    codec = null
    configuredSets = null
    freeInputs.clear()
    awaitingKeyframe = true
    try { c.stop() } catch (_: Exception) {}
    try { c.release() } catch (_: Exception) {}
  }

  private val callback = object : MediaCodec.Callback() {
    override fun onInputBufferAvailable(mc: MediaCodec, index: Int) {
      if (mc !== codec) return
      freeInputs.addLast(index)
      pump()
    }

    override fun onOutputBufferAvailable(mc: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
      if (mc !== codec) return
      try {
        val render = info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) == 0
        // Render immediately: the GL thread latches it and the next vsync presents it.
        mc.releaseOutputBuffer(index, render)
        if (render) decodedTotal++
      } catch (e: Exception) {
        Log.w(TAG, "releaseOutputBuffer failed", e)
      }
    }

    override fun onError(mc: MediaCodec, e: MediaCodec.CodecException) {
      if (mc !== codec) return
      Log.w(TAG, "codec error recoverable=${e.isRecoverable} transient=${e.isTransient}", e)
      droppedTotal++
      if (e.isTransient) return
      // Recoverable or fatal: rebuild from the stored parameter sets at the next keyframe.
      releaseCodec()
      configureFailed = false
    }

    override fun onOutputFormatChanged(mc: MediaCodec, format: MediaFormat) {
      if (mc !== codec) return
      var w = format.getInteger(MediaFormat.KEY_WIDTH)
      var h = format.getInteger(MediaFormat.KEY_HEIGHT)
      if (format.containsKey("crop-left") && format.containsKey("crop-right")) {
        w = format.getInteger("crop-right") - format.getInteger("crop-left") + 1
      }
      if (format.containsKey("crop-top") && format.containsKey("crop-bottom")) {
        h = format.getInteger("crop-bottom") - format.getInteger("crop-top") + 1
      }
      if (w > 0 && h > 0) { width = w; height = h }
    }
  }
}
