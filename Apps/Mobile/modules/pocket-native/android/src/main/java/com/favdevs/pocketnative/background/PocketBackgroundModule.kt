package com.favdevs.pocketnative.background

import android.Manifest
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.v2.legacyAppContextOrNull
import io.github.expo.modules.v2.Event
import io.github.expo.modules.v2.ExpoModule
import io.github.expo.modules.v2.JS
import io.github.expo.modules.v2.JavaScriptThrowable
import io.github.expo.modules.v2.Module
import io.github.expo.modules.v2.react.androidContext
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * JS module `PocketBackground` (`src/types.ts` `PocketBackgroundNativeModule`): server mode.
 *
 * Starts / updates / stops [PocketServerService], forwards its heartbeat (`onTick`) and the
 * notification's actions (`onAction`) to JS, and owns the server's network helpers (local-only
 * camera link, primary Wi-Fi, camera discovery on the phone's subnets). iOS has no equivalent:
 * the JS side checks `Platform.OS` and this module is absent there.
 */
@ExpoModule("PocketBackground")
class PocketBackgroundModule : Module(), PocketServerBus.Listener {
  class ServerStartException(message: String) : JavaScriptThrowable(message) {
    override val code: String get() = "ERR_SERVER_START"
  }

  @Event("onTick")
  val onTick: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Event("onAction")
  val onAction: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Event("onServerState")
  val onServerState: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  init {
    PocketServerBus.listener = this
  }

  @JS
  fun capabilities(): Map<String, Any?> {
    val ctx = androidContext
    val pm = ctx.getSystemService(PowerManager::class.java)
    return mapOf(
      "sdk" to Build.VERSION.SDK_INT,
      "staConcurrencyLocalOnly" to PocketServerNetworks.staConcurrencySupported(ctx),
      "notificationsAllowed" to granted(Manifest.permission.POST_NOTIFICATIONS, Build.VERSION_CODES.TIRAMISU),
      "bluetoothAllowed" to granted(Manifest.permission.BLUETOOTH_CONNECT, Build.VERSION_CODES.S),
      "ignoringBatteryOptimizations" to (pm?.isIgnoringBatteryOptimizations(ctx.packageName) == true),
      "serving" to PocketServerBus.running,
    )
  }

  /**
   * POST_NOTIFICATIONS (13+) for the server notification and BLUETOOTH_CONNECT (12+) for the
   * camera link. Resolves with what is granted; the service starts without notifications too
   * (Android then shows it only in the task manager).
   */
  @JS
  suspend fun requestPermissions(): Map<String, Any?> {
    val wanted = buildList {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(Manifest.permission.BLUETOOTH_CONNECT)
    }.filterNot { granted(it, 0) }
    val permissions = legacyAppContextOrNull?.permissions
    if (wanted.isNotEmpty() && permissions != null) {
      suspendCancellableCoroutine<Unit> { continuation ->
        try {
          permissions.askForPermissions(
            PermissionsResponseListener { _ -> if (continuation.isActive) continuation.resume(Unit) },
            *wanted.toTypedArray(),
          )
        } catch (_: Throwable) {
          if (continuation.isActive) continuation.resume(Unit)
        }
      }
    }
    return mapOf(
      "notifications" to granted(Manifest.permission.POST_NOTIFICATIONS, Build.VERSION_CODES.TIRAMISU),
      "bluetooth" to granted(Manifest.permission.BLUETOOTH_CONNECT, Build.VERSION_CODES.S),
    )
  }

  /** Starts the foreground service (app must be in the foreground) and waits for `startForeground`. */
  @JS
  suspend fun startServer(status: Map<String, Any?>) {
    val ctx = androidContext
    PocketServerBus.status = PocketServerStatus.from(status)
    PocketServerNetworks.trackPrimary(ctx)
    if (PocketServerBus.running) {
      PocketServerService.update(ctx)
      return
    }
    val error = withTimeoutOrNull(5_000) {
      suspendCancellableCoroutine<Throwable?> { continuation ->
        PocketServerBus.onForeground = { e -> if (continuation.isActive) continuation.resume(e) }
        try {
          PocketServerService.start(ctx)
        } catch (e: Throwable) {
          PocketServerBus.onForeground = null
          if (continuation.isActive) continuation.resume(e)
        }
      }
    }
    PocketServerBus.onForeground = null
    if (error != null || !PocketServerBus.running) {
      PocketServerNetworks.untrackPrimary(ctx)
      val why = error?.let { "${it.javaClass.simpleName}: ${it.message}" } ?: "the service did not start in time"
      throw ServerStartException("Android did not start the server ($why)")
    }
  }

  @JS
  fun updateServer(status: Map<String, Any?>) {
    PocketServerBus.status = PocketServerStatus.from(status)
    PocketServerService.update(androidContext)
  }

  @JS
  suspend fun stopServer() {
    val ctx = androidContext
    PocketServerNetworks.untrackPrimary(ctx)
    if (!PocketServerBus.running) return
    PocketServerService.stop(ctx)
  }

  @JS
  fun isServing(): Boolean = PocketServerBus.running

  // ─── networks ───

  @JS
  suspend fun joinLocalOnly(ssid: String, password: String, options: Map<String, Any?>): Map<String, Any?> {
    val timeoutMs = ((options["timeoutMs"] as? Number)?.toDouble() ?: 30_000.0).toInt().coerceIn(1_000, 120_000)
    return PocketServerNetworks.joinLocalOnly(androidContext, ssid, password, timeoutMs).toMap()
  }

  @JS
  suspend fun leaveLocalOnly(): Unit = withContext(Dispatchers.Main) { PocketServerNetworks.releaseLocalOnly(androidContext) }

  @JS
  suspend fun localOnlyAddress(): String? = withContext(Dispatchers.IO) { PocketServerNetworks.localOnlyAddress(androidContext) }

  @JS
  suspend fun primaryWifi(): Map<String, Any?>? = withContext(Dispatchers.IO) { PocketServerNetworks.primaryInfo(androidContext) }

  /** Hosts answering `port` on the phone's Wi-Fi / hotspot subnets (camera discovery). */
  @JS
  suspend fun findCameraHosts(options: Map<String, Any?>): List<String> = withContext(Dispatchers.IO) {
    val port = (options["port"] as? Number)?.toInt() ?: 7001
    val timeoutMs = (options["timeoutMs"] as? Number)?.toInt()?.coerceIn(50, 3_000) ?: 300
    val most = (options["max"] as? Number)?.toInt()?.coerceIn(1, 32) ?: 8
    PocketServerNetworks.probeHosts(port, timeoutMs, most)
  }

  // ─── phone health ───

  @JS
  fun deviceStatus(): Map<String, Any?> {
    val ctx = androidContext
    val battery = runCatching { ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) }.getOrNull()
    val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
    val state = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
    val plugged = (battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
    val pm = ctx.getSystemService(PowerManager::class.java)
    val thermal = when (pm?.currentThermalStatus ?: PowerManager.THERMAL_STATUS_NONE) {
      PowerManager.THERMAL_STATUS_NONE -> "none"
      PowerManager.THERMAL_STATUS_LIGHT -> "light"
      PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
      PowerManager.THERMAL_STATUS_SEVERE -> "severe"
      PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
      else -> "emergency"
    }
    return mapOf(
      "batteryPercent" to if (level >= 0 && scale > 0) (level * 100.0 / scale) else null,
      "charging" to (state == BatteryManager.BATTERY_STATUS_CHARGING || state == BatteryManager.BATTERY_STATUS_FULL),
      "plugged" to plugged,
      "thermal" to thermal,
    )
  }

  override fun onDestroy() {
    if (PocketServerBus.listener === this) PocketServerBus.listener = null
  }

  // ─── PocketServerBus.Listener (tick thread / main) ───

  override fun serverTick(elapsedRealtimeMs: Long) {
    onTick.emit(mapOf("at" to elapsedRealtimeMs.toDouble()))
  }

  override fun serverAction(action: String) {
    onAction.emit(mapOf("action" to action))
  }

  override fun serverState(running: Boolean, reason: String?) {
    onServerState.emit(mapOf("running" to running, "reason" to reason))
  }

  private fun granted(permission: String, sinceSdk: Int): Boolean =
    Build.VERSION.SDK_INT < sinceSdk ||
      androidContext.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
}
