package com.favdevs.opcnative.bluetooth

import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.v2.legacyAppContextOrNull
import io.github.expo.modules.v2.Event
import io.github.expo.modules.v2.ExpoModule
import io.github.expo.modules.v2.JS
import io.github.expo.modules.v2.Module
import io.github.expo.modules.v2.react.androidContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * JS module `OpcBluetooth` (`src/types.ts` `OpcBluetoothNativeModule`).
 *
 * Android 12+: BLUETOOTH_SCAN (neverForLocation) + BLUETOOTH_CONNECT, requested at runtime by
 * [requestPermissions] through Expo's permissions service. Android ≤ 11 needs
 * ACCESS_FINE_LOCATION, which this library's manifest does not declare (the app must).
 *
 * Peripheral ids are MAC addresses. Event payload bytes are `ByteArray`s, which reach JS as an
 * `ArrayBuffer` (VERIFY: normalize with `new Uint8Array(x)` in the JS wrapper).
 */
@ExpoModule("OpcBluetooth")
class OpcBluetoothModule : Module(), OpcBleCentral.Listener {
  @Event("onPowerState")
  val onPowerState: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Event("onAdvert")
  val onAdvert: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Event("onConnection")
  val onConnection: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Event("onNotify")
  val onNotify: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Volatile
  private var created: OpcBleCentral? = null

  private val central: OpcBleCentral
    get() = created ?: synchronized(this) {
      created ?: OpcBleCentral(androidContext, this).also { created = it }
    }

  @JS
  fun getPowerState(): String = central.powerState()

  @JS
  suspend fun requestPermissions(): Boolean {
    val c = central
    if (c.hasPermissions()) return true
    val permissions = legacyAppContextOrNull?.permissions ?: return false
    val wanted = c.requiredPermissions()
    return suspendCancellableCoroutine<Boolean> { continuation ->
      try {
        permissions.askForPermissions(
          PermissionsResponseListener { result ->
            val granted = wanted.all { result[it]?.status == PermissionsStatus.GRANTED }
            if (continuation.isActive) continuation.resume(granted)
          },
          *wanted,
        )
      } catch (error: Throwable) {
        if (continuation.isActive) continuation.resume(false)
      }
    }
  }

  @JS
  fun startScan(serviceUuids: List<String>?) {
    central.startScan(serviceUuids)
  }

  @JS
  fun stopScan() {
    created?.stopScan()
  }

  @JS
  suspend fun connect(id: String, options: Map<String, Any?>) {
    val service = options["service"] as? String ?: throw OpcBleCentral.BleException("ERR_BLE_ARGS", "service missing")
    val write = options["writeCharacteristic"] as? String
      ?: throw OpcBleCentral.BleException("ERR_BLE_ARGS", "writeCharacteristic missing")
    val notify = (options["notifyCharacteristics"] as? List<*>)?.filterIsInstance<String>().orEmpty()
    val arm = options["armPairing"] as? Boolean ?: true
    val c = central
    suspendCancellableCoroutine<Unit> { continuation ->
      c.connect(id, service, write, notify, arm) { error ->
        if (!continuation.isActive) return@connect
        if (error != null) continuation.resumeWithException(error) else continuation.resume(Unit)
      }
    }
  }

  @JS
  suspend fun disconnect(id: String) {
    val c = created ?: return
    suspendCancellableCoroutine<Unit> { continuation ->
      c.disconnect(id) { if (continuation.isActive) continuation.resume(Unit) }
    }
  }

  @JS
  suspend fun write(id: String, bytes: ByteArray, withResponse: Boolean) {
    val c = created ?: throw OpcBleCentral.BleException("ERR_BLE_NOT_CONNECTED", "not connected")
    suspendCancellableCoroutine<Unit> { continuation ->
      c.write(id, bytes, withResponse) { error ->
        if (!continuation.isActive) return@write
        if (error != null) continuation.resumeWithException(error) else continuation.resume(Unit)
      }
    }
  }

  override fun onDestroy() {
    created?.destroy()
    created = null
  }

  // MARK: - OpcBleCentral.Listener (BLE thread / binder)

  override fun blePowerState(state: String) {
    onPowerState.emit(mapOf("state" to state))
  }

  override fun bleAdvert(advert: Map<String, Any?>) {
    onAdvert.emit(advert)
  }

  override fun bleConnection(id: String, state: String, error: String?) {
    onConnection.emit(mapOf("id" to id, "state" to state, "error" to error))
  }

  override fun bleNotify(id: String, characteristic: String, bytes: ByteArray) {
    onNotify.emit(mapOf("id" to id, "characteristic" to characteristic, "bytes" to bytes))
  }
}
