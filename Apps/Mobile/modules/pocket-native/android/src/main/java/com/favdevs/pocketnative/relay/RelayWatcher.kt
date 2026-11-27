package com.favdevs.pocketnative.relay

import com.favdevs.pocketnative.shared.PocketVideoCodec
import com.favdevs.pocketnative.shared.PocketVideoSinkRegistry
import com.favdevs.pocketnative.wifi.PocketCameraNetwork
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * One watcher join: a TCP connection to a host on the camera Wi-Fi (bound to the camera [android.net.Network]
 * PocketWifi joined, never cellular or another Wi-Fi), the hello, then frames into
 * [PocketVideoSinkRegistry] under [sessionId] so `PocketVideoView` decodes them, and the small
 * messages to JS. Retry policy lives in JS (`WatcherRelayRecovery`).
 *
 * After [close] no callback reaches the listener: stale connection callbacks are ignored.
 */
class RelayWatcher(
  val sessionId: String,
  private val addresses: List<InetAddress>,
  private val port: Int,
  private val hello: String,
  private val listener: Listener,
) {
  interface Listener {
    fun watcherStatus(watcher: RelayWatcher, state: String, error: String?)
    fun watcherMessage(watcher: RelayWatcher, kind: String, json: String)
    fun watcherStats(watcher: RelayWatcher, stats: Map<String, Any?>)
  }

  @Volatile private var closed = false
  @Volatile private var socket: Socket? = null
  private val writer = Executors.newSingleThreadScheduledExecutor { Thread(it, "pocket.relay.watch.$sessionId") }
  private var out: BufferedOutputStream? = null
  private var statsTask: ScheduledFuture<*>? = null

  // Reader-thread counters, published by the stats task.
  @Volatile private var frames = 0L
  @Volatile private var bytes = 0L
  @Volatile private var lastFrameAt = 0.0
  @Volatile private var codec: PocketVideoCodec? = null
  @Volatile private var catchingUp = false
  private var windowFrames = 0L
  private var windowBytes = 0L

  fun start() {
    Thread({ run() }, "pocket.relay.read.$sessionId").apply { isDaemon = true }.start()
  }

  fun close() {
    closed = true
    statsTask?.cancel(false)
    runCatching { socket?.close() }
    writer.shutdownNow()
  }

  fun send(kind: Int, payload: ByteArray) {
    if (closed) return
    runCatching {
      writer.execute {
        try {
          out?.apply {
            write(RelayWire.message(kind, payload))
            flush()
          }
        } catch (e: IOException) {
          fail(e.message ?: "The connection closed")
        }
      }
    }
  }

  private fun fail(error: String?) {
    if (closed) return
    closed = true
    statsTask?.cancel(false)
    runCatching { socket?.close() }
    listener.watcherStatus(this, "closed", error)
    writer.shutdown()
  }

  private fun run() {
    if (!closed) listener.watcherStatus(this, "connecting", null)
    var connected: Socket? = null
    var last: Exception = IOException("No address for that feed")
    for (address in addresses) {
      if (closed) return
      val s = Socket()
      try {
        // The camera network has no internet; bind like the datalink so the join never leaks onto
        // another Wi-Fi or cellular. Process binding covers the case where it is not known yet.
        PocketCameraNetwork.bindSocket(s)
        s.tcpNoDelay = true
        s.keepAlive = true
        s.connect(InetSocketAddress(address, port), CONNECT_MS)
        connected = s
        break
      } catch (e: Exception) {
        runCatching { s.close() }
        last = e
      }
    }
    val s = connected ?: return fail(last.message ?: "Could not reach the host")
    socket = s
    if (closed) {
      runCatching { s.close() }
      return
    }
    try {
      out = BufferedOutputStream(s.getOutputStream(), 16 * 1024)
      send(RelayWire.HELLO, hello.toByteArray(Charsets.UTF_8))
      listener.watcherStatus(this, "open", null)
      statsTask = writer.scheduleAtFixedRate({ publishStats() }, 1, 1, TimeUnit.SECONDS)
      PocketVideoSinkRegistry.reset(sessionId)
      readLoop(DataInputStream(s.getInputStream().buffered(256 * 1024)))
    } catch (e: Exception) {
      fail(if (e is RelayWire.ProtocolException) "The host sent a message this build cannot read." else e.message)
    }
  }

  private fun readLoop(input: DataInputStream) {
    val freshness = RelayFreshness()
    var sets: List<ByteArray> = emptyList()
    while (!closed) {
      val message = RelayWire.read(input, RelayWire.MAX_PAYLOAD)
      if (closed) return
      when (message.kind) {
        RelayWire.HELLO -> listener.watcherMessage(this, "hello", String(message.payload, Charsets.UTF_8))
        RelayWire.STATE -> listener.watcherMessage(this, "state", String(message.payload, Charsets.UTF_8))
        RelayWire.TOKEN -> listener.watcherMessage(this, "token", String(message.payload, Charsets.UTF_8))
        RelayWire.DENIED -> {
          listener.watcherMessage(this, "denied", String(message.payload, Charsets.UTF_8))
          closed = true
          statsTask?.cancel(false)
          runCatching { socket?.close() }
          return
        }
        RelayWire.FRAME -> {
          val frame = RelayWire.decodeFrame(message.payload) ?: throw RelayWire.ProtocolException("bad frame")
          val now = RelayWire.now()
          if (!frame.catchUp && freshness.isFallingBehind(frame.encodedAt, now)) return fail(RelayWire.FELL_BEHIND)
          if (frame.parameterSets.isNotEmpty()) sets = frame.parameterSets
          val au = if (frame.keyframe && sets.isNotEmpty() && !RelayWire.classify(frame.accessUnit, frame.codec).hasParameterSets) {
            RelayWire.prefixed(sets, frame.accessUnit)
          } else {
            frame.accessUnit
          }
          frames += 1
          bytes += message.payload.size
          lastFrameAt = now
          codec = frame.codec
          catchingUp = frame.catchUp
          PocketVideoSinkRegistry.publish(sessionId, au, frame.codec, System.nanoTime() / 1_000)
          // A joiner's catch-up arrives as a burst; pace it so the decoder does not shed it.
          if (frame.catchUp) Thread.sleep(CATCH_UP_PACE_MS)
        }
        else -> {} // Watcher → host kinds are never sent to a watcher; ignore.
      }
    }
  }

  private fun publishStats() {
    if (closed) return
    val f = frames
    val b = bytes
    val fps = f - windowFrames
    val kbps = (b - windowBytes) * 8 / 1000.0
    windowFrames = f
    windowBytes = b
    val age = if (lastFrameAt > 0) ((RelayWire.now() - lastFrameAt) * 1000).toLong() else -1L
    listener.watcherStats(
      this,
      mapOf(
        "sessionId" to sessionId,
        "framesPerSec" to fps.toDouble(),
        "kbps" to kbps,
        "frames" to f.toDouble(),
        "lastFrameAgeMs" to age.toDouble(),
        "codec" to when (codec) { PocketVideoCodec.HEVC -> "hevc"; PocketVideoCodec.AVC -> "avc"; null -> null },
        "catchingUp" to catchingUp,
      ),
    )
  }

  companion object {
    private const val CONNECT_MS = 5_000
    private const val CATCH_UP_PACE_MS = 4L
  }
}
