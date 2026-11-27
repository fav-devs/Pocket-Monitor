package com.favdevs.pocketnative.relay

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import com.favdevs.pocketnative.background.PocketServerNetworks
import java.net.Inet4Address
import java.net.InetAddress
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import com.favdevs.pocketnative.shared.PocketVideoCodec
import com.favdevs.pocketnative.shared.PocketVideoSink
import com.favdevs.pocketnative.shared.PocketVideoSinkRegistry
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * The sharing host (docs/watcher-relay.md "Ownership and bounds", adapted for forwarding):
 *
 * - A tap on the camera's video session in [PocketVideoSinkRegistry] receives the camera's Annex-B
 *   access units on the datalink video thread and hands them to [exec]; frames never cross JS.
 * - The Pocket sends no regular keyframes, so the host keeps the current GOP (the last keyframe
 *   with its parameter sets and every frame since). A joiner is served from that keyframe and
 *   catches up (`catchUp` frames); when the GOP outgrows its bound the host stops admitting joiners
 *   until the camera's next keyframe (it never asks the camera for one).
 * - Each authorized watcher has [window] video sends in flight; hello, state and tokens do not use
 *   the window; at most one state send is outstanding per watcher and newer states replace it.
 * - Passcode and version refusals, and an explicit stop, are flushed before the socket closes
 *   (three-second bound).
 * - Control: one holder; a request waits for the operator's Grant / Deny (JS); a dropped holder
 *   with a watcher id is parked for 20 s and restored when it returns.
 *
 * Threading: [exec] (single thread) owns every field below. Each peer has a reader thread and a
 * single-thread writer; their completions hop back onto [exec].
 */
