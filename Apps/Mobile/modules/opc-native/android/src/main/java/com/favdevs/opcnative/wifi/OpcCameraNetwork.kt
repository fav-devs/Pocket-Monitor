package com.favdevs.opcnative.wifi

import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The camera Wi-Fi [Network] that [OpcWifiModule] joined (WifiNetworkSpecifier) or adopted, shared
 * with the datalink so its sockets bind to the SoftAP even though it carries no internet.
 *
 * [network] is null while Android replaces the Network object (`onLost` → `onAvailable`). The
 * process binding is kept through that reassociation grace ([isProcessBound] stays true) so
 * sockets cannot leak onto home Wi-Fi meanwhile (docs/live-session.md, "Foreground / SoftAP flap").
 */
object OpcCameraNetwork {
  enum class Change { AVAILABLE, REPLACED, LOST_GRACE, LOST }

  @Volatile
  var network: Network? = null
    private set

  @Volatile
  var isProcessBound: Boolean = false
    private set

  private val listeners = CopyOnWriteArrayList<(Change, Network?) -> Unit>()

  fun addListener(listener: (Change, Network?) -> Unit) {
    listeners.add(listener)
  }

  fun removeListener(listener: (Change, Network?) -> Unit) {
    listeners.remove(listener)
  }

  internal fun publish(change: Change, next: Network?, processBound: Boolean) {
    network = next
    isProcessBound = processBound
    for (l in listeners) runCatching { l(change, next) }
  }

  /** Binds [socket] to the camera network when one is known; otherwise the process binding routes it. */
  fun bindSocket(socket: DatagramSocket): Boolean {
    val n = network ?: return false
    return runCatching { n.bindSocket(socket) }
      .onFailure { Log.w(TAG, "UDP bindSocket failed: ${it.javaClass.simpleName}") }
      .isSuccess
  }

  fun bindSocket(socket: Socket): Boolean {
    val n = network ?: return false
    return runCatching { n.bindSocket(socket) }
      .onFailure { Log.w(TAG, "TCP bindSocket failed: ${it.javaClass.simpleName}") }
      .isSuccess
  }

  fun ipv4(connectivity: ConnectivityManager, network: Network?): List<String> {
    val n = network ?: return emptyList()
    return connectivity.getLinkProperties(n)?.linkAddresses.orEmpty()
      .mapNotNull { (it.address as? Inet4Address)?.hostAddress }
  }

  /** Phone address on the camera AP: `192.168.2.2…254` (`.1` is the camera). */
  fun isCameraClientIPv4(ip: String): Boolean {
    val parts = ip.split(".")
    if (parts.size != 4 || parts[0] != "192" || parts[1] != "168" || parts[2] != "2") return false
    val host = parts[3].toIntOrNull() ?: return false
    return host in 2..254
  }

  private const val TAG = "OpcCameraNetwork"
}
