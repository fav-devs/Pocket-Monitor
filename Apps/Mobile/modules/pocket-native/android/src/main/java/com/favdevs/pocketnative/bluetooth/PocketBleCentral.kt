package com.favdevs.pocketnative.bluetooth

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Log
import java.util.Locale
import java.util.UUID

/**
 * BLE side of the connection spine, ported from upstream `BleLink.kt` (Android/dji).
 *
 * Every GATT call and all link state run on one HandlerThread (`pocket.ble`); binder callbacks copy
 * their values and post there. Android GATT runs one request at a time, so CCCD writes, the
 * pairing arm and every characteristic write go through a per-link operation queue.
 *
 * Connect: `connectGatt(TRANSPORT_LE)` → `requestMtu(512)` (discover from `onMtuChanged`, with a
 * 1.5 s fallback: discovery issued during the MTU exchange was dropped on a Xiaomi / Android 12
 * phone) → services → notify + CCCD per characteristic → DJI pairing arm `[01 00]` (with
 * response) on the first notify characteristic → connected. 10 s deadline.
 */
@SuppressLint("MissingPermission")
internal class PocketBleCentral(context: Context, private val listener: Listener) {
  interface Listener {
    fun blePowerState(state: String)
    fun bleAdvert(advert: Map<String, Any?>)
    fun bleConnection(id: String, state: String, error: String?)
    fun bleNotify(id: String, characteristic: String, bytes: ByteArray)
  }

  class BleException(val code: String, message: String) : Exception(message)

  private val appContext = context.applicationContext
  private val manager = appContext.getSystemService(BluetoothManager::class.java)
  private val adapter: BluetoothAdapter? get() = manager?.adapter
  private val thread = HandlerThread("pocket.ble").also { it.start() }
  private val handler = Handler(thread.looper)

  private var scanCallback: ScanCallback? = null
  private val lastAdvert = HashMap<String, Triple<String?, ByteArray?, Long>>()
  private val links = HashMap<String, Link>()
  private var receiverRegistered = false

