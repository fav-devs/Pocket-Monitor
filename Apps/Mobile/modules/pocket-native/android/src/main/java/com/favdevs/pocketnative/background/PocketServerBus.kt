package com.favdevs.pocketnative.background

/**
 * What the server notification shows. JS sends it (`PocketBackground.startServer` /
 * `updateServer`); the service renders it. Strings are operator copy built in JS
 * (`src/camera/server/notification.ts`), so wording lives in one place.
 */
data class PocketServerStatus(
  /** Camera name, e.g. "Pocket 3". */
  val title: String = "Server",
  /** One line: link state and watchers, e.g. "Live · 2 watchers". */
  val text: String = "",
  /** Camera link is live (Record/Stop is offered only then). */
  val live: Boolean = false,
  val recording: Boolean = false,
  /** Seconds into the take when [recording]; drives a native chronometer (no JS updates per second). */
  val recordingElapsedSec: Double? = null,
  /** Deep link the Open action and a tap on the notification use (`pocketmonitor://server`). */
  val openUrl: String? = null,
) {
  companion object {
    fun from(map: Map<String, Any?>?): PocketServerStatus {
      if (map == null) return PocketServerStatus()
      return PocketServerStatus(
        title = (map["title"] as? String)?.takeIf { it.isNotBlank() } ?: "Server",
        text = map["text"] as? String ?: "",
        live = map["live"] as? Boolean ?: false,
        recording = map["recording"] as? Boolean ?: false,
        recordingElapsedSec = (map["recordingElapsedSec"] as? Number)?.toDouble(),
        openUrl = map["openUrl"] as? String,
      )
    }
  }
}

/**
 * Process-wide link between [PocketServerService] (Android component, started by the system from
 * an Intent) and [PocketBackgroundModule] (the JS module). The service can outlive a JS reload;
 * the module re-registers as [listener] when it is created.
 */
object PocketServerBus {
  interface Listener {
    /** Native heartbeat (~10 Hz) while serving. Drives JS session timers in the background. */
    fun serverTick(elapsedRealtimeMs: Long)

    /** Notification action: `record`, `stop`, `disconnect`. */
    fun serverAction(action: String)

    /** Service started (`running`) or stopped (with a reason when the system or an error stopped it). */
    fun serverState(running: Boolean, reason: String?)
  }

  @Volatile
  var listener: Listener? = null

  /** True from `startForeground` until the service is destroyed. */
  @Volatile
  var running: Boolean = false
    internal set

  @Volatile
  var status: PocketServerStatus = PocketServerStatus()
    internal set

  /** Why the service is stopping, reported with the `running = false` state (null: JS asked). */
  @Volatile
  internal var stopReason: String? = null

  /** Set by the module while waiting for `startForeground` to land. */
  @Volatile
  internal var onForeground: ((Throwable?) -> Unit)? = null

  internal fun tick(at: Long) {
    listener?.let { runCatching { it.serverTick(at) } }
  }

  internal fun action(action: String) {
    listener?.let { runCatching { it.serverAction(action) } }
  }

  internal fun state(running: Boolean, reason: String?) {
    this.running = running
    listener?.let { runCatching { it.serverState(running, reason) } }
  }
}
