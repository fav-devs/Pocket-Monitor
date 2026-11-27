package com.favdevs.pocketnative.relay

import android.os.Build
import android.provider.Settings
import io.github.expo.modules.v2.Event
import io.github.expo.modules.v2.ExpoModule
import io.github.expo.modules.v2.JS
import io.github.expo.modules.v2.Module
import io.github.expo.modules.v2.react.androidContext
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * JS module `PocketRelay` (`src/types.ts` `PocketRelayNativeModule`): the watcher relay host
 * ([RelayHost]), browsing ([RelayBrowser]) and watcher joins ([RelayWatcher]).
 *
 * Discovered by the v2 Gradle plugin; not listed in expo-module.config.json `android.modules`.
 */
@ExpoModule("PocketRelay")
class PocketRelayModule : Module(), RelayHost.Listener, RelayBrowser.Listener, RelayWatcher.Listener {
  @Event("onHosts")
  val onHosts: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Event("onHostStatus")
  val onHostStatus: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Event("onHostCommand")
  val onHostCommand: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Event("onWatcherStatus")
  val onWatcherStatus: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Event("onWatcherMessage")
  val onWatcherMessage: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Event("onWatcherStats")
  val onWatcherStats: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Volatile private var hostInstance: RelayHost? = null
  @Volatile private var browserInstance: RelayBrowser? = null
  private val watchers = ConcurrentHashMap<String, RelayWatcher>()

  private val host: RelayHost
    get() = hostInstance ?: synchronized(this) { hostInstance ?: RelayHost(androidContext, this).also { hostInstance = it } }

  private val browser: RelayBrowser
    get() = browserInstance ?: synchronized(this) { browserInstance ?: RelayBrowser(androidContext, this).also { browserInstance = it } }

  @JS
  fun deviceName(): String {
    val name = runCatching { Settings.Global.getString(androidContext.contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
    return name?.takeIf { it.isNotBlank() } ?: Build.MODEL ?: "Android"
  }

  // ───────────────────────────── Host ─────────────────────────────

  @JS
  suspend fun startHost(options: Map<String, Any?>) {
    val o = RelayHost.Options(
      cameraSessionId = options["cameraSessionId"] as? String ?: throw IllegalArgumentException("cameraSessionId is required"),
      hostName = (options["hostName"] as? String)?.takeIf { it.isNotBlank() } ?: deviceName(),
      cameraName = options["cameraName"] as? String ?: "",
      passcode = (options["passcode"] as? String ?: "").trim(),
      allowsControl = options["allowsControl"] as? Boolean ?: false,
      window = ((options["window"] as? Number)?.toInt() ?: 2).coerceIn(1, 8),
    )
    suspendCancellableCoroutine { c ->
      host.start(o) { error -> if (error == null) c.resume(Unit) else c.resumeWithException(error) }
    }
  }

  @JS
  fun stopHost(reason: String?) {
    hostInstance?.stop(reason?.takeIf { it.isNotBlank() })
  }

  @JS
  fun updateHost(options: Map<String, Any?>) {
    hostInstance?.update(
      passcode = options["passcode"] as? String ?: "",
      allowsControl = options["allowsControl"] as? Boolean ?: false,
      window = (options["window"] as? Number)?.toInt() ?: 2,
    )
  }

  @JS
  fun publishHostState(json: String) {
    hostInstance?.publishState(json)
  }

  @JS
  fun grantControl() {
    hostInstance?.grantControl()
  }

  @JS
  fun denyControl() {
    hostInstance?.denyControl()
  }

  @JS
  fun reclaimControl() {
    hostInstance?.reclaimControl()
  }

  override fun hostStatus(status: Map<String, Any?>) {
    onHostStatus.emit(status)
  }

  override fun hostCommand(json: String, watcherId: String) {
    onHostCommand.emit(mapOf("json" to json, "watcherId" to watcherId))
  }

  // ───────────────────────────── Browse ─────────────────────────────

  @JS
  fun startBrowse() {
    browser.start()
  }

  @JS
  fun stopBrowse() {
    browserInstance?.stop()
  }

  override fun hostsChanged(hosts: List<Map<String, Any?>>, browsing: Boolean, error: String?) {
    onHosts.emit(mapOf("hosts" to hosts, "browsing" to browsing, "error" to error))
  }

  // ───────────────────────────── Watcher ─────────────────────────────

  @JS
  suspend fun join(options: Map<String, Any?>) {
    val sessionId = options["sessionId"] as? String ?: throw IllegalArgumentException("sessionId is required")
    val hostId = options["hostId"] as? String ?: throw IllegalArgumentException("hostId is required")
    val hello = options["hello"] as? String ?: throw IllegalArgumentException("hello is required")
    watchers.remove(sessionId)?.close()
    // Resolve again on every join: a restarted host can listen on a different port.
    val resolved = suspendCancellableCoroutine<RelayBrowser.Resolved?> { c -> browser.resolveId(hostId) { c.resume(it) } }
      ?: throw IllegalStateException("That feed is not on this Wi-Fi. Join the camera Wi-Fi, then choose it again.")
    val watcher = RelayWatcher(sessionId, resolved.addresses, resolved.port, hello, this)
    watchers.put(sessionId, watcher)?.close()
    watcher.start()
  }

  @JS
  fun leave(sessionId: String) {
    watchers.remove(sessionId)?.close()
  }

  @JS
  fun requestControl(sessionId: String) {
    watchers[sessionId]?.send(RelayWire.REQUEST_CONTROL, ByteArray(0))
  }

  @JS
  fun releaseControl(sessionId: String) {
    watchers[sessionId]?.send(RelayWire.RELEASE_CONTROL, ByteArray(0))
  }

  @JS
  fun sendCommand(sessionId: String, json: String) {
    watchers[sessionId]?.send(RelayWire.COMMAND, json.toByteArray(Charsets.UTF_8))
  }

  // Only the current join of a session reaches JS: a left or replaced join is silent.
  override fun watcherStatus(watcher: RelayWatcher, state: String, error: String?) {
    if (watchers[watcher.sessionId] !== watcher) return
    if (state == "closed") watchers.remove(watcher.sessionId, watcher)
    onWatcherStatus.emit(mapOf("sessionId" to watcher.sessionId, "state" to state, "error" to error))
  }

  override fun watcherMessage(watcher: RelayWatcher, kind: String, json: String) {
    if (watchers[watcher.sessionId] !== watcher) return
    onWatcherMessage.emit(mapOf("sessionId" to watcher.sessionId, "kind" to kind, "json" to json))
  }

  override fun watcherStats(watcher: RelayWatcher, stats: Map<String, Any?>) {
    if (watchers[watcher.sessionId] !== watcher) return
    onWatcherStats.emit(stats)
  }

  override fun onDestroy() {
    watchers.values.forEach { it.close() }
    watchers.clear()
    hostInstance?.shutdown()
    browserInstance?.shutdown()
  }
}
