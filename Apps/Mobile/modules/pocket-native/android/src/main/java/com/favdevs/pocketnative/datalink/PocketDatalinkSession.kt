package com.favdevs.pocketnative.datalink

import android.os.Process
import android.util.Log
import com.favdevs.pocketnative.shared.PocketVideoCodec
import com.favdevs.pocketnative.shared.PocketVideoSinkRegistry
import com.favdevs.pocketnative.wifi.PocketCameraNetwork
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.LockSupport

/**
 * One camera datalink, ported from upstream `DatalinkDriver.kt` / iOS `DjiAppleDatalink`.
 *
 * Threads (none of them the JS or UI thread):
 * - `pocket.datalink.rx`  blocking receive, admission, ACK window bookkeeping, frame scan, depacketize.
 * - `pocket.datalink.ack` the window-ACK pump at `ackHz` (40) with absolute deadlines, priority
 *   URGENT_DISPLAY; also computes the 1 Hz stats. Independent of JS and of decoding.
 * - `pocket.datalink.tx`  single-thread executor for JS-originated writes (sendDuml / sendRaw), so
 *   command seqs are stamped and sent in call order without blocking the JS thread.
 * - `pocket.datalink.video` delivers complete access units to [PocketVideoSinkRegistry] sinks, so a slow
 *   decoder cannot stall receive or the ACK pump.
 * Every `socket.send` serializes on [sendLock]; sequencing state lives under [wire].
 *
 * Sequencing split with JS: JS builds the handshake (`sendRaw`, sniffed here for session id / seq /
 * baseSeq) and stamps the DUML seq in each frame; native adds transport + routing headers and
 * reseeds the command seq from the admitted 34-byte window. Native never sends `0x09/0xa8`.
 */
