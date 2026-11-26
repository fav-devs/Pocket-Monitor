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

  fun sinks(sessionId: String): List<PocketVideoSink> = sinks[sessionId]?.mapNotNull { it.get() } ?: emptyList()
}
