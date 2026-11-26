package com.favdevs.pocketnative.datalink

import com.favdevs.pocketnative.shared.PocketVideoCodec
import java.io.ByteArrayOutputStream

/**
 * Port of `Sources/OpenPocketViewCore/HevcDepacketizer.swift`: sized mode (DJI `00 00 01 ff`
 * marker + 16-byte header with the LE encoded length, transport seq continuity +8) and the legacy
 * frame-number / fragment-position fallback. Not thread-safe; owned by the receive thread.
 */
internal class VideoDepacketizer {
  private var sizedMode = false
  private var expectedSize: Int? = null
  private val sized = GrowableBytes()
  private var lastSizedSequence: Int? = null
  private var currentFrame: Int? = null
  private val buffer = GrowableBytes()
  private var lastPosition: Int? = null
  private var corrupt = false
  var droppedIncomplete = 0
    private set

  /** [p] holds one datagram in `p[0 until length]`. Returns a finished access unit, if any. */
  fun feed(p: ByteArray, length: Int): ByteArray? {
    if (length <= 20 || DumlWire.u8(p, 6) != 0x02) return null
    val bodyLen = length - 20
    val marker = bodyLen >= 4 && p[20].toInt() == 0 && p[21].toInt() == 0 && p[22].toInt() == 1 &&
      DumlWire.u8(p, 23) == 0xFF
    val declared = declaredSize(p, length)
    val nonzeroDeclaration = marker && bodyLen >= 16 && (24 until 28).any { p[it].toInt() != 0 }
    if (sizedMode || nonzeroDeclaration) {
      if (!sizedMode) {
        sizedMode = true
        buffer.clear()
      }
      return feedSized(p, length, marker, declared)
    }
    val frameNo = DumlWire.u8(p, 16)
    val position = DumlWire.u8(p, 18) * 2 + (DumlWire.u8(p, 17) shr 7)

    var completed: ByteArray? = null
    val cur = currentFrame
    if (cur != null && cur != frameNo) {
      if (buffer.size > 0) {
        if (corrupt) droppedIncomplete += 1 else completed = AnnexB.stripDjiMarker(buffer.toByteArray())
      }
      buffer.clear()
      corrupt = false
      lastPosition = null
    }
    currentFrame = frameNo
    val last = lastPosition
    if (last != null) {
      if (position == last) return completed // UDP duplicate
      if (position < last) {
        if (buffer.size > 0) {
          if (corrupt) droppedIncomplete += 1 else completed = AnnexB.stripDjiMarker(buffer.toByteArray())
        }
        buffer.clear()
        corrupt = false
      } else if (position != last + 1) {
        corrupt = true
      }
    }
    lastPosition = position
    if (bodyLen <= MAX_ENCODED_BYTES + 16 - buffer.size) buffer.append(p, 20, bodyLen) else corrupt = true
    return completed
  }

  private fun declaredSize(p: ByteArray, length: Int): Int? {
    if (length - 20 < 16) return null
    if (p[20].toInt() != 0 || p[21].toInt() != 0 || p[22].toInt() != 1 || DumlWire.u8(p, 23) != 0xFF) return null
    val count = DumlWire.u8(p, 24).toLong() or (DumlWire.u8(p, 25).toLong() shl 8) or
      (DumlWire.u8(p, 26).toLong() shl 16) or (DumlWire.u8(p, 27).toLong() shl 24)
    if (count <= 0 || count > MAX_ENCODED_BYTES) return null
    return count.toInt() + 16
  }

  private fun feedSized(p: ByteArray, length: Int, marker: Boolean, declared: Int?): ByteArray? {
    val sequence = DumlWire.u16(p, 4)
    if (sequence == lastSizedSequence) return null
    if (marker) {
      if (expectedSize != null) droppedIncomplete += 1
      sized.clear()
      expectedSize = declared
      lastSizedSequence = null
    }
    val expected = expectedSize ?: return null
    val last = lastSizedSequence
    if (last != null && sequence != ((last + 8) and 0xFFFF)) {
      droppedIncomplete += 1
      expectedSize = null
      sized.clear()
      lastSizedSequence = sequence
      return null
    }
    lastSizedSequence = sequence
    val bodyLen = length - 20
    if (bodyLen > expected - sized.size) {
      droppedIncomplete += 1
      expectedSize = null
      sized.clear()
      return null
    }
    sized.append(p, 20, bodyLen)
    if (sized.size != expected) return null
    val accessUnit = sized.copyRange(16, sized.size)
    sized.clear()
    expectedSize = null
    return accessUnit
  }

  fun reset() {
    sizedMode = false
    expectedSize = null
    sized.clear()
    lastSizedSequence = null
    currentFrame = null
    buffer.clear()
    lastPosition = null
    corrupt = false
    droppedIncomplete = 0
  }

  private companion object {
    const val MAX_ENCODED_BYTES = 4 * 1024 * 1024
  }
}

/** A reusable byte buffer (ByteArrayOutputStream exposes no range copy). */
internal class GrowableBytes {
  private var data = ByteArray(64 * 1024)
  var size = 0
    private set

  fun append(src: ByteArray, offset: Int, count: Int) {
    if (size + count > data.size) data = data.copyOf(maxOf(data.size * 2, size + count))
    System.arraycopy(src, offset, data, size, count)
    size += count
  }

  fun clear() {
    size = 0
  }

  fun toByteArray(): ByteArray = data.copyOf(size)