  private val powerReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
      val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
      listener.blePowerState(powerName(state))
      if (state != BluetoothAdapter.STATE_ON) {
        handler.post {
          for (link in links.values.toList()) fail(link, BleException("ERR_BLE_POWER", "Bluetooth turned off"))
        }
      }
    }
  }

  init {
    val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
    runCatching {
      if (Build.VERSION.SDK_INT >= 33) {
        appContext.registerReceiver(powerReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        appContext.registerReceiver(powerReceiver, filter)
      }
      receiverRegistered = true
    }
  }

  // MARK: - Power / permission

  fun requiredPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    } else {
      arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

  fun hasPermissions(): Boolean = requiredPermissions().all {
    appContext.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
  }

  fun powerState(): String {
    val a = adapter ?: return "unsupported"
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
      appContext.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED
    ) {
      return "unauthorized"
    }
    return powerName(a.state)
  }

  private fun powerName(state: Int): String = when (state) {
    BluetoothAdapter.STATE_ON -> "on"
    BluetoothAdapter.STATE_OFF -> "off"
    BluetoothAdapter.STATE_TURNING_ON, BluetoothAdapter.STATE_TURNING_OFF -> "resetting"
    else -> "unknown"
  }

  // MARK: - Scan

  fun startScan(serviceUuids: List<String>?) {
    handler.post {
      stopScanLocked()
      val scanner = adapter?.takeIf { it.isEnabled }?.bluetoothLeScanner ?: run {
        Log.w(TAG, "ble: scan skipped, adapter off")
        return@post
      }
      if (!hasPermissions()) {
        Log.w(TAG, "ble: scan skipped, permission missing")
        return@post
      }
      lastAdvert.clear()
      val filters = serviceUuids
        ?.mapNotNull { runCatching { parseUuid(it) }.getOrNull() }
        ?.takeIf { it.isNotEmpty() }
        ?.map { ScanFilter.Builder().setServiceUuid(ParcelUuid(it)).build() }
      val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
      val cb = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
          handler.post { onAdvert(result) }
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
          val copy = results.toList()
          handler.post { copy.forEach(::onAdvert) }
        }

        override fun onScanFailed(errorCode: Int) {
          Log.w(TAG, "ble: scan failed $errorCode")
        }
      }
      scanCallback = cb
      runCatching { scanner.startScan(filters, settings, cb) }
        .onFailure { Log.w(TAG, "ble: startScan threw ${it.javaClass.simpleName}") }
    }
  }

  fun stopScan() {
    handler.post { stopScanLocked() }
  }

  private fun stopScanLocked() {
    val cb = scanCallback ?: return
    scanCallback = null
    runCatching { adapter?.bluetoothLeScanner?.stopScan(cb) }
  }

  private fun onAdvert(result: ScanResult) {
    val id = result.device.address
    val record = result.scanRecord
    val name = record?.deviceName ?: runCatching { result.device.name }.getOrNull()
    val mfr = record?.manufacturerSpecificData?.let { data ->
      if (data.size() == 0) return@let null
      var index = 0
      for (i in 0 until data.size()) if (data.keyAt(i) in DJI_COMPANY_IDS) index = i
      val company = data.keyAt(index)
      val payload = data.valueAt(index) ?: ByteArray(0)
      byteArrayOf((company and 0xFF).toByte(), ((company shr 8) and 0xFF).toByte()) + payload
    }
    // Duplicates arrive many times a second; forward changes, else ~1 Hz per device.
    val now = SystemClock.elapsedRealtime()
    val last = lastAdvert[id]
    if (last != null && last.first == name && last.second.contentEqualsNullable(mfr) && now - last.third < 1_000) return
    lastAdvert[id] = Triple(name, mfr, now)
    listener.bleAdvert(mapOf(
      "id" to id,
      "name" to name,
      "rssi" to result.rssi,
      "manufacturerData" to mfr,
      "serviceUuids" to (record?.serviceUuids?.map { it.uuid.toString().uppercase(Locale.US) } ?: emptyList<String>()),
    ))
  }

  private fun ByteArray?.contentEqualsNullable(other: ByteArray?): Boolean =
    if (this == null) other == null else other != null && this.contentEquals(other)

  // MARK: - Connect

  private sealed class Op {
    class EnableNotify(val ch: BluetoothGattCharacteristic) : Op()
    class Arm(val ch: BluetoothGattCharacteristic) : Op()
    object Ready : Op()
    class Write(val bytes: ByteArray, val withResponse: Boolean, val done: (Throwable?) -> Unit) : Op()
  }

  private inner class Link(
    val id: String,
    val service: UUID,
    val writeUuid: UUID,
    val notifyUuids: List<UUID>,
    val armPairing: Boolean,
  ) {
    var gatt: BluetoothGatt? = null
    var writeChar: BluetoothGattCharacteristic? = null
    var connectDone: ((Throwable?) -> Unit)? = null
    var ready = false
    var discoveryStarted = false
    val ops = ArrayDeque<Op>()
    var inFlight: Op? = null
    var inFlightToken = 0L
    var noResponseIssuedAt = 0L
    var noResponseCallback = false
    val disconnectWaiters = ArrayList<() -> Unit>()
  }

  fun connect(
    id: String, service: String, write: String, notify: List<String>, armPairing: Boolean,
    done: (Throwable?) -> Unit,
  ) {
    handler.post {
      val a = adapter
      if (a == null || !a.isEnabled) return@post done(BleException("ERR_BLE_POWER", "Bluetooth is ${powerState()}"))
      if (!hasPermissions()) return@post done(BleException("ERR_BLE_PERMISSION", "Bluetooth permission missing"))
      val device: BluetoothDevice = try {
        a.getRemoteDevice(id)
      } catch (_: IllegalArgumentException) {
        return@post done(BleException("ERR_BLE_ID", "not a Bluetooth address: $id"))
      }
      links[id]?.let { old ->
        if (old.ready) return@post done(null)
        fail(old, BleException("ERR_BLE_SUPERSEDED", "superseded by a new connect"))
      }
      val link = try {
        Link(id, parseUuid(service), parseUuid(write), notify.map(::parseUuid), armPairing)
      } catch (_: IllegalArgumentException) {
        return@post done(BleException("ERR_BLE_ARGS", "malformed service or characteristic UUID"))
      }
      link.connectDone = done
      links[id] = link
      listener.bleConnection(id, "connecting", null)
      handler.postDelayed({
        if (links[id] === link && link.connectDone != null) {
          fail(link, BleException("ERR_BLE_TIMEOUT", "Bluetooth connect timed out"))
        }
      }, CONNECT_DEADLINE_MS)
      link.gatt = try {
        device.connectGatt(appContext, false, gattCallback(link), BluetoothDevice.TRANSPORT_LE)
      } catch (error: SecurityException) {
        return@post fail(link, BleException("ERR_BLE_PERMISSION", "Bluetooth permission missing"))
      }
      if (link.gatt == null) fail(link, BleException("ERR_BLE_CONNECT", "connectGatt returned null"))
    }
  }

  fun disconnect(id: String, done: () -> Unit) {
    handler.post {
      val link = links[id] ?: return@post done()
      // `fail` closes the GATT and resolves the waiter: a stack that never reports the drop
      // must not hold the caller.
      link.disconnectWaiters.add(done)
      fail(link, BleException("ERR_BLE_DISCONNECTED", "disconnected"), report = false)
      listener.bleConnection(id, "disconnected", null)
    }
  }

  private fun startDiscovery(link: Link) {
    if (link.discoveryStarted || links[link.id] !== link) return
    link.discoveryStarted = true
    val ok = runCatching { link.gatt?.discoverServices() == true }.getOrDefault(false)
    if (!ok) fail(link, BleException("ERR_BLE_DISCOVERY", "service discovery failed"))
  }

  private fun onServices(link: Link, status: Int) {
    val gatt = link.gatt ?: return
    val service = gatt.getService(link.service)
    if (status != BluetoothGatt.GATT_SUCCESS || service == null) {
      return fail(link, BleException("ERR_BLE_NO_SERVICE", "camera has no DUML service"))
    }
    link.writeChar = service.getCharacteristic(link.writeUuid)
      ?: return fail(link, BleException("ERR_BLE_NO_SERVICE", "write characteristic missing"))
    var armChar: BluetoothGattCharacteristic? = null
    for ((index, uuid) in link.notifyUuids.withIndex()) {
      val ch = service.getCharacteristic(uuid) ?: continue
      link.ops.addLast(Op.EnableNotify(ch))
      if (index == 0) armChar = ch
    }
    if (link.armPairing) {
      val ch = armChar ?: return fail(
        link, BleException("ERR_BLE_NOTIFY", "notify characteristic ${link.notifyUuids.firstOrNull()} missing"))
      link.ops.addLast(Op.Arm(ch))
    }
    link.ops.addLast(Op.Ready)
    pump(link)
  }

  private fun finishConnect(link: Link) {
    link.ready = true
    val done = link.connectDone
    link.connectDone = null
    listener.bleConnection(link.id, "connected", null)
    done?.invoke(null)
  }

  /** Ends a link: rejects the connect and pending writes, closes the GATT. */
  private fun fail(link: Link, error: Throwable, report: Boolean = true) {
    val wasConnecting = link.connectDone != null
    link.connectDone?.invoke(error)
    link.connectDone = null
    (link.inFlight as? Op.Write)?.done?.invoke(error)
    link.inFlight = null
    for (op in link.ops) (op as? Op.Write)?.done?.invoke(error)
    link.ops.clear()
    link.ready = false
    if (links[link.id] === link) links.remove(link.id)
    link.gatt?.let { g ->
      runCatching { g.disconnect() }
      runCatching { g.close() }
    }
    link.gatt = null
    if (report) listener.bleConnection(link.id, if (wasConnecting) "failed" else "disconnected", error.message)
    link.disconnectWaiters.forEach { it() }
    link.disconnectWaiters.clear()
  }

  // MARK: - Operation queue (handler thread)

  fun write(id: String, bytes: ByteArray, withResponse: Boolean, done: (Throwable?) -> Unit) {
    val copy = bytes.copyOf()
    handler.post {
      val link = links[id]
      if (link == null || !link.ready || link.writeChar == null) {
        return@post done(BleException("ERR_BLE_NOT_CONNECTED", "not connected"))
      }
      link.ops.addLast(Op.Write(copy, withResponse, done))
      pump(link)
    }
  }

  private fun pump(link: Link) {
    if (link.inFlight != null || links[link.id] !== link) return
    val op = link.ops.removeFirstOrNull() ?: return
    val gatt = link.gatt ?: return
    link.inFlight = op
    val token = ++link.inFlightToken
    handler.postDelayed({
      if (link.inFlight === op && link.inFlightToken == token) {
        Log.w(TAG, "ble: GATT operation timed out")
        completeOp(link, op, BleException("ERR_BLE_TIMEOUT", "GATT operation timed out"))
      }
    }, OP_TIMEOUT_MS)
    when (op) {
      is Op.EnableNotify -> {
        val local = runCatching { gatt.setCharacteristicNotification(op.ch, true) }.getOrDefault(false)
        val cccd = op.ch.getDescriptor(CCCD)
        if (!local || cccd == null) {
          // Missing CCCD: Osmosis skips it; requiring it hung "Connecting (Bluetooth)…".
          return completeOp(link, op, null)
        }
        val value =
          if ((op.ch.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) {
            BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
          } else {
            BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
          }
        val issued = runCatching {
          if (Build.VERSION.SDK_INT >= 33) {
            gatt.writeDescriptor(cccd, value) == BluetoothGatt.GATT_SUCCESS
          } else {
            @Suppress("DEPRECATION")
            cccd.value = value
            @Suppress("DEPRECATION")
            gatt.writeDescriptor(cccd)
          }
        }.getOrDefault(false)
        if (!issued) completeOp(link, op, null)
      }
      is Op.Arm -> {
        if (!writeCharacteristic(gatt, op.ch, byteArrayOf(0x01, 0x00), BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT)) {
          completeOp(link, op, BleException("ERR_BLE_ARM", "pairing arm write failed"))
        }
      }
      Op.Ready -> {
        finishConnect(link)
        completeOp(link, op, null)
      }
      is Op.Write -> {
        val ch = link.writeChar ?: return completeOp(link, op, BleException("ERR_BLE_NOT_CONNECTED", "not connected"))
        val type =
          if (op.withResponse) BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
          else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        if (!writeCharacteristic(gatt, ch, op.bytes, type)) {
          return completeOp(link, op, BleException("ERR_BLE_WRITE", "write was not accepted"))
        }
        if (!op.withResponse) {
          // Back-to-back writes to fff5 drop: pace 120 ms. Resolve once the stack took it.
          link.noResponseIssuedAt = SystemClock.elapsedRealtime()
          link.noResponseCallback = false
          op.done(null)
          handler.postDelayed({ finishNoResponse(link, op, token) }, PACING_MS)
        }
      }
    }
  }

  private fun finishNoResponse(link: Link, op: Op.Write, token: Long) {
    if (link.inFlight !== op || link.inFlightToken != token) return
    val waited = SystemClock.elapsedRealtime() - link.noResponseIssuedAt
    if (link.noResponseCallback || waited >= NO_RESPONSE_CALLBACK_CAP_MS) {
      link.inFlight = null
      pump(link)
    } else {
      handler.postDelayed({ finishNoResponse(link, op, token) }, 20)
    }
  }

  private fun writeCharacteristic(gatt: BluetoothGatt, ch: BluetoothGattCharacteristic, bytes: ByteArray, type: Int): Boolean =
    runCatching {
      if (Build.VERSION.SDK_INT >= 33) {
        gatt.writeCharacteristic(ch, bytes, type) == BluetoothGatt.GATT_SUCCESS
      } else {
        @Suppress("DEPRECATION")
        ch.writeType = type
        @Suppress("DEPRECATION")
        ch.value = bytes
        @Suppress("DEPRECATION")
        gatt.writeCharacteristic(ch)
      }
    }.getOrDefault(false)

  private fun completeOp(link: Link, op: Op, error: Throwable?) {
    if (link.inFlight !== op) return
    link.inFlight = null
    when (op) {
      is Op.Arm -> if (error != null) return fail(link, error)
      is Op.Write -> if (op.withResponse) op.done(error)
      else -> Unit
    }
    pump(link)
  }

  private fun gattCallback(link: Link) = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      handler.post {
        if (links[link.id] !== link) return@post
        if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) {
          Log.w(TAG, "ble: connection state status=$status newState=$newState")
          fail(link, BleException("ERR_BLE_DISCONNECTED", "the camera disconnected (status $status)"))
        } else if (newState == BluetoothProfile.STATE_CONNECTED) {
          val mtu = runCatching { gatt.requestMtu(512) }.getOrDefault(false)
          if (mtu) handler.postDelayed({ startDiscovery(link) }, MTU_DISCOVERY_FALLBACK_MS) else startDiscovery(link)
        }
      }
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      handler.post { startDiscovery(link) }
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      handler.post { if (links[link.id] === link) onServices(link, status) }
    }

    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      handler.post {
        val op = link.inFlight as? Op.EnableNotify ?: return@post
        if (status != BluetoothGatt.GATT_SUCCESS) Log.w(TAG, "ble: CCCD write status=$status")
        completeOp(link, op, null) // a failed CCCD must not hang the connect
      }
    }

    override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      handler.post {
        val error = if (status == BluetoothGatt.GATT_SUCCESS) null else BleException("ERR_BLE_WRITE", "write status $status")
        val op = link.inFlight
        if (op is Op.Write && !op.withResponse) {
          link.noResponseCallback = true
        } else if (op != null && (op is Op.Arm || op is Op.Write)) {
          completeOp(link, op, error)
        }
        Unit
      }
    }

    @Deprecated("Deprecated in Java")
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      @Suppress("DEPRECATION")
      val value = characteristic.value?.copyOf() ?: return
      val uuid = characteristic.uuid
      handler.post { notify(link, uuid, value) }
    }

    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
      val copy = value.copyOf()
      val uuid = characteristic.uuid
      handler.post { notify(link, uuid, copy) }
    }
  }

  private fun notify(link: Link, uuid: UUID, value: ByteArray) {
    if (links[link.id] !== link || value.isEmpty()) return
    listener.bleNotify(link.id, uuid.toString().uppercase(Locale.US), value)
  }

  fun destroy() {
    handler.post {
      stopScanLocked()
      for (link in links.values.toList()) fail(link, BleException("ERR_BLE_DESTROYED", "module destroyed"), report = false)
      if (receiverRegistered) runCatching { appContext.unregisterReceiver(powerReceiver) }
      receiverRegistered = false
      thread.quitSafely()
    }
  }

  companion object {
    private const val TAG = "PocketBluetooth"
    private const val CONNECT_DEADLINE_MS = 10_000L
    private const val MTU_DISCOVERY_FALLBACK_MS = 1_500L
    private const val OP_TIMEOUT_MS = 5_000L
    private const val PACING_MS = 120L
    private const val NO_RESPONSE_CALLBACK_CAP_MS = 400L
    private val CCCD: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    private val DJI_COMPANY_IDS = setOf(0x08AA, 0xF7AA, 0xE5C0)

    /** Accepts `FFF4`, `0000FFF4` or the full 128-bit form (Bluetooth SIG base for short ones). */
    fun parseUuid(s: String): UUID {
      val t = s.trim()
      return when (t.length) {
        4 -> UUID.fromString("0000$t-0000-1000-8000-00805f9b34fb")
        8 -> UUID.fromString("$t-0000-1000-8000-00805f9b34fb")
        else -> UUID.fromString(t)
      }
    }
  }
}
