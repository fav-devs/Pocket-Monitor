package com.favdevs.opcnative.datalink

import com.favdevs.opcnative.shared.OpcVideoCodec
import io.github.expo.modules.v2.Event
import io.github.expo.modules.v2.ExpoModule
import io.github.expo.modules.v2.JS
import io.github.expo.modules.v2.Module
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * JS module `OpcDatalink` (`src/types.ts` `OpcDatalinkNativeModule`).
 *
 * Event payload bytes are Kotlin `ByteArray`s, which Expo Modules v2 hands to JS as an
 * `ArrayBuffer` (iOS `Data` arrives as a `Uint8Array`). VERIFY: the JS wrapper should normalize with
 * `new Uint8Array(x)`; see modules/opc-native/README.md.
 */
@ExpoModule("OpcDatalink")
class OpcDatalinkModule : Module(), OpcDatalinkSession.Listener {
  private val sessions = ConcurrentHashMap<String, OpcDatalinkSession>()
  private val pendingVideo = ConcurrentHashMap<String, OpcVideoCodec>()

  @Event("onDuml")
  val onDuml: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Event("onState")
  val onState: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @Event("onStats")
  val onStats: io.github.expo.modules.v2.events.Event<Map<String, Any?>> = event()

  @JS("open")
  suspend fun openSession(sessionId: String, options: Map<String, Any?>) {
    sessions.remove(sessionId)?.let { old -> withContext(Dispatchers.IO) { old.close() } }
    @Suppress("UNCHECKED_CAST")
    val poke = options["tcpPoke"] as? Map<String, Any?>
    val session = OpcDatalinkSession(
      id = sessionId,
      host = options["host"] as? String ?: "192.168.2.1",
      port = (options["port"] as? Number)?.toInt() ?: 9004,
      localPort = (options["localPort"] as? Number)?.toInt() ?: 0,
      ackHz = (options["ackHz"] as? Number)?.toDouble() ?: 40.0,
      tcpPokePort = (poke?.get("port") as? Number)?.toInt(),
      tcpPokeBytes = bytesOf(poke?.get("bytes")),
      listener = this,
    )
    sessions[sessionId] = session
    pendingVideo.remove(sessionId)?.let(session::attachVideo)
    try {
      withContext(Dispatchers.IO) { session.open() }
    } catch (error: Throwable) {
      sessions.remove(sessionId, session)
      onState.emit(mapOf("sessionId" to sessionId, "state" to "failed", "error" to (error.message ?: "open failed")))
      withContext(Dispatchers.IO) { session.close() }
      throw error
    }
  }

  @JS("close")
  suspend fun closeSession(sessionId: String) {
    pendingVideo.remove(sessionId)
    val session = sessions.remove(sessionId) ?: return
    withContext(Dispatchers.IO) { session.close() }
  }

  @JS
  fun sendDuml(sessionId: String, bytes: ByteArray) {
    sessions[sessionId]?.sendDuml(bytes)
  }

  @JS
  fun sendRaw(sessionId: String, bytes: ByteArray) {
    sessions[sessionId]?.sendRaw(bytes)
  }

  @JS
  fun attachVideo(sessionId: String, codec: String) {
    val c = if (codec == "avc") OpcVideoCodec.AVC else OpcVideoCodec.HEVC
    val session = sessions[sessionId]
    if (session != null) session.attachVideo(c) else pendingVideo[sessionId] = c
  }

  @JS
  fun detachVideo(sessionId: String) {
    pendingVideo.remove(sessionId)
    sessions[sessionId]?.detachVideo()
  }

  override fun onDestroy() {
    val all = sessions.values.toList()
    sessions.clear()
    pendingVideo.clear()
    Thread({ all.forEach { runCatching { it.close() } } }, "opc.datalink.teardown").start()
  }

  // MARK: - OpcDatalinkSession.Listener (datalink threads)

  override fun datalinkDuml(sessionId: String, bytes: ByteArray) {
    onDuml.emit(mapOf("sessionId" to sessionId, "bytes" to bytes))
  }

  override fun datalinkState(sessionId: String, state: String, error: String?) {
    onState.emit(mapOf("sessionId" to sessionId, "state" to state, "error" to error))
  }

  override fun datalinkStats(sessionId: String, stats: Map<String, Any?>) {
    onStats.emit(stats)
  }

  internal companion object {
    /**
     * Bytes from a JS value that crossed as `Any?`: `ArrayBuffer` → ByteArray, `number[]` → List,
     * and a `Uint8Array` inside a dynamic map arrives as an index-keyed map ("0", "1", …).
     */
    fun bytesOf(value: Any?): ByteArray? = when (value) {
      null -> null
      is ByteArray -> value
      is List<*> -> ByteArray(value.size) { ((value[it] as? Number)?.toInt() ?: 0).toByte() }
      is Map<*, *> -> {
        val out = ByteArray(value.size)
        for ((key, item) in value) {
          val index = (key as? String)?.toIntOrNull() ?: continue
          if (index in out.indices) out[index] = ((item as? Number)?.toInt() ?: 0).toByte()
        }
        out
      }
      else -> null
    }
  }
}
