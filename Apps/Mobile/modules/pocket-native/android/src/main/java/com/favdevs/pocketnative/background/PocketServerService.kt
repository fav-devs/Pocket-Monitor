package com.favdevs.pocketnative.background

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.drawable.Icon
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.util.Log

/**
 * Server mode's foreground service (`foregroundServiceType="connectedDevice"`).
 *
 * Keeps the process at foreground-service priority while the phone holds a camera link and
 * relays it, with the screen off and the app in the background:
 * - Android 14+: type `connectedDevice` needs FOREGROUND_SERVICE_CONNECTED_DEVICE plus one of the
 *   type's runtime/normal prerequisites. CHANGE_WIFI_STATE / CHANGE_NETWORK_STATE (normal, always
 *   granted) satisfy it; BLUETOOTH_CONNECT is held too once the operator allowed Bluetooth.
 *   The service is only ever started from the Server screen's Start button, i.e. while the app is
 *   in the foreground (Android 12+ forbids starting it from the background).
 * - Doze: processes at foreground-service state keep network access and their wake locks
 *   (NetworkPolicyManager / PowerManager allow procState ≤ FOREGROUND_SERVICE), so the
 *   battery-optimization exemption is not requested. OEM task killers are outside that contract.
 * - Android 15's FGS timeouts apply to `dataSync` / `mediaProcessing`, not `connectedDevice`.
 *   Android 16/17 behaviour-change pages list nothing for `connectedDevice`; apps that target
 *   API 37 additionally need the ACCESS_LOCAL_NETWORK runtime permission for LAN traffic
 *   (NEARBY_DEVICES group, already granted with Bluetooth / nearby Wi-Fi).
 *
 * Held only while serving: a partial wake lock (CPU for the datalink, the 40 Hz ACK pump, the
 * relay and JS) and Wi-Fi locks (low-latency; plus high-perf below API 34 because low-latency
 * only applies while the app is foreground with the screen on — VERIFY on device with
 * `adb shell dumpsys wifi | grep -i -A4 WifiLock`).
 *
 * The heartbeat thread posts [PocketServerBus.tick] at 10 Hz on absolute deadlines. JS timers
 * stop when the Activity pauses (RN `JavaTimerManager`), so the JS session runs its watchdog,
 * keepalive and status timers off this tick while serving in the background (`src/camera/native/clock.ts`).
 * No video is decoded here: the relay forwards encoded access units natively.
 */
