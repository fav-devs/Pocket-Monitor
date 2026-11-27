package com.favdevs.pocketnative.background

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.favdevs.pocketnative.wifi.PocketCameraNetwork
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Networks for server mode.
 *
 * **Primary**: the phone's internet Wi-Fi (home / venue). Watchers reach the relay there. In the
 * "phone on both networks" setup the relay must listen on this network while the datalink is
 * bound to the camera SoftAP; [relayNetwork] is what the relay host should bind / advertise on
 * (`Network.bindSocket` for sockets, `NsdServiceInfo.setNetwork` on API 33+). Null = default
 * routing (the camera and watchers share one network, or the phone's hotspot).
 *
 * **Local-only camera link** (Wi-Fi STA/STA concurrency for local-only connections, API 31+ and
 * `WifiManager.isStaConcurrencyForLocalOnlyConnectionsSupported()`): a [WifiNetworkSpecifier]
 * request is served on a second station interface while the primary Wi-Fi stays connected. Unlike
 * `PocketWifi.join` this never calls `bindProcessToNetwork` (that would drag the relay listener and
 * every other socket onto the camera AP); the camera [Network] is published to
 * [PocketCameraNetwork] with `processBound = false`, so the datalink binds its UDP / TCP sockets to
 * it explicitly. Loss handling mirrors `PocketWifiJoiner`: 8 s reassociation grace, then LOST.
 */
object PocketServerNetworks {
  data class JoinResult(val joined: Boolean, val outcome: String, val message: String? = null) {
    fun toMap(): Map<String, Any?> = mapOf("joined" to joined, "outcome" to outcome, "message" to message)
  }

  private const val TAG = "PocketServerNet"
  private const val GRACE_MS = 8_000L
  private val main = Handler(Looper.getMainLooper())
  private val lock = Any()
  private var callback: ConnectivityManager.NetworkCallback? = null
  private var primaryCallback: ConnectivityManager.NetworkCallback? = null
  private var grace: Runnable? = null
  private var generation = 0L
  @Volatile private var localOnly: Network? = null
  @Volatile private var localOnlySsid: String? = null

  /** The primary (internet) Wi-Fi network while it is up; tracked while serving. */
  @Volatile
  var primary: Network? = null
    private set

  /** Where the relay host should listen: the primary Wi-Fi when the camera is on a local-only link. */
  fun relayNetwork(): Network? = if (localOnly != null) primary else null

  fun staConcurrencySupported(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
    val wifi = context.applicationContext.getSystemService(WifiManager::class.java) ?: return false
    return runCatching { wifi.isStaConcurrencyForLocalOnlyConnectionsSupported }.getOrDefault(false)
  }

  // ─── primary network ───

  /** Track the default Wi-Fi network (registered while serving). */
  fun trackPrimary(context: Context) {
    val cm = context.applicationContext.getSystemService(ConnectivityManager::class.java) ?: return
    synchronized(lock) { if (primaryCallback != null) return }
    primary = cm.activeNetwork?.takeIf { isWifi(cm, it) }
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        primary = network.takeIf { isWifi(cm, it) }
      }

      override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
        primary = network.takeIf { caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) }
      }

      override fun onLost(network: Network) {
        if (primary == network) primary = null
      }
    }
    synchronized(lock) { primaryCallback = cb }
    runCatching { cm.registerDefaultNetworkCallback(cb, main) }
      .onFailure { Log.w(TAG, "primary: register failed ${it.javaClass.simpleName}") }
  }

  fun untrackPrimary(context: Context) {
    val cm = context.applicationContext.getSystemService(ConnectivityManager::class.java) ?: return
    val cb = synchronized(lock) { primaryCallback.also { primaryCallback = null } } ?: return
    runCatching { cm.unregisterNetworkCallback(cb) }
  }

  /** SSID and IPv4 of the phone's current Wi-Fi (primary), for the Server screen. */
  @SuppressLint("MissingPermission")
  fun primaryInfo(context: Context): Map<String, Any?>? {
    val cm = context.applicationContext.getSystemService(ConnectivityManager::class.java) ?: return null
    val net = primary ?: cm.activeNetwork?.takeIf { isWifi(cm, it) } ?: return null
    val caps = cm.getNetworkCapabilities(net)
    val link = cm.getLinkProperties(net)
    val ipv4 = link?.linkAddresses?.firstOrNull { it.address is Inet4Address }
    return mapOf(
      "ssid" to ssidOf(context, caps),
      "address" to ipv4?.address?.hostAddress,
      "prefixLength" to ipv4?.prefixLength,
      "internet" to (caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true),
    )
  }

  // ─── local-only camera link ───

  suspend fun joinLocalOnly(context: Context, ssid: String, password: String, timeoutMs: Int): JoinResult {
    val target = ssid.trim()
    if (target.isEmpty()) return JoinResult(false, "not-found", "empty SSID")
    if (!staConcurrencySupported(context)) return JoinResult(false, "failed", "this phone cannot stay on two Wi-Fi networks")
    val cm = context.applicationContext.getSystemService(ConnectivityManager::class.java)
      ?: return JoinResult(false, "failed", "ConnectivityManager unavailable")
    if (localOnlySsid == target && localOnly != null) return JoinResult(true, "already-associated")
    releaseLocalOnly(context)
    val myGeneration = synchronized(lock) { ++generation }
    val specifier = WifiNetworkSpecifier.Builder()
      .setSsid(target)
      .apply { if (password.isNotEmpty()) setWpa2Passphrase(password) }
      .build()
    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .setNetworkSpecifier(specifier)
      .build()
    val startedAt = SystemClock.elapsedRealtime()
    return suspendCancellableCoroutine { continuation ->
      var resumed = false
      fun finish(result: JoinResult) {
        synchronized(lock) {
          if (resumed) return
          resumed = true
        }
        if (continuation.isActive) continuation.resume(result)
      }
      val cb = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
          if (!isCurrent(myGeneration, this)) return
          cancelGrace()
          val replaced = localOnlySsid == target && localOnly == null && PocketCameraNetwork.network == null
          localOnly = network
          localOnlySsid = target
          PocketCameraNetwork.publish(
            if (replaced) PocketCameraNetwork.Change.REPLACED else PocketCameraNetwork.Change.AVAILABLE, network, false)
          Log.i(TAG, "local-only: available $network replaced=$replaced (process not bound)")
          finish(JoinResult(true, "joined"))
        }

        override fun onUnavailable() {
          if (!isCurrent(myGeneration, this)) return
          releaseLocalOnly(context)
          val elapsed = SystemClock.elapsedRealtime() - startedAt
          finish(JoinResult(false, if (elapsed >= timeoutMs * 0.9) "timeout" else "user-denied",
            "Android reported the network unavailable after $elapsed ms"))
        }

        override fun onLost(network: Network) {
          if (!isCurrent(myGeneration, this) || localOnly != network) return
          localOnly = null
          PocketCameraNetwork.publish(PocketCameraNetwork.Change.LOST_GRACE, null, false)
          scheduleGrace(myGeneration)
        }
      }
      synchronized(lock) { callback = cb }
      main.post {
        if (!isCurrent(myGeneration, cb)) return@post
        try {
          cm.requestNetwork(request, cb, main, timeoutMs.coerceAtLeast(1_000))
        } catch (error: RuntimeException) {
          releaseLocalOnly(context)
          finish(JoinResult(false, "failed", "requestNetwork failed: ${error.javaClass.simpleName}"))
        }
      }
      continuation.invokeOnCancellation { releaseLocalOnly(context) }
    }
  }

  fun releaseLocalOnly(context: Context) {
    val cm = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    val cb = synchronized(lock) {
      generation += 1
      callback.also { callback = null }
    }
    cancelGrace()
    val had = localOnly != null || localOnlySsid != null
    localOnly = null
    localOnlySsid = null
    cb?.let { runCatching { cm?.unregisterNetworkCallback(it) } }
    if (had && !PocketCameraNetwork.isProcessBound) PocketCameraNetwork.publish(PocketCameraNetwork.Change.LOST, null, false)
  }

  fun localOnlyAddress(context: Context): String? {
    val cm = context.applicationContext.getSystemService(ConnectivityManager::class.java) ?: return null
    val addresses = PocketCameraNetwork.ipv4(cm, localOnly)
    return addresses.firstOrNull(PocketCameraNetwork::isCameraClientIPv4) ?: addresses.firstOrNull()
  }

  private fun isCurrent(gen: Long, cb: ConnectivityManager.NetworkCallback) =
    synchronized(lock) { generation == gen && callback === cb }

  private fun scheduleGrace(gen: Long) {
    cancelGrace()
    val r = Runnable {
      synchronized(lock) { if (generation != gen) return@Runnable }
      if (localOnly == null) {
        Log.i(TAG, "local-only: camera network lost after reassociation grace")
        PocketCameraNetwork.publish(PocketCameraNetwork.Change.LOST, null, false)
      }
    }
    synchronized(lock) { grace = r }
    main.postDelayed(r, GRACE_MS)
  }

  private fun cancelGrace() {
    val r = synchronized(lock) { grace.also { grace = null } } ?: return
    main.removeCallbacks(r)
  }

  // ─── camera discovery on the phone's networks ───

  /**
   * Hosts on the phone's own Wi-Fi and hotspot subnets that accept a TCP connection on [port]
   * (the Pocket's 7001 poke port), like the desktop's `lan::probe_hosts`. Cellular, VPN and
   * loopback interfaces are skipped; subnets wider than /24 are walked only around the phone's
   * own /24. The camera is confirmed afterwards by the session (UDP handshake + Wi-Fi identity).
   */
  fun probeHosts(port: Int, timeoutMs: Int, most: Int): List<String> {
    val hosts = LinkedHashSet<String>()
    for (nif in runCatching { NetworkInterface.getNetworkInterfaces()?.toList().orEmpty() }.getOrDefault(emptyList())) {
      if (!runCatching { nif.isUp && !nif.isLoopback }.getOrDefault(false)) continue
      val name = nif.name.lowercase()
      if (SKIP_PREFIXES.any { name.startsWith(it) }) continue
      for (ia in nif.interfaceAddresses) {
        val a = ia.address as? Inet4Address ?: continue
        if (!a.isSiteLocalAddress) continue
        hosts.addAll(subnetHosts(a, ia.networkPrefixLength.toInt()))
      }
    }
    if (hosts.isEmpty()) return emptyList()
    val pool = Executors.newFixedThreadPool(PROBE_PARALLEL)
    try {
      val futures = hosts.map { host ->
        host to pool.submit(Callable {
          runCatching {
            Socket().use { s -> s.connect(InetSocketAddress(host, port), timeoutMs); true }
          }.getOrDefault(false)
        })
      }
      val found = mutableListOf<String>()
      for ((host, f) in futures) {
        val open = runCatching { f.get(timeoutMs + 2_000L, TimeUnit.MILLISECONDS) }.getOrDefault(false)
        if (open) found.add(host)
        if (found.size >= most) break
      }
      return found
    } finally {
      pool.shutdownNow()
    }
  }

  private val SKIP_PREFIXES = listOf("rmnet", "ccmni", "tun", "ppp", "dummy", "lo", "v4-", "clat", "ipsec", "bond", "p2p")
  private const val PROBE_PARALLEL = 48

  /** Every other host of `address`'s subnet; /24 at most (around the phone's own /24). */
  internal fun subnetHosts(address: Inet4Address, prefix: Int): List<String> {
    val b = address.address
    val ip = ((b[0].toInt() and 0xff) shl 24) or ((b[1].toInt() and 0xff) shl 16) or ((b[2].toInt() and 0xff) shl 8) or (b[3].toInt() and 0xff)
    val bits = prefix.coerceIn(24, 30)
    val mask = if (bits == 0) 0 else (-1 shl (32 - bits))
    val network = ip and mask
    val count = (1 shl (32 - bits)) - 1
    return (1 until count).map { network or it }.filter { it != ip }.map {
      "${(it ushr 24) and 0xff}.${(it ushr 16) and 0xff}.${(it ushr 8) and 0xff}.${it and 0xff}"
    }
  }

  private fun isWifi(cm: ConnectivityManager, n: Network): Boolean =
    cm.getNetworkCapabilities(n)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true

  @Suppress("DEPRECATION")
  @SuppressLint("MissingPermission")
  private fun ssidOf(context: Context, caps: NetworkCapabilities?): String? {
    val info: WifiInfo? =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) caps?.transportInfo as? WifiInfo
      else runCatching { context.applicationContext.getSystemService(WifiManager::class.java)?.connectionInfo }.getOrNull()
    return info?.ssid?.trim()?.removeSurrounding("\"")?.takeUnless { it.isEmpty() || it == "<unknown ssid>" }
  }
}