  fun copyRange(from: Int, to: Int): ByteArray = data.copyOfRange(from, to)
}

/** Annex-B helpers (ports of `Hevc` / `Avc` / `LiveVideo` classification in the core). */
internal object AnnexB {
  fun hevcNalType(b: Int): Int = (b shr 1) and 0x3F
  fun avcNalType(b: Int): Int = b and 0x1F

  /** Drop DJI's `00 00 01 ff …` marker (HEVC NAL type 63): return from the first standard NAL. */
  fun stripDjiMarker(b: ByteArray): ByteArray {
    var i = 0
    while (i + 4 <= b.size) {
      if (b[i].toInt() == 0 && b[i + 1].toInt() == 0 && b[i + 2].toInt() == 1) {
        if (hevcNalType(b[i + 3].toInt() and 0xFF) != 63) return b.copyOfRange(i, b.size)
        i += 3
      } else {
        i += 1
      }
    }
    return b
  }

  /** Nano private AVC SEI: `06 F0 19` + 25 raw bytes + `80`, start code at [i]. */
  private fun isNanoPrivateSei(b: ByteArray, i: Int): Boolean =
    i + 32 <= b.size && b[i + 3].toInt() == 6 && (b[i + 4].toInt() and 0xFF) == 0xF0 &&
      b[i + 5].toInt() == 25 && (b[i + 31].toInt() and 0xFF) == 0x80

  /** First byte of every NAL, skipping the Nano private SEI contents by length. */
  fun nalHeaders(b: ByteArray): IntArray {
    val out = ArrayList<Int>(8)
    var i = 0
    while (i + 3 < b.size) {
      if (b[i].toInt() == 0 && b[i + 1].toInt() == 0 && b[i + 2].toInt() == 1) {
        if (isNanoPrivateSei(b, i)) {
          i += 32
          continue
        }
        out.add(b[i + 3].toInt() and 0xFF)
        i += 3
      } else {
        i += 1
      }
    }
    return out.toIntArray()
  }

  /**
   * Removes the Nano private SEI NAL (start code included): its raw payload can contain `00 00 01`,
   * which a decoder would split into fake slices (docs/live-session.md, Nano transport assembly).
   */
  fun removeNanoPrivateSei(b: ByteArray): ByteArray {
    var out: ByteArrayOutputStream? = null
    var cursor = 0
    var i = 0
    while (i + 3 < b.size) {
      if (b[i].toInt() == 0 && b[i + 1].toInt() == 0 && b[i + 2].toInt() == 1) {
        if (isNanoPrivateSei(b, i)) {
          val start = if (i > 0 && b[i - 1].toInt() == 0) i - 1 else i
          val o = out ?: ByteArrayOutputStream(b.size).also { out = it }
          o.write(b, cursor, start - cursor)
          cursor = i + 32
          i += 32
          continue
        }
        i += 3
      } else {
        i += 1
      }
    }
    val o = out ?: return b
    o.write(b, cursor, b.size - cursor)
    return o.toByteArray()
  }

  /** HEVC 0x40/0x42/0x44, AVC 0x67/0x68. Never `b and 0x1f` (HEVC IDR_N_LP 0x28 is AVC PPS). */
  fun detectCodec(headers: IntArray): PocketVideoCodec? {
    for (h in headers) {
      when (h) {
        0x40, 0x42, 0x44 -> return PocketVideoCodec.HEVC
        0x67, 0x68 -> return PocketVideoCodec.AVC
      }
    }
    return null
  }

  fun hasRandomAccess(headers: IntArray, codec: PocketVideoCodec): Boolean = headers.any { h ->
    if (codec == PocketVideoCodec.AVC) avcNalType(h) == 5 else hevcNalType(h) in 16..21
  }

  fun carriesKeyframe(headers: IntArray, codec: PocketVideoCodec): Boolean = headers.any { h ->
    if (codec == PocketVideoCodec.AVC) {
      avcNalType(h).let { it == 7 || it == 8 || it == 5 }
    } else {
      hevcNalType(h).let { it == 32 || it == 33 || it == 34 || it in 16..21 }
    }
  }
}

/**
 * Depacketizer + the random-access gate of upstream `SoftAPVideoAssembler`: after a lost fragment,
 * dependants are dropped until an AU carrying a keyframe NAL. Codec latches from parameter sets.
 */
internal class VideoAssembler {
  private val depacketizer = VideoDepacketizer()
  private var incompleteSeen = 0
  private var awaitingRandomAccess = false
  var codec: PocketVideoCodec? = null
    private set

  fun ingest(d: ByteArray, length: Int, hint: PocketVideoCodec): Pair<ByteArray, PocketVideoCodec>? {
    val completed = depacketizer.feed(d, length)
    if (depacketizer.droppedIncomplete > incompleteSeen) {
      incompleteSeen = depacketizer.droppedIncomplete
      awaitingRandomAccess = true
    }
    if (completed == null || completed.isEmpty()) return null
    val au = AnnexB.removeNanoPrivateSei(completed)
    val headers = AnnexB.nalHeaders(au)
    if (codec == null) codec = AnnexB.detectCodec(headers)
    val c = codec ?: hint
    if (AnnexB.hasRandomAccess(headers, c)) awaitingRandomAccess = false
    if (awaitingRandomAccess && !AnnexB.carriesKeyframe(headers, c)) return null
    return au to c
  }

  fun reset() {
    depacketizer.reset()
    incompleteSeen = 0
    awaitingRandomAccess = false
    codec = null
  }
}
