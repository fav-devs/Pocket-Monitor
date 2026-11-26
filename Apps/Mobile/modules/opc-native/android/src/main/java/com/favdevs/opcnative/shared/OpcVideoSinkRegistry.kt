package com.favdevs.opcnative.shared

import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

enum class OpcVideoCodec { HEVC, AVC }

/** Where the datalink hands complete video access units; Video (consumer) registers here. */
interface OpcVideoSink {
  /** One Annex-B access unit. Called on the datalink receive thread; must not block. */
  fun receive(accessUnit: ByteArray, codec: OpcVideoCodec, presentationTimeUs: Long)
  /** Stream lost or reset: drop decoder state and wait for a keyframe. */
  fun reset()
}

object OpcVideoSinkRegistry {
  private val sinks = ConcurrentHashMap<String, CopyOnWriteArrayList<WeakReference<OpcVideoSink>>>()

  fun add(sessionId: String, sink: OpcVideoSink) {
    val list = sinks.getOrPut(sessionId) { CopyOnWriteArrayList() }
    list.removeAll { it.get() == null }
    if (list.none { it.get() === sink }) list.add(WeakReference(sink))
  }

  fun remove(sessionId: String, sink: OpcVideoSink) {
    sinks[sessionId]?.removeAll { it.get() == null || it.get() === sink }
  }

  fun sinks(sessionId: String): List<OpcVideoSink> = sinks[sessionId]?.mapNotNull { it.get() } ?: emptyList()
}
