package com.favdevs.pocketnative.relay

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import java.net.InetAddress
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Finds sharing hosts with [NsdManager] on both service types (`_pocket-mon._tcp` and the legacy
 * `_opc-mon._tcp`) and resolves them for their TXT (`c` camera, `w` watchable) and endpoint.
 *
 * NSD resolves one service at a time on older releases, so resolves are serialized on [queue].
 * Discovery runs on the active network; the camera Wi-Fi is the process network once PocketWifi
 * joined it, so there is no off-network or peer-to-peer discovery.
 */
class RelayBrowser(private val context: Context, private val listener: Listener) {
  interface Listener {
    fun hostsChanged(hosts: List<Map<String, Any?>>, browsing: Boolean, error: String?)
  }

  class Resolved(val name: String, val type: String, val addresses: List<InetAddress>, val port: Int, val camera: String, val watchable: Boolean)

  private val queue = Executors.newSingleThreadScheduledExecutor { Thread(it, "pocket.relay.nsd") }
  private val nsd: NsdManager? get() = context.getSystemService(Context.NSD_SERVICE) as? NsdManager

  // queue-confined
  private val discoveries = mutableMapOf<String, NsdManager.DiscoveryListener>()
  private val found = linkedMapOf<String, Resolved>()
  private var browsing = false
  private var error: String? = null

  fun start() = queue.execute {
    if (browsing) return@execute
    val manager = nsd
    if (manager == null) {
      error = "Network service discovery is unavailable"
      publish()
      return@execute
    }
    browsing = true
    error = null
    for (type in RelayWire.BROWSE_TYPES) {
      val l = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(serviceType: String) {}
        override fun onDiscoveryStopped(serviceType: String) {}
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
          queue.execute {
            error = "Could not look for shared feeds ($errorCode)"
            publish()
          }
        }
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
        override fun onServiceFound(info: NsdServiceInfo) {
          queue.execute { if (browsing) resolveForList(info.serviceName, type) }
        }
        override fun onServiceLost(info: NsdServiceInfo) {
          queue.execute {
            if (found.remove(key(type, info.serviceName)) != null) publish()
          }
        }
      }
      discoveries[type] = l
      runCatching { manager.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, l) }
        .onFailure { error = "Could not look for shared feeds"; Log.w(TAG, "discoverServices failed", it) }
    }
    publish()
  }

  fun stop() = queue.execute {
    if (!browsing) return@execute
    browsing = false
    for (l in discoveries.values) runCatching { nsd?.stopServiceDiscovery(l) }
    discoveries.clear()
    found.clear()
    publish()
  }

  fun shutdown() {
    stop()
    queue.shutdown()
  }

  private fun key(type: String, name: String) = "$type/$name"

  private fun resolveForList(name: String, type: String) {
    resolve(name, type, 0) { resolved ->
      queue.execute {
        if (!browsing || resolved == null) return@execute
        found[key(type, name)] = resolved
        publish()
      }
    }
  }

  /**
   * Resolves `<type>/<name>` (a host id) to an endpoint. Each join resolves again: a restarted host
   * can listen on a different port. Calls back on an NSD thread; null when it could not resolve.
   */
  fun resolveId(hostId: String, done: (Resolved?) -> Unit) {
    val slash = hostId.indexOf('/')
    if (slash <= 0) return done(null)
    val type = hostId.substring(0, slash)
    val name = hostId.substring(slash + 1)
    queue.execute { resolve(name, type, 0, done) }
  }

  /** Runs on [queue]. One resolve in flight; a busy resolver is retried. */
  private fun resolve(name: String, type: String, attempt: Int, done: (Resolved?) -> Unit) {
    val manager = nsd ?: return done(null)
    val info = NsdServiceInfo().apply {
      serviceName = name
      serviceType = type
    }
    val lock = Object()
    var finished = false
    @Suppress("DEPRECATION")
    val l = object : NsdManager.ResolveListener {
      override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
        synchronized(lock) { finished = true; lock.notifyAll() }
        if (errorCode == NsdManager.FAILURE_ALREADY_ACTIVE && attempt < 6) {
          queue.schedule({ resolve(name, type, attempt + 1, done) }, 250L * (attempt + 1), TimeUnit.MILLISECONDS)
        } else {
          done(null)
        }
      }

      override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
        synchronized(lock) { finished = true; lock.notifyAll() }
        val attrs = serviceInfo.attributes ?: emptyMap()
        val camera = attrs[RelayWire.TXT_CAMERA]?.let { String(it, Charsets.UTF_8) } ?: ""
        val watchable = attrs[RelayWire.TXT_WATCHABLE]?.let { String(it, Charsets.UTF_8) } != "0"
        @Suppress("DEPRECATION")
        val addresses = listOfNotNull(serviceInfo.host)
        done(Resolved(name, type, addresses, serviceInfo.port, camera, watchable))
      }
    }
    try {
      @Suppress("DEPRECATION")
      manager.resolveService(info, l)
    } catch (t: Throwable) {
      Log.w(TAG, "resolveService failed", t)
      return done(null)
    }
    // Keep resolves serial: wait (bounded) for this one before the queue runs the next.
    synchronized(lock) {
      val deadline = System.currentTimeMillis() + 5_000
      while (!finished) {
        val left = deadline - System.currentTimeMillis()
        if (left <= 0) break
        lock.wait(left)
      }
    }
  }

  private fun publish() {
    val hosts = found.values
      .groupBy { it.name }
      // One row per name: our service type wins over the legacy one.
      .map { (_, same) -> same.firstOrNull { it.type == RelayWire.SERVICE_TYPE } ?: same.first() }
      .sortedBy { it.name.lowercase() }
      .map {
        mapOf(
          "id" to key(it.type, it.name),
          "name" to it.name,
          "camera" to it.camera,
          "serviceType" to it.type,
          "watchable" to it.watchable,
        )
      }
    listener.hostsChanged(hosts, browsing, error)
  }

  companion object {
    private const val TAG = "PocketRelay"
  }
}
