package com.favdevs.pocketnative.shared

import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

enum class PocketVideoCodec { HEVC, AVC }

/** Where the datalink hands complete video access units; Video (consumer) registers here. */
interface PocketVideoSink {
  /** One Annex-B access unit. Called on the datalink receive thread; must not block. */
  fun receive(accessUnit: ByteArray, codec: PocketVideoCodec, presentationTimeUs: Long)
  /** Stream lost or reset: drop decoder state and wait for a keyframe. */
  fun reset()
}

object PocketVideoSinkRegistry {
  private val sinks = ConcurrentHashMap<String, CopyOnWriteArrayList<WeakReference<PocketVideoSink>>>()

  fun add(sessionId: String, sink: PocketVideoSink) {
    val list = sinks.getOrPut(sessionId) { CopyOnWriteArrayList() }
    list.removeAll { it.get() == null }
    if (list.none { it.get() === sink }) list.add(WeakReference(sink))
  }

  fun remove(sessionId: String, sink: PocketVideoSink) {
    sinks[sessionId]?.removeAll { it.get() == null || it.get() === sink }
  }

  /** Every consumer of [sessionId]: its decoders, then its taps. */
  fun sinks(sessionId: String): List<PocketVideoSink> =
    (sinks[sessionId]?.mapNotNull { it.get() } ?: emptyList()) + (taps[sessionId]?.mapNotNull { it.get() } ?: emptyList())

  // Taps (additive): a second consumer of a session's access units that is not a decoder. The
  // watcher relay host forwards the camera's encoded AUs to watchers from here, so frames never
  // cross JS. Held weakly like sinks; the datalink reaches them through [sinks] unchanged.

  private val taps = ConcurrentHashMap<String, CopyOnWriteArrayList<WeakReference<PocketVideoSink>>>()

  fun addTap(sessionId: String, tap: PocketVideoSink) {
    val list = taps.getOrPut(sessionId) { CopyOnWriteArrayList() }
    list.removeAll { it.get() == null }
    if (list.none { it.get() === tap }) list.add(WeakReference(tap))
  }

  fun removeTap(sessionId: String, tap: PocketVideoSink) {
    taps[sessionId]?.removeAll { it.get() == null || it.get() === tap }
  }

  /** Producer side for sources other than the datalink (the relay watcher), on the caller's thread. */
  fun publish(sessionId: String, accessUnit: ByteArray, codec: PocketVideoCodec, presentationTimeUs: Long) {
    for (sink in sinks(sessionId)) runCatching { sink.receive(accessUnit, codec, presentationTimeUs) }
  }

  /** Producer side: the stream restarted (flush references, wait for a keyframe). */
  fun reset(sessionId: String) {
    for (sink in sinks(sessionId)) runCatching { sink.reset() }
  }
}
