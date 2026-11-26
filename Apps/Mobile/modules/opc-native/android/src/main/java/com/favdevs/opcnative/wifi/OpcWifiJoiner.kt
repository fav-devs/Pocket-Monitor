package com.favdevs.opcnative.wifi

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
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Port of upstream `CameraApJoiner` (Android/platform): [WifiNetworkSpecifier] +
 * [ConnectivityManager.requestNetwork] + [ConnectivityManager.bindProcessToNetwork], so camera
 * sockets route over a network without internet. The callback stays registered while the session
 * lives (unregistering tears the peer-to-peer network down); [release] unbinds and unregisters.
 *
 * Mid-session `onLost` is often a Network-object replace: the process binding is kept for an 8 s
 * reassociation grace before the path counts as lost.
 */
class OpcWifiJoiner(context: Context) {
  data class Result(val joined: Boolean, val outcome: String, val message: String? = null) {
    fun toMap(): Map<String, Any?> = mapOf("joined" to joined, "outcome" to outcome, "message" to message)
  }

  private val appContext = context.applicationContext
  private val connectivity = appContext.getSystemService(ConnectivityManager::class.java)
  private val wifi = appContext.getSystemService(WifiManager::class.java)
  private val main = Handler(Looper.getMainLooper())
  private val lock = Any()
  private var callback: ConnectivityManager.NetworkCallback? = null
  private var grace: Runnable? = null
  private var generation = 0L

  /** SSID this joiner requested; Android redacts SSIDs of specifier networks without location. */
  @Volatile
  var joinedSsid: String? = null
    private set

  suspend fun join(ssid: String, password: String, timeoutMs: Int): Result {
    val target = ssid.trim()
    if (target.isEmpty()) return Result(false, "not-found", "empty SSID")
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      return Result(false, "failed", "joining a camera network needs Android 10 or newer")
    }
    val cm = connectivity ?: return Result(false, "failed", "ConnectivityManager unavailable")
    if (wifi?.isWifiEnabled == false) return Result(false, "failed", "Wi-Fi is off")

    // Our own request already holds this network.
    if (joinedSsid == target && OpcCameraNetwork.network != null && OpcCameraNetwork.isProcessBound) {
      return Result(true, "already-associated")
    }
    adoptAlreadyJoined(target)?.let { return it }

    release()
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
      fun finish(result: Result) {
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
          if (!cm.bindProcessToNetwork(network)) {
            Log.w(TAG, "wifi: process bind rejected")
            release()
            finish(Result(false, "failed", "Android refused to bind the app to the camera network"))
            return
          }
          val replaced = OpcCameraNetwork.isProcessBound && OpcCameraNetwork.network == null
          joinedSsid = target
          OpcCameraNetwork.publish(
            if (replaced) OpcCameraNetwork.Change.REPLACED else OpcCameraNetwork.Change.AVAILABLE, network, true)
          Log.i(TAG, "wifi: available $network replaced=$replaced")
          finish(Result(true, "joined"))
        }

        override fun onUnavailable() {
          if (!isCurrent(myGeneration, this)) return
          release()
          // Android reports a user cancel, a missing network and the request timeout the same way.
          val elapsed = SystemClock.elapsedRealtime() - startedAt
          val outcome = when {
            elapsed >= timeoutMs * 0.9 -> "timeout"
            scanSees(target) == false -> "not-found"
            else -> "user-denied"
          }
          finish(Result(false, outcome, "Android reported the network unavailable after ${elapsed} ms"))
        }