class RelayHost(
  private val context: Context,
  private val listener: Listener,
) : PocketVideoSink {
  interface Listener {
    fun hostStatus(status: Map<String, Any?>)
    fun hostCommand(json: String, watcherId: String)
  }

  class Options(
    val cameraSessionId: String,
    val hostName: String,
    val cameraName: String,
    val passcode: String,
    val allowsControl: Boolean,
    val window: Int,
  )

  private val exec: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { Thread(it, "pocket.relay.host") }

  // exec-confined
  private var options: Options? = null
  private var server: ServerSocket? = null
  private var registration: NsdManager.RegistrationListener? = null
  private var advertisedName = ""
  private var running = false
  private var state = "stopped"
  private var error: String? = null
  private var generation = 0
  private val peers = LinkedHashMap<Int, Peer>()
  private var nextPeer = 1
  private var holder: Peer? = null
  private var pending: Peer? = null
  private var parkedId: String? = null
  private var parkedName = ""
  private var parkedUntil = 0.0
  private var latestState: ByteArray? = null
  private var recording = false
  private val gop = ArrayDeque<Unit>()
  private var gopBytes = 0L
  private var nextIndex = 0L
  private var joinable = false
  private var parameterSets: List<ByteArray> = emptyList()
  private var lastStatus: Map<String, Any?>? = null
  private var sent = 0L
  private var skipped = 0L
  private var keys = 0L
  private var metricsAt = RelayWire.now()

  private class Unit(val index: Long, val au: ByteArray, val codec: PocketVideoCodec, val key: Boolean, val sets: List<ByteArray>?, val at: Double)

  private inner class Peer(val id: Int, val socket: Socket, val generation: Int) {
    val writer: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "pocket.relay.peer.$id") }
    val out = BufferedOutputStream(socket.getOutputStream(), 64 * 1024)
    var authorized = false
    var closing = false
    var name = "Watcher"
    var watcherId: String? = null
    /** Absolute GOP index of the next frame to send; -1 waits for a keyframe. */
    var cursor = -1L
    var inFlight = 0
    var stateInFlight = false
    var pendingState: ByteArray? = null
    val connectedAt = RelayWire.now()
  }

  // ───────────────────────────── Lifecycle (any thread) ─────────────────────────────

  fun start(next: Options, done: (Throwable?) -> kotlin.Unit) {
    exec.execute {
      try {
        stopLocked(null)
        options = next
        running = true
        generation += 1
        error = null
        setStateLocked("starting")
        val socket = ServerSocket()
        socket.reuseAddress = true
        // Phone on both networks (server mode): watchers reach the host on the primary Wi-Fi while
        // the datalink stays on the camera's local-only network. Listen on the primary network's
        // address only; otherwise on every interface (the camera Wi-Fi is the process network).
        val relayNet = PocketServerNetworks.relayNetwork()
        val relayAddress = relayNet?.let { relayIpv4(it) }
        socket.bind(InetSocketAddress(relayAddress, 0))
        relayNetwork = if (relayAddress != null) relayNet else null
        server = socket
        val gen = generation
        Thread({ acceptLoop(socket, gen) }, "pocket.relay.accept").apply { isDaemon = true }.start()
        PocketVideoSinkRegistry.addTap(next.cameraSessionId, this)
        register(next, socket.localPort, gen)
        done(null)
      } catch (t: Throwable) {
        error = t.message ?: "Sharing could not start"
        setStateLocked("failed")
        stopLocked(null)
        done(t)
      }
    }
  }

  fun stop(reason: String?) {
    exec.execute { stopLocked(reason) }
  }

  fun update(passcode: String, allowsControl: Boolean, window: Int) {
    exec.execute {
      val o = options ?: return@execute
      options = Options(o.cameraSessionId, o.hostName, o.cameraName, passcode.trim(), allowsControl, window.coerceIn(1, 8))
      if (!allowsControl) pending = null
      publishStatusLocked()
      for (peer in peers.values) pump(peer)
    }
  }

  fun publishState(json: String) {
    val bytes = json.toByteArray(Charsets.UTF_8)
    val rec = runCatching { JSONObject(json).optBoolean("isRecording", false) }.getOrDefault(false)
    exec.execute {
      if (!running) return@execute
      latestState = bytes
      recording = rec
      for (peer in peers.values) if (peer.authorized && !peer.closing) sendState(peer, bytes)
      logMetricsLocked()
    }
  }

  fun grantControl() = exec.execute {
    val p = pending ?: return@execute
    pending = null
    holder = if (peers[p.id] === p && p.authorized && !p.watcherId.isNullOrBlank()) p else null
    parkedId = null
    broadcastTokens()
    publishStatusLocked()
  }

  fun denyControl() = exec.execute {
    pending = null
    publishStatusLocked()
  }

  fun reclaimControl() = exec.execute {
    holder = null
    parkedId = null
    broadcastTokens()
    publishStatusLocked()
  }

  fun shutdown() {
    exec.execute { stopLocked(null) }
    exec.shutdown()
  }

  private fun stopLocked(reason: String?) {
    val o = options
    if (o != null) PocketVideoSinkRegistry.removeTap(o.cameraSessionId, this)
    registration?.let { l -> runCatching { nsd()?.unregisterService(l) } }
    registration = null
    runCatching { server?.close() }
    server = null
    for (peer in peers.values.toList()) {
      if (reason != null && peer.authorized) closeWithDenial(peer, reason, false) else dropLocked(peer)
    }
    holder = null
    pending = null
    parkedId = null
    latestState = null
    clearGopLocked()
    joinable = false
    if (running) {
      running = false
      generation += 1
      if (state != "failed") setStateLocked("stopped")
    }
    options = null
  }

  private fun nsd(): NsdManager? = context.getSystemService(Context.NSD_SERVICE) as? NsdManager

  /** The network the listener is bound to (server mode, phone on both networks), else null. */
  private var relayNetwork: Network? = null

  private fun relayIpv4(network: Network): InetAddress? {
    val cm = context.getSystemService(ConnectivityManager::class.java) ?: return null
    return cm.getLinkProperties(network)?.linkAddresses?.map { it.address }?.firstOrNull { it is Inet4Address }
  }

  private fun register(o: Options, port: Int, gen: Int) {
    val manager = nsd() ?: throw IOException("Network service discovery is unavailable")
    val info = NsdServiceInfo().apply {
      serviceName = o.hostName.ifBlank { "Pocket Monitor" }
      serviceType = RelayWire.SERVICE_TYPE
      this.port = port
      setAttribute(RelayWire.TXT_CAMERA, o.cameraName)
      setAttribute(RelayWire.TXT_WATCHABLE, "1")
      // Advertise only where the listener is (Android 14+; older releases advertise everywhere).
      val net = relayNetwork
      if (net != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) network = net
    }
    val l = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {
        exec.execute {
          if (generation != gen) return@execute
          advertisedName = serviceInfo.serviceName ?: info.serviceName
          setStateLocked("advertising")
        }
      }

      override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
        exec.execute {
          if (generation != gen) return@execute
          error = "Could not advertise the feed ($errorCode)"
          setStateLocked("failed")
          stopLocked(null)
        }
      }

      override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {}
      override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}
    }
    registration = l
    manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, l)
  }

  // ───────────────────────────── Sockets ─────────────────────────────

  private fun acceptLoop(socket: ServerSocket, gen: Int) {
    while (!socket.isClosed) {
      val client = try {
        socket.accept()
      } catch (_: IOException) {
        break
      }
      client.tcpNoDelay = true
      client.keepAlive = true
      exec.execute {
        if (generation != gen || !running || peers.size >= MAX_PEERS) {
          runCatching { client.close() }
          return@execute
        }
        val peer = try {
          Peer(nextPeer++, client, gen)
        } catch (_: IOException) {
          runCatching { client.close() }
          return@execute
        }
        peers[peer.id] = peer
        Thread({ readLoop(peer) }, "pocket.relay.read.${peer.id}").apply { isDaemon = true }.start()
        // An unauthenticated peer that never says hello is dropped.
        exec.schedule({ if (peers[peer.id] === peer && !peer.authorized && !peer.closing) dropLocked(peer) }, 15, TimeUnit.SECONDS)
      }
    }
  }

  private fun readLoop(peer: Peer) {
    try {
      val input = DataInputStream(peer.socket.getInputStream().buffered(16 * 1024))
      while (true) {
        val message = RelayWire.read(input, RelayWire.MAX_WATCHER_PAYLOAD)
        exec.execute { if (peers[peer.id] === peer && !peer.closing) handle(peer, message) }
      }
    } catch (_: Throwable) {
      exec.execute { if (peers[peer.id] === peer && !peer.closing) dropLocked(peer) }
    }
  }

  private fun write(peer: Peer, parts: List<ByteArray>, done: (() -> kotlin.Unit)?) {
    try {
      peer.writer.execute {
        try {
          for (p in parts) peer.out.write(p)
          peer.out.flush()
        } catch (_: IOException) {
          exec.execute { if (peers[peer.id] === peer) dropLocked(peer) }
          return@execute
        }
        if (done != null) exec.execute { if (peers[peer.id] === peer) done() }
      }
    } catch (_: Throwable) {
      // Writer already shut down: the peer is gone.
    }
  }

  private fun dropLocked(peer: Peer) {
    if (peers.remove(peer.id) !== peer) return
    peer.closing = true
    runCatching { peer.socket.close() }
    peer.writer.shutdownNow()
    if (pending === peer) pending = null
    if (holder === peer) {
      holder = null
      val id = peer.watcherId
      if (!id.isNullOrBlank()) {
        parkedId = id
        parkedName = peer.name
        parkedUntil = RelayWire.now() + PARK_SECONDS
      }
    }
    broadcastTokens()
    publishStatusLocked()
  }

  private fun closeWithDenial(peer: Peer, reason: String, passcodeRequired: Boolean) {
    if (peer.closing) return
    peer.closing = true
    val finish = { if (peers[peer.id] === peer) { peer.closing = false; dropLocked(peer) } }
    write(peer, listOf(RelayWire.message(RelayWire.DENIED, RelayWire.denied(reason, passcodeRequired))), finish)
    exec.schedule({ finish() }, CLOSE_SECONDS, TimeUnit.SECONDS)
  }

  // ───────────────────────────── Messages ─────────────────────────────

  private fun handle(peer: Peer, message: RelayWire.Message) {
    val o = options ?: return
    when (message.kind) {
      RelayWire.HELLO -> {
        if (peer.authorized) return
        val hello = runCatching { JSONObject(String(message.payload, Charsets.UTF_8)) }.getOrNull()
        if (hello == null || !hello.has("version") || !hello.has("hostName")) {
          dropLocked(peer)
          return
        }
        if (hello.optInt("version", -1) != RelayWire.VERSION) {
          closeWithDenial(peer, RelayWire.VERSION_MISMATCH, false)
          return
        }
        val need = o.passcode.trim()
        val given = if (hello.has("passcode") && !hello.isNull("passcode")) hello.optString("passcode") else null
        if (need.isNotEmpty() && given != need) {
          Log.i(TAG, "relay host: passcode refused")
          closeWithDenial(peer, RelayWire.WRONG_PASSCODE, true)
          return
        }
        peer.authorized = true
        peer.name = hello.optString("hostName", "Watcher").ifBlank { "Watcher" }
        peer.watcherId = if (hello.has("watcherID") && !hello.isNull("watcherID")) hello.optString("watcherID").trim().ifEmpty { null } else null
        write(peer, listOf(RelayWire.message(RelayWire.HELLO, RelayWire.hello(advertisedName.ifEmpty { o.hostName }, o.cameraName))), null)
        latestState?.let { sendState(peer, it) }
        val now = RelayWire.now()
        val restored = parkedId != null && parkedId == peer.watcherId && now < parkedUntil
        if (restored) {
          holder = peer
          parkedId = null
          broadcastTokens()
        } else {
          sendToken(peer)
        }
        peer.cursor = if (joinable && gop.isNotEmpty()) gop.first().index else -1
        pump(peer)
        Log.i(TAG, "relay host: watcher joined (${peers.values.count { it.authorized }})")
        publishStatusLocked()
      }
      RelayWire.REQUEST_CONTROL -> {
        if (!peer.authorized || !o.allowsControl || holder === peer || pending != null) return
        pending = peer
        publishStatusLocked()
      }
      RelayWire.RELEASE_CONTROL -> {
        if (holder !== peer) return
        holder = null
        broadcastTokens()
        publishStatusLocked()
      }
      RelayWire.COMMAND -> {
        if (holder !== peer || !peer.authorized) return
        listener.hostCommand(String(message.payload, Charsets.UTF_8), peer.watcherId ?: "")
      }
      else -> {}
    }
  }

  private fun sendToken(peer: Peer) {
    if (!peer.authorized || peer.closing) return
    val h = holder
    write(peer, listOf(RelayWire.message(RelayWire.TOKEN, RelayWire.token(h?.name ?: "Host", h === peer))), null)
  }

  private fun broadcastTokens() {
    for (peer in peers.values) sendToken(peer)
  }

  private fun sendState(peer: Peer, bytes: ByteArray) {
    if (peer.stateInFlight) {
      peer.pendingState = bytes
      return
    }
    peer.stateInFlight = true
    write(peer, listOf(RelayWire.message(RelayWire.STATE, bytes))) {
      peer.stateInFlight = false
      val next = peer.pendingState
      peer.pendingState = null
      if (next != null && peer.authorized && !peer.closing) sendState(peer, next)
    }
  }

  // ───────────────────────────── Video (tap) ─────────────────────────────

  override fun receive(accessUnit: ByteArray, codec: PocketVideoCodec, presentationTimeUs: Long) {
    val at = RelayWire.now()
    exec.execute { if (running) ingest(accessUnit, codec, at) }
  }

  override fun reset() {
    exec.execute {
      clearGopLocked()
      if (joinable) {
        joinable = false
        publishStatusLocked()
      }
      for (peer in peers.values) peer.cursor = -1
    }
  }

  private fun clearGopLocked() {
    gop.clear()
    gopBytes = 0
  }

  private fun ingest(au: ByteArray, codec: PocketVideoCodec, at: Double) {
    val c = RelayWire.classify(au, codec)
    if (c.hasParameterSets) parameterSets = c.parameterSets
    val unit: Unit
    if (c.keyframe) {
      val data = if (!c.hasParameterSets && parameterSets.isNotEmpty()) RelayWire.prefixed(parameterSets, au) else au
      clearGopLocked()
      unit = Unit(nextIndex++, data, codec, true, parameterSets.ifEmpty { null }, at)
      keys += 1
      val wasJoinable = joinable
      joinable = true
      for (peer in peers.values) if (peer.authorized) peer.cursor = unit.index
      if (!wasJoinable) publishStatusLocked()
    } else {
      // Nothing to decode from until the first keyframe.
      if (gop.isEmpty()) return
      unit = Unit(nextIndex++, au, codec, false, null, at)
    }
    gop.addLast(unit)
    gopBytes += unit.au.size
    if (joinable && (gopBytes > GOP_BYTES || gop.size > GOP_UNITS)) {
      joinable = false
      publishStatusLocked()
    }
    if (!joinable) trimGopLocked()
    for (peer in peers.values) pump(peer)
  }

  /** Past the bound only frames a watcher still needs are kept; a watcher too far behind waits for a keyframe. */
  private fun trimGopLocked() {
    val active = peers.values.filter { it.authorized && it.cursor >= 0 }
    if (gopBytes > GOP_BYTES * 2) {
      val keepFrom = gop.last().index - TAIL_UNITS
      for (peer in active) if (peer.cursor < keepFrom) {
        peer.cursor = -1
        skipped += 1
      }
    }
    val min = peers.values.filter { it.authorized && it.cursor >= 0 }.minOfOrNull { it.cursor } ?: (gop.last().index)
    while (gop.size > 1 && gop.first().index < min) gopBytes -= gop.removeFirst().au.size
  }

  private fun unitAt(index: Long): Unit? {
    val first = gop.firstOrNull() ?: return null
    val offset = index - first.index
    return if (offset >= 0 && offset < gop.size) gop[offset.toInt()] else null
  }

  private fun pump(peer: Peer) {
    val o = options ?: return
    if (!peer.authorized || peer.closing) return
    while (peer.cursor >= 0 && peer.inFlight < o.window) {
      val unit = unitAt(peer.cursor) ?: break
      val behind = (nextIndex - 1 - unit.index) > o.window
      val head = RelayWire.frameHead(unit.codec, unit.key, unit.sets, recording, false, unit.at, behind, unit.au.size)
      peer.cursor += 1
      peer.inFlight += 1
      sent += 1
      write(peer, listOf(head, unit.au)) {
        peer.inFlight = maxOf(0, peer.inFlight - 1)
        pump(peer)
      }
    }
  }

  // ───────────────────────────── Status ─────────────────────────────

  private fun setStateLocked(next: String) {
    state = next
    publishStatusLocked()
  }

  private fun publishStatusLocked() {
    val p = pending
    val status = mapOf(
      "state" to state,
      "error" to error,
      "watchers" to peers.values.count { it.authorized && !it.closing },
      "pending" to p?.let { mapOf("name" to it.name, "watcherId" to (it.watcherId ?: "")) },
      "holder" to (holder?.name ?: "Host"),
      "joinable" to joinable,
      "watcherNames" to peers.values.filter { it.authorized && !it.closing }.map { it.name },
    )
    if (status == lastStatus) return
    lastStatus = status
    listener.hostStatus(status)
  }

  /** Console counters every five seconds; no peer names or codes. */
  private fun logMetricsLocked() {
    val now = RelayWire.now()
    if (now - metricsAt < 5) return
    val seconds = now - metricsAt
    metricsAt = now
    Log.i(TAG, "relay: peers=${peers.values.count { it.authorized }} sent=$sent skipped=$skipped keys=$keys gop=${gop.size}/${gopBytes / 1024}KiB over ${"%.0f".format(seconds)}s")
    sent = 0
    skipped = 0
    keys = 0
  }

  companion object {
    private const val TAG = "PocketRelay"
    private const val MAX_PEERS = 16
    private const val PARK_SECONDS = 20.0
    private const val CLOSE_SECONDS = 3L
    /** The GOP a joiner can start from. Past this the host waits for the camera's next keyframe. */
    private const val GOP_BYTES = 48L * 1024 * 1024
    private const val GOP_UNITS = 3000
    /** Frames kept behind live for watchers that are mid catch-up once the GOP is past its bound. */
    private const val TAIL_UNITS = 120L
  }
}