internal class PocketDatalinkSession(
  val id: String,
  private val host: String,
  private val port: Int,
  localPort: Int,
  ackHz: Double,
  private val tcpPokePort: Int?,
  private val tcpPokeBytes: ByteArray?,
  private val listener: Listener,
) {
  interface Listener {
    fun datalinkDuml(sessionId: String, bytes: ByteArray)
    fun datalinkState(sessionId: String, state: String, error: String?)
    fun datalinkStats(sessionId: String, stats: Map<String, Any?>)
  }

  /** Binding local :9004 kept 0x01 and dropped every 0x02 (Samsung); always ephemeral there. */
  private val localPort = if (localPort == 9004) 0 else localPort.coerceIn(0, 65535)
  private val periodNs = (1_000_000_000.0 / (if (ackHz > 0 && ackHz <= 200) ackHz else 40.0)).toLong()

  private val running = AtomicBoolean(false)
  private val closed = AtomicBoolean(false)
  private val sendLock = Any()
  private val wire = Any()
  private val assemblerLock = Any()
  private val stateLock = Any()

  @Volatile private var socket: DatagramSocket? = null
  @Volatile private var poke: Socket? = null
  private var remote: InetSocketAddress? = null
  private var rxThread: Thread? = null
  private var ackThread: Thread? = null
  private var pokeThread: Thread? = null
  private val tx: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "pocket.datalink.tx") }
  private val video: ExecutorService = Executors.newSingleThreadExecutor { r ->
    Thread({
      Process.setThreadPriority(Process.THREAD_PRIORITY_DISPLAY)
      r.run()
    }, "pocket.datalink.video")
  }

  // ---- under `wire` ----
  private var handshake: DumlWire.HandshakeInfo? = null
  private val admission = HandshakeAdmission()
  private var admitted = false
  private var udpSeq = 0
  private var cmdCounter = 0
  private val windows = AckWindows()
  private var videoAccepting = false
  private var droppedCommands = 0

  // ---- under `assemblerLock` ----
  private val assembler = VideoAssembler()
  @Volatile private var videoCodec: PocketVideoCodec? = null

  // ---- stats ----
  private val rxPackets = AtomicInteger(0)
  private val txPackets = AtomicInteger(0)
  private val rxBytesWindow = AtomicInteger(0)
  private val videoWindow = AtomicInteger(0)
  private val acksWindow = AtomicInteger(0)
  @Volatile private var lastRxAt = 0L
  private var openedAt = 0L
  private var statsWindowStart = 0L

  private var state = ""

  private val networkListener: (PocketCameraNetwork.Change, android.net.Network?) -> Unit = { change, _ ->
    when (change) {
      PocketCameraNetwork.Change.REPLACED ->
        setState("stalled", "camera Wi-Fi network was replaced; reopen the datalink to rebind")
      PocketCameraNetwork.Change.LOST -> setState("failed", "camera Wi-Fi network lost")
      else -> Unit
    }
  }

  // MARK: - Open (blocking; call from Dispatchers.IO)

  fun open() {
    openedAt = System.nanoTime()
    statsWindowStart = openedAt
    setState("opening")
    val isSoftAp = host.startsWith("192.168.2.")
    if (isSoftAp && !waitForCameraPath(8_000)) {
      throw IOException("camera Wi-Fi path not ready (no 192.168.2.x address)")
    }
    if (closed.get()) throw IOException("datalink closed while opening")
    openPoke()
    if (closed.get()) throw IOException("datalink closed while opening")

    // Handbook: unbound → Network.bindSocket → bind 0.0.0.0:ephemeral → connect 192.168.2.1:9004.
    val sock = DatagramSocket(null)
    try {
      sock.reuseAddress = true
      sock.soTimeout = 250
      runCatching { sock.receiveBufferSize = 512 * 1024 }
      PocketCameraNetwork.bindSocket(sock)
      sock.bind(InetSocketAddress(Inet4Address.getByName("0.0.0.0"), localPort))
      val address = InetSocketAddress(InetAddress.getByName(host), port)
      remote = address
      runCatching { sock.connect(address) }
        .onFailure { Log.w(TAG, "datalink: UDP connect failed, sending unconnected", it) }
    } catch (error: Throwable) {
      sock.close()
      throw IOException("UDP bind failed: ${error.message}", error)
    }
    Log.i(TAG, "datalink: UDP ${if (sock.isConnected) "connected" else "unconnected"} $host:$port " +
      "local=${sock.localSocketAddress} rcvbuf=${sock.receiveBufferSize}")
    socket = sock
    running.set(true)
    PocketCameraNetwork.addListener(networkListener)
    rxThread = Thread({ receiveLoop(sock) }, "pocket.datalink.rx").also { it.isDaemon = true; it.start() }
    ackThread = Thread({ ackLoop() }, "pocket.datalink.ack").also { it.isDaemon = true; it.start() }
  }

  /** Sockets created before DHCP on the SoftAP bind to the old Wi-Fi. Wait for 192.168.2.x. */
  private fun waitForCameraPath(timeoutMs: Long): Boolean {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (!closed.get()) {
      if (hasCameraAddress()) return true
      if (System.currentTimeMillis() >= deadline) return false
      try {
        Thread.sleep(150)
      } catch (_: InterruptedException) {
        return false
      }
    }
    return false
  }

  private fun hasCameraAddress(): Boolean = runCatching {
    NetworkInterface.getNetworkInterfaces()?.toList().orEmpty().any { nif ->
      nif.isUp && nif.inetAddresses.toList().any { a ->
        a is Inet4Address && PocketCameraNetwork.isCameraClientIPv4(a.hostAddress ?: "")
      }
    }
  }.getOrDefault(false)

  /**
   * TCP poke (SetPairingPIN bytes built by JS). Mimo keeps it open all session and the camera
   * writes 0x21/0x06 there ~3 Hz, so it is drained. Best effort: UDP proceeds on failure.
   */
  private fun openPoke() {
    val pokePort = tcpPokePort ?: return
    val bytes = tcpPokeBytes?.takeIf { it.isNotEmpty() } ?: return
    for (attempt in 1..3) {
      if (closed.get()) return
      val s = Socket()
      try {
        PocketCameraNetwork.bindSocket(s)
        s.connect(InetSocketAddress(host, pokePort), 2_000)
        s.tcpNoDelay = true
        s.getOutputStream().write(bytes)
        s.getOutputStream().flush()
        Thread.sleep(400)
        poke = s
        pokeThread = Thread({ drainPoke(s) }, "pocket.datalink.poke").also { it.isDaemon = true; it.start() }
        Log.i(TAG, "datalink: TCP $pokePort poke ready")
        return
      } catch (error: Throwable) {
        Log.w(TAG, "datalink: TCP poke attempt $attempt failed: ${error.javaClass.simpleName}")
        runCatching { s.close() }
        if (error is InterruptedException) return
        try {
          Thread.sleep(350)
        } catch (_: InterruptedException) {
          return
        }
      }
    }
  }

  private fun drainPoke(s: Socket) {
    val buf = ByteArray(4096)
    try {
      val input = s.getInputStream()
      while (!closed.get() && input.read(buf) >= 0) Unit
    } catch (_: IOException) {
    }
  }

  // MARK: - Receive

  private fun receiveLoop(sock: DatagramSocket) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_DISPLAY)
    val buf = ByteArray(65_536)
    val packet = DatagramPacket(buf, buf.size)
    while (running.get()) {
      try {
        packet.setLength(buf.size)
        sock.receive(packet)
      } catch (_: SocketTimeoutException) {
        continue
      } catch (error: IOException) {
        if (!running.get() || sock.isClosed) break
        Log.w(TAG, "datalink: UDP receive error ${error.javaClass.simpleName}, re-arm")
        try {
          Thread.sleep(40)
        } catch (_: InterruptedException) {
          break
        }
        continue
      }
      val length = packet.length
      if (length > 0) {
        try {
          ingest(buf, length)
        } catch (error: Throwable) {
          Log.e(TAG, "datalink: ingest failed", error)
        }
      }
    }
  }

  private fun ingest(d: ByteArray, length: Int) {
    rxPackets.incrementAndGet()
    rxBytesWindow.addAndGet(length)
    lastRxAt = System.nanoTime()
    if (currentState() == "stalled") setState("open")
    if (length < 8) return
    val pkt = DumlWire.u8(d, 6)

    var admittedNow = false
    var acceptVideo = false
    synchronized(wire) {
      if (!admitted && handshake != null) {
        admission.receive(d, length)
        val initial = admission.initialCommandSequence
        if (initial != null) {
          admitted = true
          udpSeq = initial
          // Arm 0x02 ingest on handshake admission, not on the enable write.
          videoAccepting = true
          admittedNow = true
        }
      }
      if (pkt == DumlWire.PKT_VIDEO) {
        if (videoAccepting && length >= 6) {
          windows.noteVideo(DumlWire.u16(d, 4))
          acceptVideo = true
        }
      } else {
        windows.note(d, length)
      }
    }
    if (admittedNow) {
      synchronized(assemblerLock) { assembler.reset() }
      sendWindowAck()
      setState("open")
    }

    if (pkt == DumlWire.PKT_VIDEO) {
      if (!acceptVideo) return
      videoWindow.incrementAndGet()
      val hint = videoCodec ?: return
      val out = synchronized(assemblerLock) { assembler.ingest(d, length, hint) } ?: return
      val pts = System.nanoTime() / 1_000
      val sessionId = id
      video.execute {
        for (sink in PocketVideoSinkRegistry.sinks(sessionId)) {
          runCatching { sink.receive(out.first, out.second, pts) }
            .onFailure { Log.w(TAG, "video sink threw", it) }
        }
      }
      return
    }

    for (frame in DumlWire.scanFrames(d, length)) listener.datalinkDuml(id, frame)
  }

  // MARK: - ACK pump + stats

  private fun ackLoop() {
    Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_DISPLAY)
    var next = System.nanoTime() + periodNs
    while (running.get()) {
      var now = System.nanoTime()
      while (now < next && running.get()) {
        LockSupport.parkNanos(next - now)
        now = System.nanoTime()
      }
      if (!running.get()) break
      sendWindowAck()
      next += periodNs
      // After a long stall (doze, GC), resume the cadence instead of bursting the missed ticks.
      if (now - next > periodNs * 4) next = now + periodNs
      if (now - statsWindowStart >= 1_000_000_000L) reportStats(now)
    }
  }

  /** pktType 0x04, seq 0. Silent until admitted: nothing but the handshake goes out before. */
  private fun sendWindowAck() {
    val packet = synchronized(wire) {
      val hs = handshake ?: return
      if (!admitted) return
      val payload = windows.payload(hs.baseSeq)
      DumlWire.transportHeader(DumlWire.PKT_ACK, payload.size, hs.sessionId, 0) + payload
    }
    if (send(packet)) acksWindow.incrementAndGet()
  }

  private fun reportStats(now: Long) {
    val elapsed = maxOf(0.001, (now - statsWindowStart) / 1e9)
    statsWindowStart = now
    val last = lastRxAt
    val lastRxAgeMs = (now - (if (last != 0L) last else openedAt)) / 1e6
    if (currentState() == "open" && lastRxAgeMs > 2_000) {
      setState("stalled", "no datagram from the camera for ${lastRxAgeMs.toInt()} ms")
    }
    listener.datalinkStats(id, mapOf(
      "sessionId" to id,
      "rxPackets" to rxPackets.get(),
      "txPackets" to txPackets.get(),
      "rxBytesPerSec" to rxBytesWindow.getAndSet(0) / elapsed,
      "videoPacketsPerSec" to videoWindow.getAndSet(0) / elapsed,
      "ackHz" to acksWindow.getAndSet(0) / elapsed,
      "lastRxAgeMs" to lastRxAgeMs,
    ))
  }

  // MARK: - TX

  private fun send(bytes: ByteArray): Boolean {
    val sock = socket ?: return false
    if (sock.isClosed) return false
    return try {
      synchronized(sendLock) {
        val packet = if (sock.isConnected) DatagramPacket(bytes, bytes.size)
        else DatagramPacket(bytes, bytes.size, remote ?: return false)
        sock.send(packet)
      }
      txPackets.incrementAndGet()
      true
    } catch (error: IOException) {
      if (running.get()) Log.w(TAG, "datalink: UDP write rejected ${error.javaClass.simpleName}")
      false
    }
  }

  fun sendRaw(bytes: ByteArray) {
    if (closed.get()) return
    val copy = bytes.copyOf()
    runCatching {
      tx.execute {
        if (closed.get()) return@execute
        DumlWire.parseOutgoingHandshake(copy)?.let(::noteOutgoingHandshake)
        send(copy)
      }
    }
  }

  /** Wraps one complete DUML frame (seq stamped by JS) in transport + routing headers. */
  fun sendDuml(frame: ByteArray) {
    if (closed.get()) return
    val duml = frame.copyOf()
    runCatching {
      tx.execute {
        if (closed.get()) return@execute
        val packet = synchronized(wire) {
          val hs = handshake
          if (!admitted || hs == null) {
            droppedCommands += 1
            if (droppedCommands == 1 || droppedCommands % 50 == 0) {
              Log.i(TAG, "datalink: drop DUML before handshake admission ($droppedCommands)")
            }
            return@execute
          }
          cmdCounter = (cmdCounter + 1) and 0xFF
          val routing = DumlWire.routingHeader(udpSeq, cmdCounter)
          val header = DumlWire.transportHeader(DumlWire.PKT_COMMAND, routing.size + duml.size, hs.sessionId, udpSeq)
          udpSeq = (udpSeq + 8) and 0xFFFF
          header + routing + duml
        }
        send(packet)
      }
    }
  }

  /** A handshake with a new session id / baseSeq starts a new admission epoch on this socket. */
  private fun noteOutgoingHandshake(info: DumlWire.HandshakeInfo) {
    var resetVideo = false
    synchronized(wire) {
      val current = handshake
      val same = current != null && current.sessionId == info.sessionId && current.baseSeq == info.baseSeq
      if (same && admitted) return
      if (!same) {
        handshake = info
        admission.reset()
        admitted = false
        cmdCounter = 0
        windows.reset()
        // Leftover GOP from the previous session must not be counted or decoded.
        videoAccepting = false
        resetVideo = true
      }
      udpSeq = (info.seq + 8) and 0xFFFF
    }
    if (resetVideo && videoCodec != null) {
      synchronized(assemblerLock) { assembler.reset() }
      resetSinks()
    }
    setState("handshaking")
  }

  // MARK: - Video routing

  fun attachVideo(codec: PocketVideoCodec) {
    synchronized(assemblerLock) {
      videoCodec = codec
      assembler.reset()
    }
    resetSinks()
  }

  fun detachVideo() {
    val wasAttached = synchronized(assemblerLock) {
      val was = videoCodec != null
      videoCodec = null
      assembler.reset()
      was
    }
    if (wasAttached) resetSinks()
  }

  private fun resetSinks() {
    val sessionId = id
    runCatching {
      video.execute { for (sink in PocketVideoSinkRegistry.sinks(sessionId)) runCatching { sink.reset() } }
    }
  }

  // MARK: - Close

  fun close() {
    if (!closed.compareAndSet(false, true)) return
    running.set(false)
    PocketCameraNetwork.removeListener(networkListener)
    runCatching { socket?.close() }
    socket = null
    runCatching { poke?.close() }
    poke = null
    val threads = listOfNotNull(rxThread, ackThread, pokeThread)
    rxThread = null
    ackThread = null
    pokeThread = null
    threads.forEach { it.interrupt() }
    threads.forEach { runCatching { it.join(300) } }
    tx.shutdownNow()
    if (videoCodec != null) {
      videoCodec = null
      val sessionId = id
      runCatching { video.execute { for (sink in PocketVideoSinkRegistry.sinks(sessionId)) runCatching { sink.reset() } } }
    }
    video.shutdown()
    runCatching { video.awaitTermination(300, TimeUnit.MILLISECONDS) }
    forceState("closed", null)
  }

  // MARK: - State

  private fun currentState(): String = synchronized(stateLock) { state }

  private fun setState(next: String, error: String? = null) {
    synchronized(stateLock) {
      if (closed.get() || next == state) return
      state = next
    }
    listener.datalinkState(id, next, error)
  }

  private fun forceState(next: String, error: String?) {
    synchronized(stateLock) { state = next }
    listener.datalinkState(id, next, error)
  }

  private companion object {
    const val TAG = "PocketDatalink"
  }
}