        override fun onLost(network: Network) {
          if (!isCurrent(myGeneration, this)) return
          if (OpcCameraNetwork.network != network) return
          // Keep the process route during reassociation; sockets must not fall back to home Wi-Fi.
          OpcCameraNetwork.publish(OpcCameraNetwork.Change.LOST_GRACE, null, true)
          scheduleGrace(myGeneration)
        }
      }
      synchronized(lock) { callback = cb }
      // On the main looper: OEMs that attach the system join dialog to the UI thread still show it.
      main.post {
        if (!isCurrent(myGeneration, cb)) return@post
        try {
          cm.requestNetwork(request, cb, main, timeoutMs.coerceAtLeast(1_000))
        } catch (error: RuntimeException) {
          Log.w(TAG, "wifi: request failed ${error.javaClass.simpleName}")
          release()
          finish(Result(false, "failed", "requestNetwork failed: ${error.javaClass.simpleName}"))
        }
      }
      continuation.invokeOnCancellation { release() }
    }
  }

  /**
   * A Wi-Fi network this phone is already on with a camera client address (joined in Settings, or
   * auto-joined): bind the process to it and watch it for loss. When the SSID is readable it must
   * match; Pocket and Nano share `192.168.2.1`, so a readable foreign SSID is not adopted.
   */
  @Suppress("DEPRECATION")
  @SuppressLint("MissingPermission")
  private fun adoptAlreadyJoined(target: String): Result? {
    val cm = connectivity ?: return null
    val network = cm.allNetworks.firstOrNull { candidate ->
      val caps = cm.getNetworkCapabilities(candidate) ?: return@firstOrNull false
      caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
        OpcCameraNetwork.ipv4(cm, candidate).any(OpcCameraNetwork::isCameraClientIPv4) &&
        ssidOf(caps).let { it == null || it == target }
    } ?: return null
    release()
    val myGeneration = synchronized(lock) { ++generation }
    if (!cm.bindProcessToNetwork(network)) return null
    val watch = object : ConnectivityManager.NetworkCallback() {
      override fun onLost(lost: Network) {
        if (!isCurrent(myGeneration, this) || lost != OpcCameraNetwork.network) return
        OpcCameraNetwork.publish(OpcCameraNetwork.Change.LOST_GRACE, null, true)
        scheduleGrace(myGeneration)
      }

      override fun onAvailable(available: Network) {
        if (!isCurrent(myGeneration, this) || OpcCameraNetwork.network != null) return
        if (!OpcCameraNetwork.ipv4(cm, available).any(OpcCameraNetwork::isCameraClientIPv4)) return
        cancelGrace()
        if (cm.bindProcessToNetwork(available)) {
          OpcCameraNetwork.publish(OpcCameraNetwork.Change.REPLACED, available, true)
        }
      }
    }
    synchronized(lock) { callback = watch }
    runCatching {
      cm.registerNetworkCallback(
        NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), watch, main)
    }
    joinedSsid = target
    OpcCameraNetwork.publish(OpcCameraNetwork.Change.AVAILABLE, network, true)
    Log.i(TAG, "wifi: adopted joined camera network $network")
    return Result(true, "already-associated")
  }

  @Suppress("DEPRECATION")
  @SuppressLint("MissingPermission")
  private fun ssidOf(caps: NetworkCapabilities?): String? {
    val info: WifiInfo? =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) caps?.transportInfo as? WifiInfo
      else runCatching { wifi?.connectionInfo }.getOrNull()
    return info?.ssid?.trim()?.removeSurrounding("\"")?.takeUnless { it.isEmpty() || it == UNKNOWN_SSID }
  }

  /** `null` when scan results cannot be read (no location permission); then we cannot tell. */
  @SuppressLint("MissingPermission")
  private fun scanSees(ssid: String): Boolean? {
    val results = try {
      wifi?.scanResults
    } catch (_: SecurityException) {
      null
    } ?: return null
    if (results.isEmpty()) return null
    @Suppress("DEPRECATION")
    return results.any { it.SSID?.trim()?.removeSurrounding("\"") == ssid }
  }

  private fun isCurrent(gen: Long, cb: ConnectivityManager.NetworkCallback): Boolean =
    synchronized(lock) { generation == gen && callback === cb }

  private fun scheduleGrace(gen: Long) {
    cancelGrace()
    val r = Runnable {
      synchronized(lock) { if (generation != gen) return@Runnable }
      if (OpcCameraNetwork.network == null) {
        Log.i(TAG, "wifi: camera network lost after reassociation grace")
        connectivity?.bindProcessToNetwork(null)
        OpcCameraNetwork.publish(OpcCameraNetwork.Change.LOST, null, false)
      }
    }
    synchronized(lock) { grace = r }
    main.postDelayed(r, REASSOCIATION_GRACE_MS)
  }

  private fun cancelGrace() {
    val r = synchronized(lock) { grace.also { grace = null } } ?: return
    main.removeCallbacks(r)
  }

  /** Drops the camera network: unbinds the process and unregisters the request. Safe twice. */
  fun release() {
    val toUnregister = synchronized(lock) {
      generation += 1
      callback.also { callback = null }
    }
    cancelGrace()
    val wasBound = OpcCameraNetwork.isProcessBound || OpcCameraNetwork.network != null
    if (wasBound || toUnregister != null) connectivity?.bindProcessToNetwork(null)
    toUnregister?.let { cb -> runCatching { connectivity?.unregisterNetworkCallback(cb) } }
    joinedSsid = null
    if (wasBound) OpcCameraNetwork.publish(OpcCameraNetwork.Change.LOST, null, false)
  }

  fun currentSsid(): String? {
    val cm = connectivity ?: return null
    val bound = OpcCameraNetwork.network
    if (bound != null && joinedSsid != null) return joinedSsid
    val active = bound ?: cm.activeNetwork
    return ssidOf(active?.let { cm.getNetworkCapabilities(it) })
  }

  fun localAddress(): String? {
    val cm = connectivity ?: return null
    val bound = OpcCameraNetwork.network ?: cm.boundNetworkForProcess
    val addresses = OpcCameraNetwork.ipv4(cm, bound)
    return addresses.firstOrNull(OpcCameraNetwork::isCameraClientIPv4) ?: addresses.firstOrNull()
  }

  companion object {
    private const val TAG = "OpcWifi"
    const val REASSOCIATION_GRACE_MS = 8_000L
    private const val UNKNOWN_SSID = "<unknown ssid>"
  }
}
