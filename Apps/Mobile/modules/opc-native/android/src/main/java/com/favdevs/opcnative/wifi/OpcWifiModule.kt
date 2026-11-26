package com.favdevs.opcnative.wifi

import io.github.expo.modules.v2.ExpoModule
import io.github.expo.modules.v2.JS
import io.github.expo.modules.v2.Module
import io.github.expo.modules.v2.react.androidContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * JS module `OpcWifi` (`src/types.ts` `OpcWifiNativeModule`).
 *
 * Android has no join-once: a [android.net.wifi.WifiNetworkSpecifier] network lives exactly as long
 * as this app holds its request, so `joinOnce` is accepted and ignored. Reading the SSID of other
 * networks needs location permission (requested by the app, never by this library).
 */
@ExpoModule("OpcWifi")
class OpcWifiModule : Module() {
  @Volatile
  private var created: OpcWifiJoiner? = null

  private val joiner: OpcWifiJoiner
    get() = created ?: synchronized(this) { created ?: OpcWifiJoiner(androidContext).also { created = it } }

  @JS
  suspend fun join(ssid: String, password: String, options: Map<String, Any?>): Map<String, Any?> {
    val timeoutMs = ((options["timeoutMs"] as? Number)?.toDouble() ?: 20_000.0).toInt().coerceIn(1_000, 120_000)
    return joiner.join(ssid, password, timeoutMs).toMap()
  }

  @JS
  suspend fun leave(@Suppress("UNUSED_PARAMETER") ssid: String): Unit = withContext(Dispatchers.Main) {
    joiner.release()
  }

  @JS
  suspend fun currentSsid(): String? = withContext(Dispatchers.IO) { joiner.currentSsid() }

  @JS
  suspend fun localAddress(): String? = withContext(Dispatchers.IO) { joiner.localAddress() }

  override fun onDestroy() {
    created?.release()
  }
}