class PocketServerService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private val wifiLocks = mutableListOf<WifiManager.WifiLock>()
  private var ticker: HandlerThread? = null
  private var tickHandler: Handler? = null
  /** Wall-clock base of the REC chronometer, kept steady between status updates. */
  private var recordingBase: Long? = null
  private var foreground = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    ensureChannel(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> start()
      ACTION_UPDATE -> if (foreground) post()
      ACTION_RECORD -> PocketServerBus.action("record")
      ACTION_STOP_RECORD -> PocketServerBus.action("stop")
      ACTION_DISCONNECT -> PocketServerBus.action("disconnect")
      ACTION_STOP -> {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
      // Restarted by the system without our Intent (should not happen with START_NOT_STICKY):
      // the JS session that owned the link is gone, so do not pretend to serve.
      else -> if (!foreground) stopSelf()
    }
    return START_NOT_STICKY
  }

  private fun start() {
    if (!foreground) {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          startForeground(NOTIFICATION_ID, build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
          startForeground(NOTIFICATION_ID, build())
        }
      } catch (error: Throwable) {
        // ForegroundServiceStartNotAllowedException (started from the background) or a
        // SecurityException (missing FGS type permission).
        Log.w(TAG, "server: startForeground refused ${error.javaClass.simpleName}: ${error.message}")
        PocketServerBus.onForeground?.invoke(error)
        PocketServerBus.onForeground = null
        stopSelf()
        return
      }
      foreground = true
      acquireLocks()
      startTicker()
      PocketServerBus.state(true, null)
      Log.i(TAG, "server: foreground (connectedDevice), locks held")
    } else {
      post()
    }
    PocketServerBus.onForeground?.invoke(null)
    PocketServerBus.onForeground = null
  }

  override fun onDestroy() {
    stopTicker()
    releaseLocks()
    val wasForeground = foreground
    foreground = false
    recordingBase = null
    if (wasForeground) PocketServerBus.state(false, PocketServerBus.stopReason.also { PocketServerBus.stopReason = null })
    super.onDestroy()
  }

  /** Swiping the app away keeps serving (the notification is the way back); the JS runtime stays. */
  override fun onTaskRemoved(rootIntent: Intent?) {
    Log.i(TAG, "server: task removed; still serving")
    super.onTaskRemoved(rootIntent)
  }

  // ─── locks ───

  private fun acquireLocks() {
    val pm = getSystemService(PowerManager::class.java)
    wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PocketMonitor:server")?.apply {
      setReferenceCounted(false)
      acquire()
    }
    val wifi = applicationContext.getSystemService(WifiManager::class.java) ?: return
    val modes = buildList {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) add(WifiManager.WIFI_MODE_FULL_LOW_LATENCY)
      @Suppress("DEPRECATION")
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) add(WifiManager.WIFI_MODE_FULL_HIGH_PERF)
    }
    for (mode in modes) {
      runCatching {
        wifi.createWifiLock(mode, "PocketMonitor:server:$mode").apply {
          setReferenceCounted(false)
          acquire()
        }
      }.onSuccess { wifiLocks.add(it) }
        .onFailure { Log.w(TAG, "server: Wi-Fi lock $mode failed ${it.javaClass.simpleName}") }
    }
  }

  private fun releaseLocks() {
    wakeLock?.let { if (it.isHeld) runCatching { it.release() } }
    wakeLock = null
    wifiLocks.forEach { lock -> if (lock.isHeld) runCatching { lock.release() } }
    wifiLocks.clear()
  }

  // ─── heartbeat ───

  private fun startTicker() {
    if (ticker != null) return
    val thread = HandlerThread("pocket.server.tick", Process.THREAD_PRIORITY_DEFAULT).also { it.start() }
    val handler = Handler(thread.looper)
    ticker = thread
    tickHandler = handler
    var next = SystemClock.uptimeMillis()
    val beat = object : Runnable {
      override fun run() {
        val now = SystemClock.uptimeMillis()
        PocketServerBus.tick(SystemClock.elapsedRealtime())
        next += TICK_MS
        // After a stall (debugger, deep sleep without the lock) resume from now, no burst.
        if (next <= now) next = now + TICK_MS
        handler.postAtTime(this, next)
      }
    }
    handler.post(beat)
  }

  private fun stopTicker() {
    tickHandler?.removeCallbacksAndMessages(null)
    ticker?.quitSafely()
    ticker = null
    tickHandler = null
  }

  // ─── notification ───

  private fun post() {
    runCatching { getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION_ID, build()) }
      .onFailure { Log.w(TAG, "server: notify failed ${it.javaClass.simpleName}") }
  }

  private fun build(): Notification {
    val status = PocketServerBus.status
    val builder = Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(statusIcon(this))
      .setContentTitle(status.title)
      .setContentText(status.text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setContentIntent(openIntent(status.openUrl))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    }
    val elapsed = status.recordingElapsedSec
    if (status.recording && elapsed != null) {
      val base = System.currentTimeMillis() - (elapsed * 1000).toLong()
      val kept = recordingBase
      // Keep the chronometer steady unless the camera's clock disagrees by more than 2 s.
      if (kept == null || kotlin.math.abs(kept - base) > 2_000) recordingBase = base
      builder.setSubText("REC")
        .setWhen(recordingBase!!)
        .setShowWhen(true)
        .setUsesChronometer(true)
    } else {
      recordingBase = null
      builder.setShowWhen(false).setUsesChronometer(false)
    }
    if (status.live) {
      builder.addAction(
        Notification.Action.Builder(null as Icon?, if (status.recording) "Stop" else "Record",
          serviceIntent(if (status.recording) ACTION_STOP_RECORD else ACTION_RECORD, 1)).build())
    }
    builder.addAction(Notification.Action.Builder(null as Icon?, "Disconnect", serviceIntent(ACTION_DISCONNECT, 2)).build())
    builder.addAction(Notification.Action.Builder(null as Icon?, "Open", openIntent(status.openUrl)).build())
    return builder.build()
  }

  private fun serviceIntent(action: String, code: Int): PendingIntent =
    PendingIntent.getService(
      this, code, Intent(this, PocketServerService::class.java).setAction(action),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

  private fun openIntent(url: String?): PendingIntent {
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val intent = url?.let { Intent(Intent.ACTION_VIEW, Uri.parse(it)).setPackage(packageName) }
      ?.takeIf { it.resolveActivity(packageManager) != null }
      ?: launch
      ?: Intent()
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(this, 3, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  companion object {
    private const val TAG = "PocketServer"
    const val CHANNEL_ID = "pocket.server"
    const val NOTIFICATION_ID = 0x504d
    const val TICK_MS = 100L
    const val ACTION_START = "com.favdevs.pocketnative.server.START"
    const val ACTION_UPDATE = "com.favdevs.pocketnative.server.UPDATE"
    const val ACTION_STOP = "com.favdevs.pocketnative.server.STOP"
    const val ACTION_RECORD = "com.favdevs.pocketnative.server.RECORD"
    const val ACTION_STOP_RECORD = "com.favdevs.pocketnative.server.STOP_RECORD"
    const val ACTION_DISCONNECT = "com.favdevs.pocketnative.server.DISCONNECT"

    @Volatile
    private var icon: Icon? = null

    fun ensureChannel(context: Context) {
      val nm = context.getSystemService(NotificationManager::class.java) ?: return
      if (nm.getNotificationChannel(CHANNEL_ID) != null) return
      val channel = NotificationChannel(CHANNEL_ID, "Server", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shows while this phone keeps a camera connected for watchers."
        setShowBadge(false)
      }
      nm.createNotificationChannel(channel)
    }

    /** Starts (or refreshes) the service. Throws when Android refuses a foreground start. */
    fun start(context: Context) {
      val intent = Intent(context, PocketServerService::class.java).setAction(ACTION_START)
      context.startForegroundService(intent)
    }

    fun update(context: Context) {
      if (!PocketServerBus.running) return
      // startService on an already-foreground service is allowed from the background.
      runCatching { context.startService(Intent(context, PocketServerService::class.java).setAction(ACTION_UPDATE)) }
        .onFailure { Log.w(TAG, "server: update refused ${it.javaClass.simpleName}") }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, PocketServerService::class.java))
    }

    /** A monochrome video-camera glyph for the status bar (the library ships no drawables). */
    private fun statusIcon(context: Context): Icon {
      icon?.let { return it }
      val size = (24 * context.resources.displayMetrics.density).toInt().coerceAtLeast(24)
      val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
      val c = Canvas(bmp)
      val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = android.graphics.Color.WHITE }
      val u = size / 24f
      c.drawRoundRect(RectF(2 * u, 6 * u, 15 * u, 18 * u), 3 * u, 3 * u, p)
      val lens = Path().apply {
        moveTo(16 * u, 10.5f * u)
        lineTo(22 * u, 7 * u)
        lineTo(22 * u, 17 * u)
        lineTo(16 * u, 13.5f * u)
        close()
      }
      c.drawPath(lens, p)
      return Icon.createWithBitmap(bmp).also { icon = it }
    }
  }
}
